import type { SessionUserAuthorKind } from "../app/desktop/session-authority";

export function copilotMessageAuthorKind(
  record: Record<string, unknown>,
  userAuthorKind: SessionUserAuthorKind = "unknown"
): SessionUserAuthorKind {
  if (record.type === "assistant.message") return "agent";
  if (record.type !== "user.message") return "unknown";
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;
  const source = data?.source;
  if (nonEmptyString(record.agentId) || nonEmptyString(data?.parentToolCallId) ||
    (typeof source === "string" && /^agent-\S+$/u.test(source))) return "agent";
  if (source === "autopilot" || data?.isAutopilotContinuation === true ||
    (typeof source === "string" && /^skill-\S+$/u.test(source))) return "automation";
  // parentAgentTaskId is turn telemetry, not authorship. Only host-attested
  // primary Sessions may supply the human default; transformedContent is ignored.
  if (source === undefined || source === "user") return userAuthorKind;
  return "unknown";
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
