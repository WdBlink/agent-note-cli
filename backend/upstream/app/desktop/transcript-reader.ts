import type { AgentPlatform } from "../../src/types";
import type {
  SessionTranscriptActivityWindow,
  SessionTranscriptMessage,
  SessionTranscriptState
} from "./api";

const MAX_MESSAGE_CHARACTERS = 80_000;
const MAX_TOTAL_CHARACTERS = 3_000_000;

export function parseSessionTranscript(input: {
  content: string;
  platform: AgentPlatform;
  sessionId: string;
  title: string;
  path: string;
  truncated?: boolean;
  userAuthorKind?: "human" | "agent" | "automation" | "unknown";
}): SessionTranscriptState {
  const records = input.content.split(/\r?\n/).map(parseRecord).filter((record): record is Record<string, unknown> => Boolean(record));
  const userAuthorKind = input.userAuthorKind ?? "unknown";
  const primary = input.platform === "codex"
    ? parseCodexMessages(records, userAuthorKind)
    : parseRoleTranscriptMessages(records, userAuthorKind, input.platform === "cursor" ? "cursor" : "claude");
  const limited = limitMessages(deduplicateMessages(primary.messages));
  const contentTruncated = limited.truncated;
  const state: SessionTranscriptState = {
    sessionId: input.sessionId,
    platform: input.platform,
    title: input.title,
    path: input.path,
    messages: limited.messages,
    activityWindows: primary.activityWindows,
    omittedToolEvents: primary.omittedToolEvents,
    truncated: input.truncated === true || contentTruncated
  };
  if (input.truncated) state.warning = "会话文件较大，阅读器保留了开头与最近内容，中间部分已省略。";
  else if (contentTruncated) state.warning = "会话正文很长，阅读器已在安全上限处停止显示。原始记录没有被修改。";
  return state;
}

function parseCodexMessages(records: Record<string, unknown>[], userAuthorKind: "human" | "agent" | "automation" | "unknown"): {
  messages: SessionTranscriptMessage[];
  activityWindows: SessionTranscriptActivityWindow[];
  omittedToolEvents: number;
} {
  const messages: SessionTranscriptMessage[] = [];
  const fallback: SessionTranscriptMessage[] = [];
  const activityWindows: SessionTranscriptActivityWindow[] = [];
  const toolStarts = new Map<string, string>();
  let omittedToolEvents = 0;
  for (const [index, record] of records.entries()) {
    const payload = asRecord(record.payload);
    const timestamp = cleanTimestamp(record.timestamp);
    if (record.type === "event_msg" && payload?.type === "task_complete") {
      const end = cleanTimestamp(payload.completed_at) ?? timestamp;
      const start = cleanTimestamp(payload.started_at) ?? startFromDuration(end, payload.duration_ms);
      pushActivityWindow(activityWindows, `codex-task-${index}`, start, end, "provider-task");
    }
    if (record.type === "event_msg" && payload?.type === "item_completed") {
      pushActivityWindow(
        activityWindows,
        `codex-item-${index}`,
        timestampFromEpochMilliseconds(payload.started_at_ms),
        timestampFromEpochMilliseconds(payload.completed_at_ms),
        "provider-item"
      );
    }
    if (record.type === "response_item" && payload?.type === "message") {
      const role = normalizeRole(payload.role);
      const content = extractContent(payload.content);
      if (role && content) messages.push(message(payload.id, index, role, content, timestamp, userAuthorKind));
      continue;
    }
    if (record.type === "response_item" && (payload?.type === "custom_tool_call" || payload?.type === "function_call")) {
      const callId = cleanText(payload.call_id);
      if (callId && timestamp) toolStarts.set(callId, timestamp);
    }
    if (record.type === "response_item" && (payload?.type === "custom_tool_call_output" || payload?.type === "function_call_output")) {
      const callId = cleanText(payload.call_id);
      if (callId) {
        pushActivityWindow(activityWindows, `codex-tool-${callId}`, toolStarts.get(callId), timestamp, "tool-execution");
        toolStarts.delete(callId);
      }
    }
    if (record.type === "event_msg" && (payload?.type === "user_message" || payload?.type === "agent_message")) {
      const role = payload.type === "user_message" ? "user" : "assistant";
      const content = cleanText(payload.message);
      if (content) fallback.push(message(undefined, index, role, content, timestamp, userAuthorKind));
      continue;
    }
    if (record.type === "response_item" && typeof payload?.type === "string" && /tool|function|command|computer|web/i.test(payload.type)) {
      omittedToolEvents += 1;
    }
  }
  return {
    messages: messages.length ? messages : fallback,
    activityWindows: deduplicateActivityWindows(activityWindows),
    omittedToolEvents
  };
}

function parseRoleTranscriptMessages(
  records: Record<string, unknown>[],
  userAuthorKind: "human" | "agent" | "automation" | "unknown",
  platform: "claude" | "cursor"
): {
  messages: SessionTranscriptMessage[];
  activityWindows: SessionTranscriptActivityWindow[];
  omittedToolEvents: number;
} {
  const messages: SessionTranscriptMessage[] = [];
  const activityWindows: SessionTranscriptActivityWindow[] = [];
  const toolStarts = new Map<string, string>();
  let omittedToolEvents = 0;
  for (const [index, record] of records.entries()) {
    const nested = asRecord(record.message);
    const timestamp = cleanTimestamp(record.timestamp) ?? timestampFromCursorText(nested?.content ?? record.content);
    const role = normalizeRole(nested?.role ?? record.role ?? record.type);
    if (role) {
      const content = extractContent(nested?.content ?? record.content);
      if (content) messages.push(message(record.uuid, index, role, content, timestamp, userAuthorKind));
    }
    for (const item of arrayRecords(nested?.content)) {
      if (item.type === "tool_use") {
        const callId = cleanText(item.id) ?? `${platform}-tool-${index}`;
        if (timestamp) toolStarts.set(callId, timestamp);
        omittedToolEvents += 1;
      } else if (item.type === "tool_result") {
        const callId = cleanText(item.tool_use_id);
        if (callId) {
          pushActivityWindow(activityWindows, `${platform}-tool-${callId}`, toolStarts.get(callId), timestamp, "tool-execution");
          toolStarts.delete(callId);
        }
      }
    }
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "system" && record.subtype === "turn_duration") {
      const start = startFromDuration(timestamp, record.durationMs);
      pushActivityWindow(activityWindows, `claude-turn-${index}`, start, timestamp, "provider-task");
    }
    if (/tool|progress|queue-operation/i.test(type)) omittedToolEvents += 1;
  }
  return { messages, activityWindows: deduplicateActivityWindows(activityWindows), omittedToolEvents };
}

function timestampFromCursorText(value: unknown): string | undefined {
  const text = extractContent(value);
  const tagged = text?.match(/<timestamp>\s*([^<]+?)\s*<\/timestamp>/i);
  if (!tagged) return undefined;
  const parsed = Date.parse(tagged[1]!.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function pushActivityWindow(
  windows: SessionTranscriptActivityWindow[],
  id: string,
  start: string | undefined,
  end: string | undefined,
  basis: SessionTranscriptActivityWindow["basis"]
): void {
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return;
  windows.push({ id, start, end, basis });
}

function deduplicateActivityWindows(windows: SessionTranscriptActivityWindow[]): SessionTranscriptActivityWindow[] {
  const seen = new Set<string>();
  return windows.filter((window) => {
    const key = `${window.start}:${window.end}:${window.basis}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function startFromDuration(end: string | undefined, value: unknown): string | undefined {
  if (!end || typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(Date.parse(end) - value).toISOString();
}

function timestampFromEpochMilliseconds(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value).toISOString();
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = asRecord(item);
        return record ? [record] : [];
      })
    : [];
}

function message(id: unknown, index: number, role: "user" | "assistant", content: string, timestamp: string | undefined, userAuthorKind: "human" | "agent" | "automation" | "unknown"): SessionTranscriptMessage {
  const value: SessionTranscriptMessage = {
    id: typeof id === "string" && id ? id : `message-${index}`,
    role,
    authorKind: role === "assistant" ? "agent" : userAuthorKind,
    content
  };
  if (timestamp) value.timestamp = timestamp;
  return value;
}

function extractContent(value: unknown): string | undefined {
  if (typeof value === "string") return cleanText(value);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else {
      const record = asRecord(item);
      const type = typeof record?.type === "string" ? record.type : "";
      if (!type || /text/i.test(type)) {
        const text = cleanText(record?.text ?? record?.content);
        if (text) parts.push(text);
      }
    }
  }
  return cleanText(parts.join("\n\n"));
}

function deduplicateMessages(messages: SessionTranscriptMessage[]): SessionTranscriptMessage[] {
  const seen = new Set<string>();
  return messages.filter((item) => {
    const key = `${item.role}:${item.timestamp ?? ""}:${item.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limitMessages(messages: SessionTranscriptMessage[]): { messages: SessionTranscriptMessage[]; truncated: boolean } {
  let total = 0;
  let truncated = false;
  const kept: SessionTranscriptMessage[] = [];
  for (const item of messages) {
    const oversized = item.content.length > MAX_MESSAGE_CHARACTERS;
    const content = oversized ? `${item.content.slice(0, MAX_MESSAGE_CHARACTERS)}\n\n[这条消息过长，后续内容已省略]` : item.content;
    if (total + content.length > MAX_TOTAL_CHARACTERS) return { messages: kept, truncated: true };
    kept.push(oversized ? { ...item, content } : item);
    truncated ||= oversized;
    total += content.length;
  }
  return { messages: kept, truncated };
}

function normalizeRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\r\n/g, "\n").trim();
  return clean || undefined;
}

function cleanTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return asRecord(value);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
