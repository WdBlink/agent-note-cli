import { mkdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

// Protocol shapes from dynamic-workflow 0.4.2 cli.ts outputState/statusCommand
// and engine.ts agent result handling. No workflow or provider process is run.
export function claudeWorkflowRecords(sessionId = "session-1", launched = true) {
  const call = (id: string, action: string) => ({ type: "assistant", sessionId, timestamp: "2026-08-29T01:00:00Z",
    message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash",
      input: { command: `node /tools/dynamic-workflow/bin/workflow.mjs ${action} --json` } }] } });
  const result = (id: string, value: unknown) => ({ type: "user", sessionId, timestamp: "2026-08-29T01:10:00Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: JSON.stringify(value) }] } });
  return [
    { type: "user", sessionId, cwd: "/tmp/workflow-project", timestamp: "2026-08-29T01:00:00Z", message: { role: "user", content: "请检查工作线来源。" } },
    ...(launched ? [call("launch", "run /tmp/plan.js"), result("launch", { runId: "run-1", pid: 123 })] : []),
    call("status", "status run-1"),
    result("status", { version: 1, runId: "run-1", status: "completed",
      steps: { check: { id: "check", startedAt: "2026-08-29T01:01:00Z", status: "completed", threadId: "worker-1" } } }),
    { type: "assistant", sessionId, timestamp: "2026-08-29T01:10:00Z", message: { role: "assistant", content: "检查结束，等待验收。" } }
  ];
}

export async function writeWorkflowFixture(root: string) {
  const roots = [path.join(root, "claude"), path.join(root, "codex")];
  for (const directory of roots) await mkdir(directory, { recursive: true });
  const write = async (file: string, records: unknown[]) => {
    await writeFile(file, records.map(value => JSON.stringify(value)).join("\n") + "\n");
    await utimes(file, new Date("2026-08-29T02:00:00Z"), new Date("2026-08-29T02:00:00Z"));
  };
  const parentPath = path.join(roots[0]!, "parent.jsonl");
  await write(parentPath, claudeWorkflowRecords());
  for (const [id, source] of [
    ["worker-1", "exec"],
    ["native-child", { subagent: { thread_spawn: { parent_thread_id: "worker-1" } } }],
    ["unrelated", "exec"]
  ] as const) {
    await write(path.join(roots[1]!, id + ".jsonl"), [
      { type: "session_meta", timestamp: "2026-08-29T01:01:00Z", payload: { id, source, cwd: "/tmp/workflow-project" } },
      { type: "response_item", timestamp: "2026-08-29T01:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "检查会话来源。" }] } },
      { type: "response_item", timestamp: "2026-08-29T01:09:00Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已完成来源检查。" }] } }
    ]);
  }
  return { roots, parentPath, write };
}
