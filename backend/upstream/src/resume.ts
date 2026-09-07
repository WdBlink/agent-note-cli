import type { AgentWorkSession } from "./types";

const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function buildResumeCommand(session: AgentWorkSession): string | undefined {
  if (session.resumable !== true) return undefined;
  const resume = platformResumeCommand(session);
  if (!resume) return undefined;

  const projectPath = (session.worktreePath ?? session.projectPath)?.trim();
  return projectPath ? `cd ${shellPath(projectPath)} && ${resume}` : resume;
}

function platformResumeCommand(session: AgentWorkSession): string | undefined {
  const id = session.id.trim();
  if (!id) return undefined;
  if (session.platform === "codex") return `codex resume ${shellArgument(id)}`;
  if (session.platform === "claude") return `claude --resume ${shellArgument(id)}`;
  if (session.platform === "cursor") return `agent --resume ${shellArgument(id)}`;
  return undefined;
}

function shellPath(value: string): string {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) {
    return `"$HOME/${escapeDoubleQuoted(value.slice(2))}"`;
  }
  return shellArgument(value);
}

function shellArgument(value: string): string {
  if (SAFE_SHELL_TOKEN.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/([\\"$`])/g, "\\$1");
}
