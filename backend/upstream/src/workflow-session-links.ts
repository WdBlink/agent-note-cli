import type { AgentWorkSession } from "./types";

export interface WorkflowSessionReceipt {
  parentSessionId: string;
  parentPath: string;
  toolUseId: string;
  childSessionId: string;
  launchedAt: string;
  stepStartedAt: string;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;

function workflowCommand(value: unknown): { action: string; runId?: string } | undefined {
  if (typeof value !== "string" || /[;&|`$\n]/.test(value)) return undefined;
  const tokens = value.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map(token => token.replace(/^["']|["']$/g, "")) ?? [];
  if (tokens[0]?.split("/").pop() === "node") tokens.shift();
  const executable = tokens.shift() ?? "";
  if (!/(?:^|\/)codex-workflow$/.test(executable) && !/dynamic-workflow.*\/bin\/workflow\.mjs$/.test(executable)) return undefined;
  const action = tokens.shift();
  if (!action || !["run", "status", "wait"].includes(action) || !tokens.includes("--json")) return undefined;
  const positional = tokens.filter(token => token !== "--json");
  if (action !== "run" && positional.length !== 1) return undefined;
  return { action, ...(action === "run" ? {} : { runId: positional[0]! }) };
}

function jsonValues(value: unknown): unknown[] {
  const content = typeof value === "string" ? value : Array.isArray(value)
    ? value.map(block => text(object(block)?.text) ?? "").join("\n") : "";
  try { return [JSON.parse(content)]; } catch { /* CLI output can contain JSONL progress before the receipt. */ }
  return content.split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function workflowSessionReceipts(records: unknown[], parent: AgentWorkSession): WorkflowSessionReceipt[] {
  if (parent.platform !== "claude") return [];
  const calls = new Map<string, { action: string; runId?: string; startedAt?: string | undefined }>();
  const launches = new Map<string, string>();
  const receipts: WorkflowSessionReceipt[] = [];
  for (const value of records) {
    const record = object(value);
    const message = object(record?.message);
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      const item = object(block);
      if (record?.type === "assistant" && item?.type === "tool_use" && item.name === "Bash") {
        const command = workflowCommand(object(item.input)?.command);
        const id = text(item.id);
        if (command && id) calls.set(id, { ...command, startedAt: text(record?.timestamp) });
      }
      if (record?.type !== "user" || item?.type !== "tool_result" || item.is_error === true) continue;
      const toolUseId = text(item.tool_use_id);
      const call = toolUseId && calls.get(toolUseId);
      if (!call || !toolUseId) continue;
      for (const value of jsonValues(item.content)) {
        const state = object(value);
        const runId = text(state?.runId);
        if (!state || !runId) continue;
        if (call.action === "run" && call.startedAt) launches.set(runId, call.startedAt);
        if (!launches.has(runId) || (call.runId && call.runId !== runId) || state.version !== 1) continue;
        const steps = object(state.steps);
        if (!steps) continue;
        for (const [id, value] of Object.entries(steps)) {
          const step = object(value);
          const childSessionId = text(step?.threadId);
          if (step?.id !== id || !childSessionId) continue;
          receipts.push({ parentSessionId: parent.id, parentPath: parent.path, toolUseId, childSessionId, launchedAt: launches.get(runId)!, stepStartedAt: text(step?.startedAt) ?? "" });
        }
      }
    }
  }
  return receipts;
}

export function associateWorkflowSessions(sessions: AgentWorkSession[], receipts: WorkflowSessionReceipt[]): string[] {
  const warnings: string[] = [];
  const claims = new Map<string, WorkflowSessionReceipt[]>();
  for (const receipt of receipts) {
    const list = claims.get(receipt.childSessionId) ?? [];
    list.push(receipt);
    claims.set(receipt.childSessionId, list);
  }
  for (const [id, candidates] of claims) {
    const parents = new Set(candidates.map(item => item.parentSessionId + "\0" + item.parentPath));
    const children = sessions.filter(session => session.platform === "codex" && session.id === id);
    if (parents.size !== 1 || children.length !== 1) {
      warnings.push(`Workflow 关联未确定：Codex ${id} 的父来源有冲突，或子来源未纳入当前扫描。`);
      continue;
    }
    const child = children[0]!;
    const childStart = Date.parse(child.startedAt ?? "");
    const receipt = candidates.find(candidate => {
      const launch = Date.parse(candidate.launchedAt);
      const step = Date.parse(candidate.stepStartedAt);
      return Number.isFinite(childStart) && Number.isFinite(launch) && Number.isFinite(step) && childStart >= launch && childStart >= step;
    });
    if (!receipt) {
      warnings.push(`Workflow 关联未确定：Codex ${id} 缺少新建于本次步骤启动之后的时间证据，可能是恢复的旧会话。`);
      continue;
    }
    const parent = sessions.find(session => session.platform === "claude" && session.id === receipt.parentSessionId && session.path === receipt.parentPath);
    if (!parent || child.lineage?.origin !== "automation" || child.lineage.parentSessionId) continue;
    child.lineage = { origin: "subagent", parentSessionId: parent.id, parentProvider: "claude", parentToolUseId: receipt.toolUseId };
  }
  return warnings;
}
