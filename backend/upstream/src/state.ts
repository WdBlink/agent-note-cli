import {
  DEFAULT_SESSION_PROVIDERS,
  DEFAULT_SESSION_SCAN_ROOTS,
  DEFAULT_SETTINGS,
  ERROR_MESSAGES,
  LEGACY_SESSION_SCAN_ROOTS,
  MAX_WORK_SESSION_SNAPSHOT_SESSIONS,
  TASK_CATEGORIES,
  TASK_PRIORITIES
} from "./constants";
import { normalizeDailyReviewScheduleTime } from "./daily-review-schedule";
import type {
  AgentPlatform,
  AgentSessionStatus,
  AgentTranscriptCapture,
  AgentWorkSession,
  AgentWorkSnapshot,
  CockpitData,
  CockpitError,
  CockpitResult,
  CockpitSettings,
  DecomposedTask,
  IntentPlan,
  ModelTask,
  TaskCategory,
  TaskPriority
} from "./types";
import type { SessionProvider } from "./types";
import {
  appendProjectFrame,
  createEmptyGlobalBoardDocument,
  normalizeGlobalBoardDocument,
  WhiteboardMigrationError,
  type GlobalBoardDocument,
  type WhiteboardCommitResult
} from "./whiteboard-model";

declare module "./types" {
  interface CockpitData {
    whiteboardRevision: number;
  }
}

export type ProjectRegistrationResult =
  | { ok: true; data: CockpitData; projectId: string }
  | { ok: false; message: string };
export type ProjectRegistrationOutcome =
  | { ok: true; projectId: string }
  | { ok: false; message: string };

export type ProjectRegistrationPhase = "validating" | "queued" | "saving" | "committed";

export function registerCanonicalProject(data: CockpitData, rootPath: string, name: string): ProjectRegistrationResult {
  if (data.whiteboard.projects.some((project) => project.rootPath === rootPath)) {
    return { ok: false, message: "这个项目路径已经添加。" };
  }
  const whiteboard = appendProjectFrame(data.whiteboard, rootPath, name);
  const projectId = whiteboard.projects.at(-1)?.id;
  if (!projectId) return { ok: false, message: "无法创建项目画框。" };
  return {
    ok: true,
    projectId,
    data: normalizeData({ ...data, whiteboard, whiteboardRevision: data.whiteboardRevision + 1 })
  };
}

export interface ProjectDirectoryRuntime {
  homeDirectory: string;
  readableSearchableMode: number;
  resolve(value: string): string;
  realpath(value: string): Promise<string>;
  stat(value: string): Promise<{ isDirectory(): boolean }>;
  access(value: string, mode: number): Promise<void>;
  readdir(value: string): Promise<unknown[]>;
}

export async function resolveCanonicalProjectDirectory(
  input: string,
  runtime: ProjectDirectoryRuntime,
  signal?: AbortSignal
): Promise<string | null> {
  const value = input.trim();
  if (!value || /[\r\n\0]/.test(value) || signal?.aborted) return null;
  try {
    const expanded = value === "~" || value.startsWith("~/")
      ? `${runtime.homeDirectory}${value.slice(1)}`
      : value;
    const resolved = await runtime.realpath(runtime.resolve(expanded));
    if (signal?.aborted || !(await runtime.stat(resolved)).isDirectory()) return null;
    await runtime.access(resolved, runtime.readableSearchableMode);
    await runtime.readdir(resolved);
    return signal?.aborted ? null : resolved;
  } catch {
    return null;
  }
}

export class WhiteboardProjectRegistrationWorkflow {
  constructor(
    private readonly resolveDirectory: (input: string, signal?: AbortSignal) => Promise<string | null>,
    private readonly register: (
      rootPath: string,
      name: string,
      signal?: AbortSignal,
      onPhase?: (phase: ProjectRegistrationPhase) => void
    ) => Promise<ProjectRegistrationResult>
  ) {}

  async run(
    rootPath: string,
    name: string,
    signal?: AbortSignal,
    onPhase?: (phase: ProjectRegistrationPhase) => void
  ): Promise<ProjectRegistrationResult> {
    onPhase?.("validating");
    const resolvedRoot = await this.resolveDirectory(rootPath, signal);
    if (signal?.aborted) return { ok: false, message: "已取消添加项目。" };
    if (!resolvedRoot) return { ok: false, message: "项目路径不存在，或不是可读取的文件夹。" };
    onPhase?.("queued");
    return this.register(resolvedRoot, name, signal, onPhase);
  }
}

export class WhiteboardProjectModalSession {
  private readonly abortController = new AbortController();
  phase: ProjectRegistrationPhase | undefined;
  pending = false;
  completed = false;

  constructor(
    private readonly runRegistration: (
      rootPath: string,
      name: string,
      signal: AbortSignal,
      onPhase: (phase: ProjectRegistrationPhase) => void
    ) => Promise<ProjectRegistrationOutcome>
  ) {}

  async submit(rootPath: string, name: string): Promise<ProjectRegistrationOutcome> {
    if (this.pending) return { ok: false, message: "项目正在处理中。" };
    this.pending = true;
    const result = await this.runRegistration(rootPath, name, this.abortController.signal, (phase) => {
      this.phase = phase;
    });
    this.pending = false;
    this.completed = result.ok;
    return result;
  }

  requestClose(): { close: boolean; message?: string } {
    if (this.pending && (this.phase === "saving" || this.phase === "committed")) {
      return { close: false, message: "正在保存项目，完成后将自动关闭。" };
    }
    if (!this.completed) this.abortController.abort();
    return { close: true };
  }
}

export class SerialTransactionQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export type CockpitTransaction<T> =
  | { write: false; value: T }
  | { write: true; data: CockpitData; value: T };

export interface WhiteboardCommitListener {
  receiveWhiteboardCommit(document: GlobalBoardDocument, revision: number): void;
}

export class WhiteboardCommitChannel {
  private readonly listeners = new Set<WhiteboardCommitListener>();

  subscribe(listener: WhiteboardCommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(document: GlobalBoardDocument, revision: number, origin?: WhiteboardCommitListener): void {
    for (const listener of this.listeners) {
      if (listener !== origin) listener.receiveWhiteboardCommit(document, revision);
    }
  }
}

export class CockpitPersistenceCoordinator {
  private data: CockpitData;
  private blockedError: Error | undefined;
  private readonly queue = new SerialTransactionQueue();

  constructor(
    initialData: CockpitData,
    private readonly persist: (data: CockpitData) => Promise<void>,
    private readonly onCommit: (data: CockpitData) => void = () => undefined
  ) {
    this.data = normalizeData(initialData);
  }

  snapshot(): CockpitData {
    return this.data;
  }

  block(error: Error): void {
    this.blockedError = error;
  }

  async transact<T>(operation: (current: CockpitData) => CockpitTransaction<T> | Promise<CockpitTransaction<T>>): Promise<T> {
    return this.queue.run(async () => {
      if (this.blockedError) throw this.blockedError;
      const transaction = await operation(this.data);
      if (!transaction.write) return transaction.value;
      const next = normalizeData(transaction.data);
      await this.persist(next);
      this.commit(next);
      return transaction.value;
    });
  }

  async saveWhiteboard(
    document: GlobalBoardDocument,
    expectedRevision: number
  ): Promise<WhiteboardCommitResult> {
    return this.queue.run(async () => {
      if (this.blockedError) throw this.blockedError;
      if (expectedRevision !== this.data.whiteboardRevision) {
        return {
          ok: false,
          code: "WHITEBOARD_REVISION_CONFLICT",
          document: this.data.whiteboard,
          revision: this.data.whiteboardRevision
        };
      }
      const next = normalizeData({
        ...this.data,
        whiteboard: document,
        whiteboardRevision: this.data.whiteboardRevision + 1
      });
      await this.persist(next);
      this.commit(next);
      return { ok: true, document: next.whiteboard, revision: next.whiteboardRevision };
    });
  }

  async registerProject(
    rootPath: string,
    name: string,
    signal?: AbortSignal,
    onPhase?: (phase: ProjectRegistrationPhase) => void
  ): Promise<ProjectRegistrationResult> {
    return this.queue.run(async () => {
      if (this.blockedError) throw this.blockedError;
      if (signal?.aborted) return { ok: false, message: "已取消添加项目。" };
      const result = registerCanonicalProject(this.data, rootPath, name);
      if (!result.ok) return result;
      if (signal?.aborted) return { ok: false, message: "已取消添加项目。" };
      onPhase?.("saving");
      await this.persist(result.data);
      this.commit(result.data);
      onPhase?.("committed");
      return result;
    });
  }

  async recover(load: () => Promise<unknown>): Promise<CockpitData> {
    return this.queue.run(async () => {
      const next = normalizeData(await load());
      await this.persist(next);
      this.blockedError = undefined;
      this.commit(next);
      return next;
    });
  }

  private commit(next: CockpitData): void {
    this.data = next;
    this.onCommit(next);
  }
}

export class DurableWriteGuard {
  private blockedError: Error | undefined;

  constructor(error: Error) {
    this.blockedError = error;
  }

  get blocked(): boolean {
    return Boolean(this.blockedError);
  }

  block(error: Error): void {
    this.blockedError = error;
  }

  assertWritable(): void {
    if (this.blockedError) throw this.blockedError;
  }

  async recover<T>(candidate: T, persist: (value: T) => Promise<void>): Promise<T> {
    await persist(candidate);
    this.blockedError = undefined;
    return candidate;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix = "item"): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createEmptyData(settings: Partial<CockpitSettings> = {}): CockpitData {
  return {
    schemaVersion: 4,
    settings: normalizeSettings(settings),
    workSessionSnapshot: createEmptyWorkSessionSnapshot(),
    whiteboard: createEmptyGlobalBoardDocument(),
    whiteboardRevision: 0,
    plans: []
  };
}

export function normalizeData(input: unknown): CockpitData {
  if (!input || typeof input !== "object") {
    return createEmptyData();
  }

  const source = input as Partial<CockpitData>;
  const settings = normalizeSettings(source.settings);
  const plans = Array.isArray(source.plans)
    ? source.plans.filter(isPartialPlan).map(normalizePlan)
    : [];
  const today = localDateString();
  const requestedPlan = plans.find((plan) => plan.id === source.activePlanId && plan.targetDate >= today);
  const activePlanId = requestedPlan?.id ?? plans.find((plan) => plan.targetDate >= today)?.id;

  return {
    schemaVersion: 4,
    settings,
    plans,
    workSessionSnapshot: normalizeWorkSessionSnapshot(source.workSessionSnapshot),
    whiteboard: normalizeGlobalBoardDocument(source.whiteboard),
    whiteboardRevision: normalizeWhiteboardRevision(source.whiteboardRevision),
    ...(activePlanId ? { activePlanId } : {}),
    ...(typeof source.lastOpenedAt === "string" ? { lastOpenedAt: source.lastOpenedAt } : {}),
    ...(typeof source.lastExportPath === "string" ? { lastExportPath: source.lastExportPath } : {})
  };
}

function normalizeWhiteboardRevision(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WhiteboardMigrationError("白板提交版本无效。");
  }
  return value;
}

export function createSeedData(): CockpitData {
  const timestamp = "2026-07-03T08:00:00.000Z";
  const plan: IntentPlan = {
    id: "seed-plan",
    intent: "明天继续完善每日看板：先核对昨日 Agent 工作，再让本地模型把下一步拆成待办。",
    targetDate: "2026-07-04",
    createdAt: timestamp,
    updatedAt: timestamp,
    model: DEFAULT_SETTINGS.llmModel,
    source: "LLM-Wiki/raw/notes/2026-07-02 每日看板的idea.md",
    tasks: [
      {
        id: "seed-task-a",
        title: "确认一句话输入的真实语义",
        detail: "从原始 note 中提炼产品主线，避免再次做成通用任务管理器。",
        category: "analysis",
        priority: "P0",
        completed: true,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "seed-task-b",
        title: "设计本地模型拆解 prompt",
        detail: "让模型返回 JSON 待办，每条只包含标题、细节、分类和优先级。",
        category: "build",
        priority: "P0",
        completed: false,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "seed-task-c",
        title: "验证跨天会话恢复",
        detail: "从昨日工作卡片复制真实恢复命令，并确认回到同一工作目录和会话。",
        category: "build",
        priority: "P1",
        completed: false,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ]
  };

  return {
    ...createEmptyData(),
    workSessionSnapshot: createSeedWorkSessionSnapshot(),
    plans: [plan],
    activePlanId: plan.id
  };
}

export function activePlan(data: CockpitData): IntentPlan | undefined {
  return data.plans.find((plan) => plan.id === data.activePlanId);
}

export function addPlanFromModelTasks(
  data: CockpitData,
  intent: string,
  tasks: ModelTask[],
  model?: string,
  source?: string,
  timestamp = nowIso(),
  targetDate = nextLocalDateString(new Date(timestamp))
): CockpitResult<CockpitData> {
  const text = intent.trim();
  if (!text) {
    return failure("EMPTY_INTENT", ERROR_MESSAGES.emptyIntent);
  }

  const normalizedTasks = tasks
    .map((task, index) => normalizeModelTask(task, index, timestamp))
    .filter((task): task is DecomposedTask => task !== null);

  if (normalizedTasks.length === 0) {
    return failure("NO_TASKS", ERROR_MESSAGES.noTasks);
  }

  const plan: IntentPlan = {
    id: createId("plan"),
    intent: text,
    targetDate: cleanDate(targetDate, nextLocalDateString(new Date(timestamp))),
    createdAt: timestamp,
    updatedAt: timestamp,
    tasks: normalizedTasks,
    ...(model ? { model } : {}),
    ...(source?.trim() ? { source: source.trim() } : {})
  };

  return success({
    ...data,
    plans: [plan, ...data.plans].slice(0, 20),
    activePlanId: plan.id
  });
}

export function toggleTaskCompletion(
  data: CockpitData,
  taskId: string,
  completed: boolean,
  timestamp = nowIso()
): CockpitResult<CockpitData> {
  let found = false;
  const plans = data.plans.map((plan) => {
    let planChanged = false;
    const tasks = plan.tasks.map((task) => {
      if (task.id !== taskId) return task;
      found = true;
      planChanged = true;
      return {
        ...task,
        completed,
        updatedAt: timestamp
      };
    });
    return planChanged ? { ...plan, tasks, updatedAt: timestamp } : plan;
  });

  if (!found) {
    return failure("TASK_NOT_FOUND", ERROR_MESSAGES.taskNotFound);
  }

  return success({
    ...data,
    plans
  });
}

export function touchOpened(data: CockpitData, timestamp = nowIso()): CockpitData {
  return {
    ...data,
    lastOpenedAt: timestamp
  };
}

export function setLastExportPath(data: CockpitData, path: string): CockpitData {
  return {
    ...data,
    lastExportPath: path
  };
}

export function setWorkSessionSnapshot(data: CockpitData, snapshot: AgentWorkSnapshot): CockpitData {
  return {
    ...data,
    workSessionSnapshot: normalizeWorkSessionSnapshot(snapshot)
  };
}

export function normalizeSettings(input: unknown): CockpitSettings {
  if (!input || typeof input !== "object") {
    return {
      ...DEFAULT_SETTINGS,
      sessionScanRoots: [...DEFAULT_SETTINGS.sessionScanRoots],
      enabledSessionProviders: [...DEFAULT_SETTINGS.enabledSessionProviders]
    };
  }

  const settings = input as Partial<CockpitSettings>;
  const storedRoots = cleanSessionScanRoots(settings.sessionScanRoots).filter(
    (root) => !LEGACY_SESSION_SCAN_ROOTS.includes(root)
  );
  const sessionScanRoots = Array.from(new Set([...storedRoots, ...DEFAULT_SESSION_SCAN_ROOTS])).slice(0, 12);
  return {
    dailyNoteFolder: cleanFolder(settings.dailyNoteFolder),
    llmEndpoint: cleanEndpoint(settings.llmEndpoint),
    llmModel: cleanModel(settings.llmModel),
    llmApiKey: typeof settings.llmApiKey === "string" ? settings.llmApiKey.trim() : "",
    sessionScanRoots,
    enabledSessionProviders: normalizeSessionProviders(settings.enabledSessionProviders),
    sessionSummaryMode: settings.sessionSummaryMode === "metadata" ? "metadata" : "native",
    runtimeNodePath: cleanCommand(settings.runtimeNodePath, DEFAULT_SETTINGS.runtimeNodePath),
    codexCliPath: cleanCommand(settings.codexCliPath, DEFAULT_SETTINGS.codexCliPath),
    claudeCliPath: cleanCommand(settings.claudeCliPath, DEFAULT_SETTINGS.claudeCliPath),
    cursorCliPath: cleanCommand(settings.cursorCliPath, DEFAULT_SETTINGS.cursorCliPath),
    dailyReviewScheduleEnabled: settings.dailyReviewScheduleEnabled === true,
    dailyReviewScheduleTime: normalizeDailyReviewScheduleTime(settings.dailyReviewScheduleTime)
  };
}

function normalizeSessionProviders(value: unknown): SessionProvider[] {
  if (!Array.isArray(value)) return [...DEFAULT_SESSION_PROVIDERS];
  const supported = new Set<SessionProvider>(DEFAULT_SESSION_PROVIDERS);
  return Array.from(new Set(value.filter((provider): provider is SessionProvider => supported.has(provider as SessionProvider))));
}

export function createEmptyWorkSessionSnapshot(date = previousLocalDateString(), timestamp = nowIso()): AgentWorkSnapshot {
  return {
    date,
    generatedAt: timestamp,
    sessions: [],
    sources: [],
    warnings: [],
    evidenceCoverage: []
  };
}

function normalizePlan(plan: IntentPlan): IntentPlan {
  return {
    id: plan.id,
    intent: plan.intent.trim(),
    targetDate: cleanDate(plan.targetDate, nextLocalDateString(new Date(plan.createdAt))),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    tasks: plan.tasks.map((task) => normalizeTask(task)).filter((task): task is DecomposedTask => task !== null),
    ...(plan.model ? { model: plan.model } : {}),
    ...(plan.source ? { source: plan.source } : {})
  };
}

function normalizeTask(task: DecomposedTask): DecomposedTask | null {
  if (!task.title.trim()) return null;
  return {
    id: task.id,
    title: task.title.trim(),
    detail: task.detail.trim(),
    category: normalizeCategory(task.category),
    priority: normalizePriority(task.priority),
    completed: task.completed === true,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function normalizeModelTask(task: ModelTask, index: number, timestamp: string): DecomposedTask | null {
  const title = typeof task.title === "string" ? task.title.trim() : "";
  const detail = typeof task.detail === "string" ? task.detail.trim() : "";
  if (!title && !detail) return null;

  return {
    id: createId(`task-${index + 1}`),
    title: title || detail.slice(0, 48) || "未命名待办",
    detail: detail || title,
    category: normalizeCategory(task.category),
    priority: normalizePriority(task.priority),
    completed: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function createSeedWorkSessionSnapshot(): AgentWorkSnapshot {
  return {
    date: "2026-07-02",
    generatedAt: "2026-07-03T08:00:00.000Z",
    sources: ["~/.codex/archived_sessions", "~/.claude/projects"],
    warnings: [],
    evidenceCoverage: [],
    sessions: [
      {
        id: "seed-codex-session",
        platform: "codex",
        title: "实现每日看板连续性原型",
        summary: "Codex 已经把意图拆解、Markdown 导出和会话恢复串起来。",
        path: "~/.codex/archived_sessions/rollout-2026-07-02-seed.jsonl",
        updatedAt: "2026-07-02T22:20:00.000Z",
        projectPath: "~/Documents/agent-notebook",
        resumeHint: "codex resume seed-codex-session",
        resumable: true,
        summarySource: "codex",
        artifacts: ["src/render.ts", "src/state.ts", "styles.css"],
        status: "completed"
      },
      {
        id: "seed-claude-session",
        platform: "claude",
        title: "补齐原始 idea 的产品语义",
        summary: "Claude 会话核对了原始想法：先看昨日各平台 Agent 做了什么，再决定今天从哪里继续。",
        path: "~/.claude/projects/seed/session.jsonl",
        updatedAt: "2026-07-02T19:10:00.000Z",
        resumeHint: "claude --resume seed-claude-session",
        resumable: true,
        summarySource: "claude",
        artifacts: ["LLM-Wiki/raw/notes/2026-07-02 每日看板的idea.md"],
        status: "completed"
      }
    ]
  };
}

function normalizeWorkSessionSnapshot(input: unknown): AgentWorkSnapshot {
  if (!input || typeof input !== "object") {
    return createEmptyWorkSessionSnapshot();
  }

  const source = input as Partial<AgentWorkSnapshot>;
  const sessions = Array.isArray(source.sessions)
    ? source.sessions.map((session) => normalizeWorkSession(session)).filter((session): session is AgentWorkSession => session !== null)
    : [];

  const date = cleanText(source.date, previousLocalDateString());
  const evidenceScope = normalizeEvidenceScope(source.evidenceScope, date);
  return {
    date,
    generatedAt: cleanText(source.generatedAt, nowIso()),
    sessions: sessions.slice(0, MAX_WORK_SESSION_SNAPSHOT_SESSIONS),
    sources: cleanSessionScanRoots(source.sources),
    warnings: Array.isArray(source.warnings)
      ? source.warnings.map((warning) => cleanText(warning, "")).filter(Boolean).slice(0, 8)
      : [],
    evidenceCoverage: normalizeEvidenceCoverage(source.evidenceCoverage),
    ...(evidenceScope ? { evidenceScope } : {})
  };
}

function normalizeEvidenceCoverage(value: unknown): NonNullable<AgentWorkSnapshot["evidenceCoverage"]> {
  if (!Array.isArray(value)) return [];
  const dispositions = new Set(["read", "skipped", "deduplicated", "truncated", "failed"]);
  const normalized = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Record<string, unknown>;
    const sourceId = exactBoundedText(raw.sourceId, 8_192);
    const detail = cleanText(raw.detail, "");
    const disposition = typeof raw.disposition === "string" && dispositions.has(raw.disposition)
      ? raw.disposition as NonNullable<AgentWorkSnapshot["evidenceCoverage"]>[number]["disposition"]
      : undefined;
    if (!sourceId || !detail || !disposition) return [];
    return [{ sourceId, disposition, detail }];
  });
  if (normalized.length <= 240) return normalized;
  return [
    ...normalized.slice(0, 239),
    {
      sourceId: "scanner:coverage-register",
      disposition: "truncated",
      detail: `${normalized.length - 239} 条额外扫描记录未进入持久化覆盖登记。`
    }
  ];
}

function normalizeEvidenceScope(
  value: unknown,
  logicalDate: string
): NonNullable<AgentWorkSnapshot["evidenceScope"]> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const timeZone = cleanText(raw.timeZone, "");
  const startInclusive = exactTimestamp(raw.startInclusive);
  const endExclusive = exactTimestamp(raw.endExclusive);
  const evidenceCutoff = exactTimestamp(raw.evidenceCutoff);
  if (
    !timeZone ||
    !isIanaTimeZone(timeZone) ||
    !startInclusive ||
    !endExclusive ||
    !evidenceCutoff ||
    Date.parse(endExclusive) <= Date.parse(startInclusive) ||
    Date.parse(evidenceCutoff) < Date.parse(startInclusive) ||
    localDateAt(startInclusive, timeZone) !== logicalDate ||
    localTimeAt(startInclusive, timeZone) !== "00:00:00" ||
    localDateAt(endExclusive, timeZone) !== nextDateString(logicalDate) ||
    localTimeAt(endExclusive, timeZone) !== "00:00:00"
  ) return undefined;
  return { timeZone, startInclusive, endExclusive, evidenceCutoff };
}

function exactBoundedText(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim().length === 0 ||
    /[\0\r\n]/.test(value)
  ) return undefined;
  return value;
}

function exactTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 80 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function localDateAt(timestamp: string, timeZone: string): string {
  const parts = localDateTimeParts(timestamp, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localTimeAt(timestamp: string, timeZone: string): string {
  const parts = localDateTimeParts(timestamp, timeZone);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function localDateTimeParts(timestamp: string, timeZone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const output = { year: "", month: "", day: "", hour: "", minute: "", second: "" };
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type in output) output[part.type as keyof typeof output] = part.value;
  }
  return output;
}

function nextDateString(value: string): string {
  const next = new Date(`${value}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function normalizeWorkSession(session: unknown): AgentWorkSession | null {
  if (!session || typeof session !== "object") return null;
  const source = session as Partial<AgentWorkSession>;
  const title = cleanText(source.title, "");
  const summary = cleanText(source.summary, "");
  const path = normalizeStoredFilePath(source.path);
  if (!title || !path) return null;
  const id = cleanText(source.id, fallbackSessionId(path));

  const normalized: AgentWorkSession = {
    id,
    platform: normalizePlatform(source.platform),
    title,
    summary: summary || title,
    path,
    updatedAt: cleanText(source.updatedAt, nowIso()),
    artifacts: Array.isArray(source.artifacts)
      ? source.artifacts
          .map((artifact) => cleanText(artifact, ""))
          .filter((artifact) => isUsefulStoredArtifact(artifact, id, path))
          .slice(0, 12)
      : [],
    status: normalizeSessionStatus(source.status),
    resumable: source.resumable === true && isTrustedStoredSessionPath(path, source.platform),
    summarySource: normalizeSummarySource(source.summarySource)
  };

  const startedAt = cleanText(source.startedAt, "");
  const projectPath = cleanText(source.projectPath, "");
  const repositoryPath = cleanText(source.repositoryPath, "");
  const worktreePath = cleanText(source.worktreePath, "");
  const branch = cleanText(source.branch, "");
  const resumeHint = cleanText(source.resumeHint, "");
  if (startedAt) normalized.startedAt = startedAt;
  if (projectPath) normalized.projectPath = projectPath;
  if (repositoryPath) normalized.repositoryPath = repositoryPath;
  if (worktreePath) normalized.worktreePath = worktreePath;
  if (branch) normalized.branch = branch;
  if (resumeHint) normalized.resumeHint = resumeHint;
  const transcriptCapture = normalizeTranscriptCapture(source.transcriptCapture);
  if (transcriptCapture?.canonicalPath === path) normalized.transcriptCapture = transcriptCapture;
  const lineage = normalizeSessionLineage(source.lineage);
  if (lineage) normalized.lineage = lineage;
  return normalized;
}

function normalizeSessionLineage(value: unknown): AgentWorkSession["lineage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const origin = source.origin;
  if (origin !== "primary" && origin !== "subagent" && origin !== "automation" && origin !== "unknown") return undefined;
  const lineage: NonNullable<AgentWorkSession["lineage"]> = { origin };
  for (const field of ["parentSessionId", "agentPath", "agentNickname", "agentRole"] as const) {
    const text = cleanText(source[field], "");
    if (text) lineage[field] = text;
  }
  return lineage;
}

function normalizeTranscriptCapture(value: unknown): AgentTranscriptCapture | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<AgentTranscriptCapture>;
  const canonicalPath = typeof source.canonicalPath === "string" ? source.canonicalPath : "";
  const sha256 = cleanText(source.sha256, "").toLowerCase();
  const byteLength = source.byteLength;
  const coverage = source.coverage;
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(canonicalPath) || /[\0\r\n]/.test(canonicalPath) || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
  if (!Number.isSafeInteger(byteLength) || (byteLength ?? -1) < 0) return undefined;
  if (!coverage || typeof coverage !== "object") return undefined;
  if (coverage.startByte !== 0 || coverage.endByte !== byteLength) return undefined;
  return {
    canonicalPath,
    sha256,
    byteLength: byteLength as number,
    coverage: { startByte: 0, endByte: byteLength as number }
  };
}

function normalizeStoredFilePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_000 || /[\0\r\n]/.test(value)) return "";
  return value;
}

function isPartialPlan(plan: unknown): plan is IntentPlan {
  if (!plan || typeof plan !== "object") return false;
  const candidate = plan as Partial<IntentPlan>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.intent === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    Array.isArray(candidate.tasks)
  );
}

function normalizeCategory(value: unknown): TaskCategory {
  return typeof value === "string" && TASK_CATEGORIES.includes(value as TaskCategory) ? (value as TaskCategory) : "other";
}

function normalizePriority(value: unknown): TaskPriority {
  return typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority) ? (value as TaskPriority) : "P1";
}

function cleanFolder(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().replace(/^\/+|\/+$/g, "")
    : DEFAULT_SETTINGS.dailyNoteFolder;
}

function cleanEndpoint(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SETTINGS.llmEndpoint;
}

function cleanModel(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SETTINGS.llmModel;
}

function cleanCommand(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() && !value.includes("\0") ? value.trim() : fallback;
}

function cleanSessionScanRoots(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : DEFAULT_SESSION_SCAN_ROOTS;
  const roots = values.map((root) => cleanText(root, "")).filter(Boolean);
  return roots.length > 0 ? Array.from(new Set(roots)).slice(0, 12) : [...DEFAULT_SESSION_SCAN_ROOTS];
}

function cleanDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? fallback : value;
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizePlatform(value: unknown): AgentPlatform {
  return value === "codex" || value === "claude" || value === "copilot" || value === "cursor" || value === "minimax" || value === "other" ? value : "other";
}

function normalizeSessionStatus(value: unknown): AgentSessionStatus {
  return value === "active" || value === "blocked" || value === "completed" || value === "unknown" ? value : "unknown";
}

function normalizeSummarySource(value: unknown): "codex" | "claude" | "cursor" | "metadata" {
  return value === "codex" || value === "claude" || value === "cursor" || value === "metadata" ? value : "metadata";
}

function isTrustedStoredSessionPath(path: string, platform: unknown): boolean {
  if (platform !== "codex" && platform !== "claude" && platform !== "copilot" && platform !== "cursor") return false;
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.claude/tasks/") || normalized.includes("/.codex/memories/")) return false;
  return platform === "copilot" ? /\/events\.jsonl$/i.test(normalized) : /\.jsonl$/i.test(normalized);
}

function isUsefulStoredArtifact(artifact: string, sessionId: string, sessionPath: string): boolean {
  if (!artifact || artifact === sessionId || artifact === sessionPath || /\.jsonl$/i.test(artifact)) return false;
  if (artifact.split(/[\\/]/).some((segment) => segment.startsWith("."))) return false;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(artifact)) return false;
  return /[\\/]/.test(artifact) || /^[^.][^\\/]*\.[A-Za-z0-9]{1,8}$/.test(artifact);
}

function fallbackSessionId(path: string): string {
  const tail = path.split(/[\\/]/).filter(Boolean).pop() ?? "session";
  return tail.replace(/\.[^.]+$/, "") || "session";
}

export function localDateString(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function nextLocalDateString(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  return localDateString(date);
}

function previousLocalDateString(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - 1);
  return localDateString(date);
}

function success<T>(data: T): CockpitResult<T> {
  return { ok: true, data };
}

function failure(code: CockpitError["code"], message: string): CockpitResult<never> {
  return { ok: false, error: { code, message } };
}
