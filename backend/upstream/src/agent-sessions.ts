import { createHash } from "node:crypto";
import {
  DEFAULT_SESSION_PROVIDERS,
  DEFAULT_SESSION_SCAN_ROOTS,
  MAX_WORK_SESSION_SNAPSHOT_SESSIONS
} from "./constants";
import { createEmptyWorkSessionSnapshot } from "./state";
import type {
  AgentPlatform,
  AgentEvidenceCoverageEntry,
  AgentSessionStatus,
  AgentWorkSession,
  AgentWorkSnapshot,
  CockpitSettings,
  SessionProvider
} from "./types";

export interface RuntimeFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  mtime: Date;
  ctime?: Date;
}

export interface RuntimeFileSystem {
  stat(path: string): Promise<RuntimeFileStat>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
}

export interface SessionScanOptions {
  now?: Date;
  date?: string;
  roots?: string[];
  providers?: SessionProvider[];
  fs?: RuntimeFileSystem;
  homeDir?: string;
  maxFiles?: number;
  maxSessions?: number;
  maxDepth?: number;
  maxEntries?: number;
  summarizer?: AgentSessionSummarizer;
}

export interface GeneratedSessionSummary {
  id: string;
  platform: "codex" | "claude";
  title: string;
  summary: string;
  artifacts: string[];
  status: AgentSessionStatus;
}

export interface SessionSummaryBatch {
  summaries: GeneratedSessionSummary[];
  warnings: string[];
}

export type AgentSessionSummarizer = (request: {
  date: string;
  sessions: AgentWorkSession[];
  settings: CockpitSettings;
}) => Promise<SessionSummaryBatch>;

interface CandidateFile {
  path: string;
  platform: AgentPlatform;
  updatedAt: string;
  sortTime: number;
  targetDay: boolean;
}

interface CandidateCollection {
  files: CandidateFile[];
  truncated: boolean;
  coverage: AgentEvidenceCoverageEntry[];
}

interface ParsedText {
  records: unknown[];
  plainText?: string;
}

interface ActivityWindow {
  start: number;
  targetEnd: number;
  end: number;
  stamp: string;
}

const DEFAULT_MAX_FILES = 90;
const DEFAULT_MAX_SESSIONS = MAX_WORK_SESSION_SNAPSHOT_SESSIONS;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_ENTRIES = 900;

export async function loadAgentWorkSnapshot(
  settings: CockpitSettings,
  options: SessionScanOptions = {}
): Promise<AgentWorkSnapshot> {
  const now = options.now ?? new Date();
  const date = options.date ?? previousLocalDateString(now);
  const enabledProviders = new Set(options.providers ?? settings.enabledSessionProviders ?? DEFAULT_SESSION_PROVIDERS);
  const sourceDescriptors = normalizeRoots(options.roots ?? settings.sessionScanRoots)
    .map((source) => ({ source, platform: inferPlatform(source) }))
    .filter(({ platform }) => enabledProviders.has(platform as SessionProvider));
  const sources = sourceDescriptors.map(({ source }) => source);
  const fs = options.fs ?? createRuntimeFileSystem();
  const day = dayWindow(date, now);
  if (!fs) {
    return {
      ...createEmptyWorkSessionSnapshot(date, now.toISOString()),
      sources,
      evidenceScope: evidenceScopeForDay(day, now.toISOString())
    };
  }

  const homeDir = options.homeDir ?? runtimeHomeDir();
  const candidates: CandidateFile[] = [];
  const evidenceCoverage: AgentEvidenceCoverageEntry[] = [];
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  // Each provider root gets the full discovery budget before one global
  // recency cut. Dividing the budget by root allowed a burst of child-Agent
  // files to hide their older primary Session before lineage was parsed.
  const maxFilesPerRoot = Math.max(12, maxFiles);

  for (const { source, platform } of sourceDescriptors) {
    const root = expandHome(source, homeDir);
    const found = await collectCandidateFiles(root, platform, day, fs, {
      maxFiles: maxFilesPerRoot,
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES
    });
    candidates.push(...found.files);
    evidenceCoverage.push(...found.coverage);
    if (found.truncated) {
      evidenceCoverage.push({
        sourceId: `${platform}:${root}`,
        disposition: "truncated",
        detail: "候选发现达到目录深度、文件数或目录项上限；范围可能不完整。"
      });
    }
  }

  const sessions: AgentWorkSession[] = [];
  const seen = new Map<string, string>();
  let warnings: string[] = [];
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const ordered = candidates.sort((a, b) => Number(b.targetDay) - Number(a.targetDay) || b.sortTime - a.sortTime);
  const sorted = ordered.slice(0, maxFiles);
  for (const candidate of ordered.slice(maxFiles)) {
    evidenceCoverage.push({
      sourceId: candidateSourceId(candidate),
      disposition: "truncated",
      detail: "候选文件超过本次扫描上限，未进入读取队列。"
    });
  }

  for (const candidate of sorted) {
    let session: AgentWorkSession | null;
    try {
      session = await readSession(candidate, fs, day);
    } catch (error) {
      warnings.push(`会话证据读取失败（${candidate.path}）：${errorMessage(error)}`);
      warnings = warnings.slice(0, 8);
      evidenceCoverage.push({
        sourceId: candidateSourceId(candidate),
        disposition: "failed",
        detail: `读取失败：${errorMessage(error)}`
      });
      continue;
    }
    if (!session) {
      evidenceCoverage.push({
        sourceId: candidateSourceId(candidate),
        disposition: "skipped",
        detail: "未读到落在本地日期范围内的规范事件。"
      });
      continue;
    }
    const key = session.resumable ? `${session.platform}:${session.id}` : `${session.platform}:${session.id}:${session.path}`;
    const canonicalCopy = seen.get(key);
    if (canonicalCopy) {
      evidenceCoverage.push({
        sourceId: candidateSourceId(candidate),
        disposition: "deduplicated",
        detail: `与已采用的规范副本重复：${canonicalCopy}`
      });
      continue;
    }
    seen.set(key, session.path);
    sessions.push(session);
    evidenceCoverage.push({
      sourceId: candidateSourceId(candidate),
      disposition: "read",
      detail: `已采用规范副本：${session.platform}:${session.id}:${session.path}`
    });
  }

  const retainedSessions = retainMainSessionFamilies(sessions, maxSessions);
  const retainedIdentities = new Set(retainedSessions.map((session) => `${session.platform}:${session.id}:${session.path}`));
  for (const session of sessions) {
    if (retainedIdentities.has(`${session.platform}:${session.id}:${session.path}`)) continue;
    evidenceCoverage.push({
      sourceId: `${session.platform}:${session.path}`,
      disposition: "truncated",
      detail: "已达到本次 Session 容量上限；主会话优先保留，当前执行记录未进入快照。"
    });
  }

  let mergedSessions = retainedSessions;
  if (options.summarizer && retainedSessions.length > 0) {
    try {
      const batch = await options.summarizer({ date, sessions: retainedSessions, settings });
      mergedSessions = mergeSessionSummaries(retainedSessions, batch.summaries);
      warnings = [...warnings, ...batch.warnings].slice(0, 8);
    } catch (error) {
      warnings = [...warnings, `Agent 总结失败：${errorMessage(error)}`].slice(0, 8);
    }
  }

  const generatedAt = (options.now ?? new Date()).toISOString();
  const incomplete = evidenceCoverage.filter((item) => item.disposition === "truncated" || item.disposition === "failed").length;
  if (incomplete) warnings = [`发现范围不完整：${incomplete} 项读取失败或达到扫描上限；工作线覆盖率仅针对已纳入的会话。`, ...warnings].slice(0, 8);
  return {
    date,
    generatedAt,
    sources,
    sessions: mergedSessions,
    warnings,
    evidenceCoverage,
    evidenceScope: evidenceScopeForDay(day, generatedAt)
  };
}

function retainMainSessionFamilies(sessions: AgentWorkSession[], maxSessions: number): AgentWorkSession[] {
  if (sessions.length <= maxSessions) return sessions;
  const main = sessions.filter((session) => session.lineage?.origin !== "subagent");
  const retained = main.slice(0, maxSessions);
  if (retained.length >= maxSessions) return retained;
  const retainedRootIds = new Set(retained.map((session) => session.id));
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = sessions.filter((session) => {
    if (session.lineage?.origin !== "subagent") return false;
    let parentId = session.lineage.parentSessionId;
    const seen = new Set([session.id]);
    while (parentId && !seen.has(parentId)) {
      if (retainedRootIds.has(parentId)) return true;
      seen.add(parentId);
      parentId = byId.get(parentId)?.lineage?.parentSessionId;
    }
    return false;
  });
  return [...retained, ...children.slice(0, maxSessions - retained.length)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function candidateSourceId(candidate: CandidateFile): string {
  return `${candidate.platform}:${candidate.path}`;
}

export function mergeSessionSummaries(
  sessions: AgentWorkSession[],
  summaries: GeneratedSessionSummary[]
): AgentWorkSession[] {
  const byKey = new Map(summaries.map((summary) => [`${summary.platform}:${summary.id}`, summary]));
  return sessions.map((session) => {
    const summary = byKey.get(`${session.platform}:${session.id}`);
    if (!summary) return session;
    return {
      ...session,
      title: truncateOneLine(summary.title, 120),
      summary: truncateOneLine(summary.summary, 600),
      artifacts: normalizeGeneratedArtifacts(summary.artifacts, session),
      status: isArchivedSessionPath(session.path) ? "completed" : summary.status,
      summarySource: summary.platform
    };
  });
}

export function extractWorkSessionFromText(
  content: string,
  path: string,
  platform: AgentPlatform,
  updatedAt: string
): AgentWorkSession | null {
  const parsed = parseSessionText(content);
  const identity = extractSessionIdentity(parsed.records, path, platform);
  const id = identity.id;
  const title =
    firstUsefulText(
      collectStringsByKeys(parsed.records, [
        "aiTitle",
        "subject",
        "title",
        "activeForm",
        "prompt",
        "intent",
        "request",
        "task_id",
        "plan_id"
      ])
    ) ??
    firstUsefulText(collectRoleTexts(parsed.records, "user")) ??
    titleFromPlainText(parsed.plainText) ??
    basenameStem(path);
  const summary =
    firstUsefulText(collectStringsByKeys(parsed.records, ["description", "summary", "result", "final", "answer"])) ??
    firstUsefulText(collectRoleTexts(parsed.records, "assistant").reverse()) ??
    summaryFromPlainText(parsed.plainText) ??
    "未读到摘要，打开本地路径查看原始会话。";
  const projectPath = extractCanonicalProjectPath(parsed.records, platform);
  const branch = extractCanonicalBranch(parsed.records, platform);
  const startedAt = firstUsefulText(collectStringsByKeys(parsed.records, ["timestamp", "createdAt", "startedAt"]));
  const artifacts = collectArtifacts(parsed.records, projectPath).slice(0, 12);
  const status = normalizeStatus(firstUsefulText(collectStringsByKeys(parsed.records, ["status", "state", "phase"])));
  const resumeHint = identity.resumable ? resumeCommand(platform, id) : undefined;
  const lineage = extractSessionLineage(parsed.records, platform);

  const session: AgentWorkSession = {
    id,
    platform,
    title: truncateOneLine(title, 88),
    summary: truncateOneLine(summary, 220),
    path,
    updatedAt,
    artifacts: [],
    status,
    resumable: identity.resumable,
    summarySource: "metadata"
  };

  if (startedAt && isIsoLike(startedAt)) session.startedAt = startedAt;
  if (projectPath) session.projectPath = projectPath;
  if (branch) session.branch = truncateOneLine(branch, 160);
  if (resumeHint) session.resumeHint = resumeHint;
  if (lineage) session.lineage = lineage;
  session.artifacts = normalizeGeneratedArtifacts(artifacts, session);
  return session;
}

function extractSessionLineage(
  records: unknown[],
  platform: AgentPlatform
): AgentWorkSession["lineage"] | undefined {
  if (platform === "claude") return { origin: "primary" };
  if (platform !== "codex") return { origin: "unknown" };
  for (const value of records) {
    const record = asRecord(value);
    if (stringField(record, "type") !== "session_meta") continue;
    const payload = asRecord(recordField(record, "payload"));
    const source = recordField(payload, "source");
    const subagent = asRecord(recordField(source, "subagent"));
    const spawn = asRecord(recordField(subagent, "thread_spawn"));
    const threadSource = stringField(payload, "thread_source");
    const origin = subagent || threadSource === "subagent"
      ? "subagent"
      : typeof source === "string" && source === "exec"
        ? "automation"
        : typeof source === "string" || source
          ? "primary"
          : "unknown";
    const lineage: NonNullable<AgentWorkSession["lineage"]> = { origin };
    const parentSessionId = firstUsefulText([
      stringField(spawn, "parent_thread_id") ?? "",
      stringField(payload, "parent_thread_id") ?? "",
      stringField(payload, "forked_from_id") ?? ""
    ]);
    const agentPath = firstUsefulText([
      stringField(spawn, "agent_path") ?? "",
      stringField(payload, "agent_path") ?? ""
    ]);
    const agentNickname = firstUsefulText([
      stringField(spawn, "agent_nickname") ?? "",
      stringField(payload, "agent_nickname") ?? ""
    ]);
    const agentRole = firstUsefulText([
      stringField(spawn, "agent_role") ?? "",
      stringField(payload, "agent_role") ?? ""
    ]);
    if (parentSessionId) lineage.parentSessionId = parentSessionId;
    if (agentPath) lineage.agentPath = agentPath;
    if (agentNickname) lineage.agentNickname = agentNickname;
    if (agentRole) lineage.agentRole = agentRole;
    return lineage;
  }
  return { origin: "unknown" };
}

export function previousLocalDateString(now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function collectCandidateFiles(
  root: string,
  platform: AgentPlatform,
  day: ActivityWindow,
  fs: RuntimeFileSystem,
  limits: { maxFiles: number; maxDepth: number; maxEntries: number }
): Promise<CandidateCollection> {
  const files: CandidateFile[] = [];
  const coverage: AgentEvidenceCoverageEntry[] = [];
  let inspected = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= limits.maxFiles || inspected >= limits.maxEntries || depth > limits.maxDepth) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      coverage.push({
        sourceId: `${platform}:${dir}`,
        disposition: errorCode(error) === "ENOENT" ? "skipped" : "failed",
        detail: errorCode(error) === "ENOENT"
          ? "扫描目录不存在。"
          : `扫描目录读取失败：${errorMessage(error)}`
      });
      return;
    }

    const preferred = (entry: string) => entry.includes(day.stamp) ||
      (platform === "codex" && isCodexDateDirectory(joinPath(dir, entry), day.stamp));
    for (const entry of entries.sort((a, b) => Number(preferred(b)) - Number(preferred(a)) || b.localeCompare(a))) {
      if (files.length >= limits.maxFiles || inspected >= limits.maxEntries) {
        truncated = true;
        return;
      }
      inspected += 1;
      const fullPath = joinPath(dir, entry);
      let stat: RuntimeFileStat;
      try {
        stat = await fs.stat(fullPath);
      } catch (error) {
        coverage.push({
          sourceId: `${platform}:${fullPath}`,
          disposition: errorCode(error) === "ENOENT" ? "skipped" : "failed",
          detail: errorCode(error) === "ENOENT"
            ? "候选在扫描期间消失。"
            : `候选元数据读取失败：${errorMessage(error)}`
        });
        continue;
      }

      if (stat.isDirectory()) {
        const shouldDescend =
          depth === 0 ||
          isInTargetDay(stat, day) ||
          fullPath.includes(day.stamp) ||
          (platform === "codex" &&
            (isCodexDateDirectory(fullPath, day.stamp) || isCodexDateHierarchyDirectory(fullPath)));
        if (shouldDescend) await walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const filePlatform = inferPlatform(fullPath, platform);
        if (!isCandidateSessionFile(fullPath, filePlatform) || (!isInTargetDay(stat, day) && !fullPath.includes(day.stamp))) {
          continue;
        }
        files.push({
          path: fullPath,
          platform: filePlatform,
          updatedAt: stat.mtime.toISOString(),
          sortTime: stat.mtime.getTime(),
          targetDay: fullPath.includes(day.stamp) ||
            fullPath.replace(/\\/g, "/").includes(`/${day.stamp.replace(/-/g, "/")}/`) ||
            (stat.mtime.getTime() >= day.start && stat.mtime.getTime() < day.targetEnd)
        });
      }
    }
  }

  await walk(root, 0);
  if (files.length === 0 && coverage.length === 0) {
    coverage.push({
      sourceId: `${platform}:${root}`,
      disposition: "skipped",
      detail: "扫描完成；没有发现候选 Session 文件。"
    });
  }
  return { files, truncated, coverage };
}

async function readSession(
  candidate: CandidateFile,
  fs: RuntimeFileSystem,
  day: ActivityWindow
): Promise<AgentWorkSession | null> {
  const canonicalPath = await fs.realpath(candidate.path);
  const bytes = await fs.readBytes(canonicalPath);
  const content = new TextDecoder().decode(bytes);
  if (hasTargetDayActivity(content, day) === false) return null;
  const session = extractWorkSessionFromText(content, canonicalPath, candidate.platform, candidate.updatedAt);
  if (session) {
    session.transcriptCapture = {
      canonicalPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      coverage: { startByte: 0, endByte: bytes.byteLength }
    };
  }
  if (session && (isArchivedSessionPath(candidate.path) || isArchivedSessionPath(canonicalPath))) session.status = "completed";
  if (session) await enrichWorkspaceMetadata(session, fs);
  return session;
}

export function isArchivedSessionPath(value: string): boolean {
  return /(?:^|[\\/])archived_sessions(?:[\\/]|$)/i.test(value)
    || /(?:^|[\\/])archive(?:[\\/]|$)/i.test(value);
}

async function enrichWorkspaceMetadata(session: AgentWorkSession, fs: RuntimeFileSystem): Promise<void> {
  const workspace = session.projectPath;
  if (!workspace || workspace.startsWith("~") || /[\r\n\0]/.test(workspace)) return;
  const marker = joinPath(workspace, ".git");
  try {
    const stat = await fs.stat(marker);
    if (stat.isDirectory()) {
      session.repositoryPath = workspace;
      return;
    }
    if (!stat.isFile()) return;
    const content = await fs.readFile(marker, "utf8");
    const gitDir = content.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    session.worktreePath = workspace;
    if (!gitDir) return;
    const normalized = gitDir.replace(/\\/g, "/");
    const markerIndex = normalized.lastIndexOf("/.git/worktrees/");
    if (markerIndex > 0) session.repositoryPath = normalized.slice(0, markerIndex);
  } catch {
    // A valid session can point at a deleted project or worktree; keep it resumable.
  }
}

function extractSessionIdentity(
  records: unknown[],
  path: string,
  platform: AgentPlatform
): { id: string; resumable: boolean } {
  let canonicalId: string | undefined;

  if (platform === "codex") {
    for (const value of records) {
      const record = asRecord(value);
      if (stringField(record, "type") !== "session_meta") continue;
      const payload = asRecord(recordField(record, "payload"));
      canonicalId = firstUsefulText([stringField(payload, "id") ?? "", stringField(payload, "session_id") ?? ""]);
      if (canonicalId) break;
    }
  } else if (platform === "claude") {
    for (const value of records) {
      canonicalId = firstUsefulText([
        stringField(value, "sessionId") ?? "",
        stringField(value, "session_id") ?? "",
        stringField(value, "conversationId") ?? ""
      ]);
      if (canonicalId) break;
    }
  }

  if (canonicalId && (platform === "codex" || platform === "claude")) {
    return { id: canonicalId, resumable: true };
  }

  const fallback =
    firstUsefulText(collectStringsByKeys(records, ["plan_id", "task_id", "id"])) ??
    planIdFromPath(path) ??
    basenameStem(path);
  return { id: fallback, resumable: false };
}

function extractCanonicalProjectPath(records: unknown[], platform: AgentPlatform): string | undefined {
  if (platform === "codex") {
    for (const value of records) {
      const record = asRecord(value);
      if (stringField(record, "type") !== "session_meta") continue;
      const payload = recordField(record, "payload");
      const cwd = stringField(payload, "cwd");
      if (cwd?.trim()) return cleanOneLine(cwd);
    }
    return undefined;
  } else if (platform === "claude") {
    for (const value of records) {
      const cwd = stringField(value, "cwd");
      if (cwd?.trim()) return cleanOneLine(cwd);
    }
    return undefined;
  }
  return firstUsefulText(collectStringsByKeys(records, ["projectPath", "workspace", "root"]));
}

function extractCanonicalBranch(records: unknown[], platform: AgentPlatform): string | undefined {
  if (platform === "codex") {
    for (const value of records) {
      const record = asRecord(value);
      if (stringField(record, "type") !== "session_meta") continue;
      const payload = recordField(record, "payload");
      const git = recordField(payload, "git");
      const branch = stringField(git, "branch");
      if (branch?.trim()) return cleanOneLine(branch);
    }
  } else if (platform === "claude") {
    for (const value of records) {
      const branch = stringField(value, "gitBranch");
      if (branch?.trim()) return cleanOneLine(branch);
    }
  }
  return undefined;
}

function parseSessionText(content: string): ParsedText {
  const trimmed = content.trim();
  if (!trimmed) return { records: [], plainText: "" };

  const records: unknown[] = [];
  const allJsonlLines = trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  const jsonlLines =
    allJsonlLines.length <= 2000
      ? allJsonlLines
      : [...allJsonlLines.slice(0, 100), ...allJsonlLines.slice(-1900)];
  if (jsonlLines.length > 1) {
    for (const line of jsonlLines) {
      try {
        records.push(JSON.parse(line) as unknown);
      } catch {
        // Ignore malformed event lines; one bad line should not hide the whole session.
      }
    }
    return { records, plainText: trimmed };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return { records: Array.isArray(parsed) ? parsed : [parsed], plainText: trimmed };
    } catch {
      return { records: [], plainText: trimmed };
    }
  }

  return { records: [], plainText: trimmed };
}

function hasTargetDayActivity(content: string, day: ActivityWindow): boolean | undefined {
  let sawCanonicalTimestamp = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const record = JSON.parse(trimmed) as unknown;
      const timestamp = recordField(record, "timestamp");
      if (typeof timestamp !== "string" && typeof timestamp !== "number") continue;
      const instant =
        typeof timestamp === "number"
          ? timestamp > 9_999_999_999
            ? timestamp
            : timestamp * 1000
          : Date.parse(timestamp);
      if (!Number.isFinite(instant)) continue;
      sawCanonicalTimestamp = true;
      if (instant >= day.start && instant < day.targetEnd) return true;
    } catch {
      // Malformed event lines are ignored; metadata fallback remains available.
    }
  }
  return sawCanonicalTimestamp ? false : undefined;
}

function collectRoleTexts(records: unknown[], role: "user" | "assistant"): string[] {
  const out: string[] = [];
  for (const record of records) {
    const payload = readPayload(record);
    const message = recordField(record, "message");
    const candidateRole = stringField(payload, "role") ?? stringField(record, "role") ?? stringField(message, "role");
    if (candidateRole !== role) continue;
    const content = recordField(payload, "content") ?? recordField(record, "content") ?? recordField(message, "content");
    out.push(...collectTextFragments(content));
  }
  return out;
}

function collectStringsByKeys(records: unknown[], keys: string[]): string[] {
  const out: string[] = [];
  const targets = new Set(keys.map((key) => key.toLowerCase()));

  function walk(value: unknown, depth: number): void {
    if (depth > 7 || out.length >= 80) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (targets.has(key.toLowerCase()) && typeof child === "string") {
        out.push(child);
      } else if (typeof child === "number" && targets.has(key.toLowerCase())) {
        out.push(new Date(child > 9_999_999_999 ? child : child * 1000).toISOString());
      } else if (child && typeof child === "object") {
        walk(child, depth + 1);
      }
    }
  }

  for (const record of records) walk(record, 0);
  return out;
}

function collectTextFragments(value: unknown): string[] {
  const out: string[] = [];

  function walk(child: unknown, depth: number): void {
    if (depth > 6 || out.length >= 40) return;
    if (typeof child === "string") {
      out.push(child);
      return;
    }
    if (Array.isArray(child)) {
      for (const item of child) walk(item, depth + 1);
      return;
    }
    const record = asRecord(child);
    if (!record) return;
    const text = record.text;
    if (typeof text === "string") out.push(text);
    const content = record.content;
    if (content) walk(content, depth + 1);
  }

  walk(value, 0);
  return out;
}

function collectArtifacts(records: unknown[], projectPath?: string): string[] {
  const raw = collectStringsByKeys(records, ["file", "path", "artifact", "artifacts", "cwd", "projectPath"]);
  return Array.from(
    new Set(
      raw
        .map((value) => truncateOneLine(value, 220))
        .filter((value) => value !== projectPath)
        .filter((value) => /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value))
    )
  );
}

function normalizeGeneratedArtifacts(artifacts: string[], session: AgentWorkSession): string[] {
  const rejected = new Set(
    [session.id, session.path, session.projectPath, session.repositoryPath, session.worktreePath]
      .filter((value): value is string => Boolean(value))
      .map((value) => cleanOneLine(value))
  );
  return Array.from(
    new Set(
      artifacts
        .map((artifact) => truncateOneLine(artifact, 260))
        .filter(Boolean)
        .filter((artifact) => !rejected.has(artifact))
        .filter((artifact) => artifact !== ".git" && !artifact.endsWith("/.git"))
        .filter((artifact) => !/\.jsonl$/i.test(artifact))
        .filter((artifact) => !artifact.split(/[\\/]/).some((segment) => segment.startsWith(".")))
        .filter((artifact) => !/(?:^|[\\/])[0-9a-f]{8}-[0-9a-f-]{27,}(?:\.[a-z0-9]+)?$/i.test(artifact))
        .filter((artifact) => !/[\\/](?:\.codex[\\/]sessions|\.claude[\\/]projects)[\\/]/i.test(artifact))
        .filter((artifact) => /[\\/]/.test(artifact) || /^[^.][^\\/]*\.[A-Za-z0-9]{1,8}$/.test(artifact))
    )
  ).slice(0, 12);
}

function firstUsefulText(values: string[]): string | undefined {
  for (const value of values) {
    const cleaned = cleanOneLine(value);
    if (!cleaned) continue;
    if (isNoiseText(cleaned)) continue;
    return cleaned;
  }
  return undefined;
}

function titleFromPlainText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const heading = value.match(/^#{1,3}\s+(.+)$/m)?.[1];
  if (heading) {
    const cleaned = cleanOneLine(heading);
    if (cleaned && !isNoiseText(cleaned)) return cleaned;
  }
  return firstUsefulText(value.split(/\r?\n/));
}

function summaryFromPlainText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const paragraph = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 20 && !line.startsWith("#"));
  return paragraph ? cleanOneLine(paragraph) : undefined;
}

function normalizeStatus(value: string | undefined): AgentSessionStatus {
  const status = value?.toLowerCase() ?? "";
  if (/complete|completed|done|success|finished/.test(status)) return "completed";
  if (/blocked|failed|error/.test(status)) return "blocked";
  if (/active|running|pending|in_progress|started/.test(status)) return "active";
  return "unknown";
}

function resumeCommand(platform: AgentPlatform, id: string): string | undefined {
  if (!id) return undefined;
  if (platform === "codex") return `codex resume ${id}`;
  if (platform === "claude") return `claude --resume ${id}`;
  return undefined;
}

function normalizeRoots(roots: string[]): string[] {
  const cleaned = roots.map((root) => cleanOneLine(root)).filter(Boolean);
  return cleaned.length > 0 ? Array.from(new Set(cleaned)).slice(0, 12) : [...DEFAULT_SESSION_SCAN_ROOTS];
}

function createRuntimeFileSystem(): RuntimeFileSystem | undefined {
  const runtimeRequire = getRuntimeRequire();
  if (!runtimeRequire) return undefined;
  try {
    const fsModule = runtimeRequire("fs") as {
      promises?: {
        stat(path: string): Promise<RuntimeFileStat>;
        readdir(path: string): Promise<string[]>;
        readFile(path: string, encoding?: "utf8"): Promise<string | Uint8Array>;
        realpath(path: string): Promise<string>;
      };
    };
    const promises = fsModule.promises;
    if (!promises) return undefined;
    return {
      stat: (path) => promises.stat(path),
      readdir: (path) => promises.readdir(path),
      readFile: async (path, encoding) => promises.readFile(path, encoding) as Promise<string>,
      readBytes: async (path) => promises.readFile(path) as Promise<Uint8Array>,
      realpath: (path) => promises.realpath(path)
    };
  } catch {
    return undefined;
  }
}

function runtimeHomeDir(): string {
  const runtimeRequire = getRuntimeRequire();
  if (runtimeRequire) {
    try {
      const osModule = runtimeRequire("os") as { homedir?: () => string };
      const home = osModule.homedir?.();
      if (home) return home;
    } catch {
      // Fall through to the environment fallback.
    }
  }
  const maybeProcess = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return maybeProcess.process?.env?.HOME ?? "~";
}

type RuntimeRequire = (id: string) => unknown;

function getRuntimeRequire(): RuntimeRequire | undefined {
  const global = globalThis as { require?: RuntimeRequire; window?: { require?: RuntimeRequire } };
  return global.window?.require ?? global.require;
}

function readPayload(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return undefined;
  return record.payload ?? value;
}

function recordField(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const field = recordField(value, key);
  return typeof field === "string" ? field : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function dayWindow(stamp: string, now: Date): ActivityWindow {
  const [yearText, monthText, dayText] = stamp.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
  const targetEnd = new Date(year, month - 1, day + 1, 0, 0, 0, 0).getTime();
  // Include files updated after midnight today so a cross-midnight session is
  // inspected; canonical event timestamps then keep only target-day activity.
  const end = Math.max(targetEnd, now.getTime() + 1);
  return { start, targetEnd, end, stamp };
}

function evidenceScopeForDay(day: ActivityWindow, evidenceCutoff: string): NonNullable<AgentWorkSnapshot["evidenceScope"]> {
  return {
    timeZone: resolvedLocalTimeZone(),
    startInclusive: new Date(day.start).toISOString(),
    endExclusive: new Date(day.targetEnd).toISOString(),
    evidenceCutoff
  };
}

function resolvedLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isInTargetDay(stat: RuntimeFileStat, day: { start: number; end: number }): boolean {
  const mtime = stat.mtime.getTime();
  const ctime = stat.ctime?.getTime() ?? 0;
  return (mtime >= day.start && mtime < day.end) || (ctime >= day.start && ctime < day.end);
}

function isCodexDateDirectory(path: string, stamp: string): boolean {
  const [year, month, day] = stamp.split("-");
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return [year, `${year}/${month}`, `${year}/${month}/${day}`].some((suffix) => normalized.endsWith(`/${suffix}`));
}

function isCodexDateHierarchyDirectory(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return /\/(?:20\d{2}|20\d{2}\/\d{2}|20\d{2}\/\d{2}\/\d{2})$/.test(normalized);
}

function inferPlatform(path: string, fallback: AgentPlatform = "other"): AgentPlatform {
  const lower = path.toLowerCase();
  if (lower.includes("codex")) return "codex";
  if (lower.includes("claude")) return "claude";
  if (lower.includes("minimax") || lower.includes("mini-max")) return "minimax";
  return fallback;
}

function isCandidateSessionFile(path: string, platform: AgentPlatform): boolean {
  if (platform === "codex" || platform === "claude") return /\.jsonl$/i.test(path);
  return false;
}

function expandHome(path: string, homeDir: string): string {
  return path === "~" || path.startsWith("~/") ? `${homeDir}${path.slice(1)}` : path;
}

function joinPath(parent: string, child: string): string {
  return parent.endsWith("/") ? `${parent}${child}` : `${parent}/${child}`;
}

function basenameStem(path: string): string {
  const tail = path.split(/[\\/]/).filter(Boolean).pop() ?? "session";
  return tail.replace(/\.[^.]+$/, "") || "session";
}

function planIdFromPath(path: string): string | undefined {
  return path.match(/[\\/]((?:plan|arxiv|uav)[^\\/]+)(?:[\\/]|$)/i)?.[1];
}

function truncateOneLine(value: string, maxLength: number): string {
  const cleaned = cleanOneLine(value);
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}...` : cleaned;
}

function cleanOneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isNoiseText(value: string): boolean {
  return (
    value.length > 1400 ||
    /^[{}[\],:]+$/.test(value) ||
    /^-{3,}$/.test(value) ||
    /^Cancelled at\b/i.test(value) ||
    /^\[\d{4}-\d{2}-\d{2}[ T]/.test(value) ||
    value.startsWith("<environment_context>") ||
    value.startsWith("<permissions instructions>") ||
    value.startsWith("<collaboration_mode>") ||
    value.startsWith("<recommended_plugins>") ||
    value.startsWith("<apps_instructions>") ||
    value.startsWith("<plugins_instructions>") ||
    value.startsWith("# AGENTS.md instructions") ||
    value.includes("You are Codex, a coding agent") ||
    value.includes("Filesystem sandboxing defines which files")
  );
}

function isIsoLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return truncateOneLine(error.message, 180);
  return "未知错误";
}
