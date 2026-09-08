import type { CockpitSettings, SessionProvider, TaskCategory, TaskPriority } from "./types";

export const PLUGIN_ID = "agent-notebook";
export const VIEW_TYPE_AGENT_NOTEBOOK = "agent-notebook-view";
export const VIEW_TYPE_AGENT_WHITEBOARD = "agent-whiteboard-view";

export const COMMAND_OPEN_COCKPIT = "open-agent-notebook";
export const COMMAND_QUICK_CAPTURE = "quick-capture";
export const COMMAND_EXPORT_DAILY_NOTE = "export-daily-note";
export const COMMAND_REFRESH_WORK_SESSIONS = "refresh-work-sessions";
export const COMMAND_OPEN_AGENT_WHITEBOARD = "open-agent-whiteboard";

export const DEFAULT_SESSION_SCAN_ROOTS = [
  "~/.codex/sessions",
  "~/.codex/archived_sessions",
  "~/.claude/projects",
  "~/.copilot/session-state",
  "~/.cursor/projects"
];

export const SESSION_PROVIDER_DEFINITIONS: ReadonlyArray<{
  id: SessionProvider;
  label: string;
  description: string;
}> = [
  { id: "codex", label: "Codex", description: "读取 ~/.codex 下的本机会话记录" },
  { id: "claude", label: "Claude Code", description: "读取 ~/.claude/projects 下的本机会话记录" },
  { id: "copilot", label: "GitHub Copilot", description: "读取 ~/.copilot/session-state 下的 CLI 会话记录" },
  { id: "cursor", label: "Cursor", description: "读取 ~/.cursor/projects 下的本机 Agent transcript，并用 Cursor Agent CLI 整理" }
];

export const DEFAULT_SESSION_PROVIDERS: SessionProvider[] = SESSION_PROVIDER_DEFINITIONS.map(({ id }) => id);

// One limit owns both desktop discovery and durable snapshot projection. A
// canonical review must never compile more Sessions than the next reload can
// retain.
export const MAX_WORK_SESSION_SNAPSHOT_SESSIONS = 48;

export const LEGACY_SESSION_SCAN_ROOTS = [
  "~/.codex/memories/rollout_summaries",
  "~/.claude/tasks",
  "~/.minimax/plans"
];

export const DEFAULT_SETTINGS: CockpitSettings = {
  dailyNoteFolder: "Agent Notebook",
  llmEndpoint: "http://127.0.0.1:11434/v1/chat/completions",
  llmModel: "qwen2.5:7b",
  llmApiKey: "",
  sessionScanRoots: DEFAULT_SESSION_SCAN_ROOTS,
  enabledSessionProviders: DEFAULT_SESSION_PROVIDERS,
  sessionSummaryMode: "native",
  runtimeNodePath: "node",
  codexCliPath: "codex",
  claudeCliPath: "claude",
  cursorCliPath: "agent",
  dailyReviewScheduleEnabled: false,
  dailyReviewScheduleTime: "18:30"
};

export const TASK_CATEGORIES: TaskCategory[] = ["research", "build", "write", "analysis", "admin", "other"];
export const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2"];

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  research: "调研",
  build: "实现",
  write: "写作",
  analysis: "分析",
  admin: "事务",
  other: "其他"
};

export const ERROR_MESSAGES = {
  emptyIntent: "先说一下你想推进什么，我再拆成待办。",
  noTasks: "模型没有拆出可用待办。可以把目标说得更具体一点再试。",
  taskNotFound: "没有找到这条待办，它可能已经被重新拆解替换了。",
  llmFailed: "本地模型没有响应。请检查模型服务、endpoint 和 model 设置。",
  llmParseFailed: "模型返回的内容不是可解析的 JSON 待办列表。",
  exportFailed: "导出失败，请检查目标文件夹权限后重试。",
  sessionScanFailed: "读取昨日工作会话失败。请检查扫描目录是否存在且可读。",
  saveFailed: "保存失败，请稍后重试，当前界面内容仍保留。"
} as const;
