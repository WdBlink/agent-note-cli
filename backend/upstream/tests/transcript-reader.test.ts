import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionTranscript } from "../app/desktop/transcript-reader";
import { parseEvidenceJsonl } from "../src/structured-today-evidence-spans";

test("Copilot transcript and evidence readers preserve message content, roles, tool timing and parse warnings", () => {
  const content = [
    { type: "session.start", data: { sessionId: "copilot-1" } },
    { type: "user.message", id: "u1", data: { content: "读取本地会话", source: "user", transformedContent: "hidden instructions" } },
    { type: "user.message", id: "u2", data: { content: "来源未确认的提示" } },
    { type: "user.message", id: "u3", agentId: "child-agent", data: { content: "子 Agent 指令", source: "user" } },
    { type: "tool.execution_start", timestamp: "2026-09-07T01:00:00Z", data: { toolCallId: "t1" } },
    { type: "tool.execution_complete", timestamp: "2026-09-07T01:00:01Z", data: { toolCallId: "t1", result: { content: "hidden tool output" } } },
    { type: "assistant.message_delta", data: { deltaContent: "hidden partial duplicate" } },
    { type: "assistant.message", id: "a1", data: { content: "已完成。" } }
  ].map(record => JSON.stringify(record)).join('\n') + '\n{"type":\n';
  const transcript = parseSessionTranscript({ content, platform: "copilot", sessionId: "copilot-1", title: "Copilot", path: "/tmp/events.jsonl" });
  assert.deepEqual(transcript.messages.map(m => [m.id, m.content, m.authorKind]), [["u1", "读取本地会话", "human"], ["u2", "来源未确认的提示", "unknown"], ["u3", "子 Agent 指令", "agent"], ["a1", "已完成。", "agent"]]);
  assert.equal(transcript.omittedToolEvents, 2);
  assert.equal(transcript.activityWindows?.length, 1);
  assert.match(transcript.warning ?? "", /1 行 JSON 无法解析/);
  const evidence = parseEvidenceJsonl({ source: Buffer.from(content), provider: "copilot", sessionId: "copilot-1", evidenceId: "session:copilot:copilot-1", defaultUserAuthorKind: "unknown" });
  assert.deepEqual(evidence.messages.map(m => [m.content, m.locator.authorKind]), transcript.messages.map(m => [m.content, m.authorKind]));
  assert.equal(evidence.issues.length, 1);
});

test("an incomplete Codex record does not hide valid event-only messages", () => {
  const content = [
    JSON.stringify({ type: "session_meta", payload: { id: "session" } }),
    '{"type":',
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "完整消息仍可读" } })
  ].join('\n');
  const transcript = parseSessionTranscript({ content, platform: "codex", sessionId: "session", title: "test", path: "/tmp/codex.jsonl" });
  assert.equal(transcript.messages[0]?.content, "完整消息仍可读");
  assert.match(transcript.warning ?? "", /1 行 JSON 无法解析/);
});

test("Codex transcript reader keeps conversation text and folds system and tool noise", () => {
  const content = [
    JSON.stringify({ timestamp: "2026-07-21T08:00:00.000Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "hidden instruction" }] } }),
    JSON.stringify({ timestamp: "2026-07-21T08:01:00.000Z", type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "把证据页做成内置阅读器" }] } }),
    JSON.stringify({ timestamp: "2026-07-21T08:02:00.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "read_file" } }),
    JSON.stringify({ timestamp: "2026-07-21T08:03:00.000Z", type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "已经完成只读会话视图。" }] } })
  ].join("\n");
  const transcript = parseSessionTranscript({ content, platform: "codex", sessionId: "session", title: "证据阅读器", path: "/tmp/session.jsonl" });
  assert.deepEqual(transcript.messages.map((message) => [message.role, message.content]), [
    ["user", "把证据页做成内置阅读器"],
    ["assistant", "已经完成只读会话视图。"]
  ]);
  assert.equal(transcript.omittedToolEvents, 1);
  assert.equal(transcript.messages.some((message) => message.content.includes("hidden instruction")), false);
});

test("Claude transcript reader supports nested text content", () => {
  const content = [
    JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-07-21T09:00:00.000Z", message: { role: "user", content: "阅读 Claude 会话" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-07-21T09:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "正文已经提取。" }, { type: "tool_use", name: "Read" }] } })
  ].join("\n");
  const transcript = parseSessionTranscript({ content, platform: "claude", sessionId: "session", title: "Claude 会话", path: "/tmp/session.jsonl" });
  assert.deepEqual(transcript.messages.map((message) => message.content), ["阅读 Claude 会话", "正文已经提取。"]);
});

test("transcript reader carries host-attested user authority for primary and subagent Sessions", () => {
  const content = JSON.stringify({
    type: "response_item",
    payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "规划下一步" }] }
  });
  const primary = parseSessionTranscript({ content, platform: "codex", sessionId: "root", title: "root", path: "/tmp/root", userAuthorKind: "human" });
  const subagent = parseSessionTranscript({ content, platform: "codex", sessionId: "child", title: "child", path: "/tmp/child", userAuthorKind: "agent" });
  assert.equal(primary.messages[0]?.authorKind, "human");
  assert.equal(subagent.messages[0]?.authorKind, "agent");
});

test("transcript reader derives Agent activity from provider task and tool windows", () => {
  const codex = parseSessionTranscript({
    content: [
      JSON.stringify({ timestamp: "2026-08-31T01:00:00.000Z", type: "response_item", payload: { type: "custom_tool_call", call_id: "call-1", name: "exec" } }),
      JSON.stringify({ timestamp: "2026-08-31T01:03:00.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call-1", output: "ok" } }),
      JSON.stringify({ timestamp: "2026-08-31T01:05:00.000Z", type: "event_msg", payload: { type: "task_complete", started_at: "2026-08-31T00:59:00.000Z", completed_at: "2026-08-31T01:05:00.000Z" } })
    ].join("\n"),
    platform: "codex",
    sessionId: "codex-window",
    title: "Codex window",
    path: "/tmp/codex-window"
  });
  assert.deepEqual(codex.activityWindows, [
    { id: "codex-tool-call-1", start: "2026-08-31T01:00:00.000Z", end: "2026-08-31T01:03:00.000Z", basis: "tool-execution" },
    { id: "codex-task-2", start: "2026-08-31T00:59:00.000Z", end: "2026-08-31T01:05:00.000Z", basis: "provider-task" }
  ]);

  const claude = parseSessionTranscript({
    content: [
      JSON.stringify({ type: "assistant", timestamp: "2026-08-31T02:00:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Bash" }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-08-31T02:02:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }] } }),
      JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 180_000, timestamp: "2026-08-31T02:03:00.000Z" })
    ].join("\n"),
    platform: "claude",
    sessionId: "claude-window",
    title: "Claude window",
    path: "/tmp/claude-window"
  });
  assert.deepEqual(claude.activityWindows, [
    { id: "claude-tool-tool-1", start: "2026-08-31T02:00:00.000Z", end: "2026-08-31T02:02:00.000Z", basis: "tool-execution" },
    { id: "claude-turn-2", start: "2026-08-31T02:00:00.000Z", end: "2026-08-31T02:03:00.000Z", basis: "provider-task" }
  ]);
});

test("individual message truncation is visible even below the total character limit", () => {
  const transcript = parseSessionTranscript({ platform: "codex", sessionId: "long", title: "long", path: "/tmp/long",
    content: JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "x".repeat(81000) } }) });
  assert.equal(transcript.truncated, true);
  assert.ok(transcript.warning);
  assert.ok(transcript.messages[0]!.content.length < 81000);
});
