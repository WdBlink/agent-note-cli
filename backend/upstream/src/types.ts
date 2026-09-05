export type TaskPriority = "P0" | "P1" | "P2";

export type TaskCategory = "research" | "build" | "write" | "analysis" | "admin" | "other";

export type SessionSummaryMode = "native" | "metadata";

export type SessionProvider = "codex" | "claude";

export type AgentPlatform = SessionProvider | "minimax" | "other";

export interface CockpitSettings {
  dailyNoteFolder: string;
  llmEndpoint: string;
  llmModel: string;
  llmApiKey?: string;
  sessionScanRoots: string[];
  enabledSessionProviders: SessionProvider[];
  sessionSummaryMode: SessionSummaryMode;
  runtimeNodePath: string;
  codexCliPath: string;
  claudeCliPath: string;
  dailyReviewScheduleEnabled: boolean;
  dailyReviewScheduleTime: string;
}

export interface IntentInput {
  text: string;
  source?: string;
}

export interface DecomposedTask {
  id: string;
  title: string;
  detail: string;
  category: TaskCategory;
  priority: TaskPriority;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntentPlan {
  id: string;
  intent: string;
  targetDate: string;
  createdAt: string;
  updatedAt: string;
  tasks: DecomposedTask[];
  model?: string;
  source?: string;
}

export type AgentSessionStatus = "active" | "blocked" | "completed" | "unknown";

export interface AgentTranscriptCapture {
  canonicalPath: string;
  sha256: string;
  byteLength: number;
  coverage: {
    startByte: number;
    endByte: number;
  };
}

export type AgentSessionOrigin = "primary" | "subagent" | "automation" | "unknown";

export interface AgentSessionLineage {
  origin: AgentSessionOrigin;
  parentSessionId?: string;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
}

export interface AgentWorkSession {
  id: string;
  platform: AgentPlatform;
  title: string;
  summary: string;
  path: string;
  updatedAt: string;
  startedAt?: string;
  projectPath?: string;
  repositoryPath?: string;
  worktreePath?: string;
  branch?: string;
  resumeHint?: string;
  resumable?: boolean;
  summarySource?: "codex" | "claude" | "metadata";
  artifacts: string[];
  status: AgentSessionStatus;
  transcriptCapture?: AgentTranscriptCapture;
  lineage?: AgentSessionLineage;
}

export interface AgentEvidenceCoverageEntry {
  sourceId: string;
  disposition: "read" | "skipped" | "deduplicated" | "truncated" | "failed";
  detail: string;
}

export interface AgentEvidenceScope {
  timeZone: string;
  startInclusive: string;
  endExclusive: string;
  evidenceCutoff: string;
}

export interface AgentWorkSnapshot {
  date: string;
  generatedAt: string;
  sessions: AgentWorkSession[];
  sources: string[];
  warnings: string[];
  evidenceCoverage?: AgentEvidenceCoverageEntry[];
  evidenceScope?: AgentEvidenceScope;
}

export interface CockpitData {
  schemaVersion: 4;
  settings: CockpitSettings;
  plans: IntentPlan[];
  workSessionSnapshot: AgentWorkSnapshot;
  whiteboard: WhiteboardStore;
  activePlanId?: string;
  lastOpenedAt?: string;
  lastExportPath?: string;
}

export interface CockpitError {
  code:
    | "EMPTY_INTENT"
    | "NO_TASKS"
    | "TASK_NOT_FOUND"
    | "LLM_FAILED"
    | "LLM_PARSE_FAILED"
    | "EXPORT_FAILED"
    | "SESSION_SCAN_FAILED"
    | "SAVE_FAILED";
  message: string;
}

export type CockpitResult<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: CockpitError;
    };

export interface ModelTask {
  title: string;
  detail: string;
  category?: string;
  priority?: string;
}

export interface ModelDecomposition {
  tasks: ModelTask[];
  model?: string;
}

export interface RendererActions {
  decompose(input: IntentInput): Promise<CockpitResult<CockpitData>>;
  toggleTaskCompletion(taskId: string, completed: boolean): Promise<CockpitResult<CockpitData>>;
  refreshWorkSessions(): Promise<CockpitResult<CockpitData>>;
  copyResumeCommand(command: string): Promise<boolean>;
  openLocalPath(path: string, reveal?: boolean): Promise<boolean>;
  exportDailyNote(): Promise<CockpitResult<{ path: string }>>;
  clearError(): void;
}

export interface RendererState {
  data: CockpitData;
  processing: boolean;
  refreshingSessions?: boolean;
  error?: CockpitError;
  exportPath?: string;
}

export interface RenderController {
  update(nextState: RendererState): void;
  destroy(): void;
}
import type { WhiteboardStore } from "./whiteboard-model";
