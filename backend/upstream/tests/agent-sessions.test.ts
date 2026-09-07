import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractWorkSessionFromText, loadAgentWorkSnapshot, type RuntimeFileSystem } from "../src/agent-sessions";
import { createEmptyData } from "../src/state";

const fsAdapter: RuntimeFileSystem = {
  stat,
  readdir,
  async readFile(filePath: string, encoding: "utf8") {
    return readFile(filePath, encoding);
  },
  async readBytes(filePath: string) {
    return readFile(filePath);
  },
  realpath
};

test("JSON event metadata never becomes a title, and middle/event-only messages remain discoverable", () => {
  const metadata = { timestamp: "2026-09-07T00:00:32.135Z", type: "session_meta", payload: { id: "session-1", cwd: "/tmp/project" } };
  const file = "/tmp/codex/rollout-session-1.jsonl";
  const extract = (text: string) => extractWorkSessionFromText(text, file, "codex", metadata.timestamp)!;
  for (const text of [JSON.stringify(metadata), JSON.stringify(metadata, null, 2), JSON.stringify(metadata) + '\n{"type":']) {
    assert.equal(extract(text).title, "rollout-session-1");
    assert.doesNotMatch(extract(text).summary, /timestamp|session_meta/);
  }
  const records: unknown[] = [metadata, ...Array.from({ length: 2100 }, () => ({ type: "response_item", payload: { type: "function_call_output", output: "tool output" } }))];
  records.splice(150, 0, { type: "event_msg", payload: { type: "user_message", message: "修复会话原文读取" } });
  const text = records.map(record => JSON.stringify(record)).join('\n');
  assert.equal(extract(text).title, "修复会话原文读取");
  assert.equal(extract(text + '\n{"type":').id, "session-1");
  assert.equal(extractWorkSessionFromText(JSON.stringify({ type: "user", message: { content: "没有显式 role 的 Claude 输入" } }), "/tmp/claude/session.jsonl", "claude", metadata.timestamp)?.title, "没有显式 role 的 Claude 输入");
});

test("Copilot discovery uses events.jsonl and canonical session.start identity and context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-copilot-"));
  try {
    const root = path.join(dir, ".copilot/session-state");
    const sessionDir = path.join(root, "path-is-not-session-id");
    await mkdir(sessionDir, { recursive: true });
    const date = "2026-09-07";
    const timestamp = new Date(`${date}T12:00:00`).toISOString();
    const content = [
      { type: "session.start", id: "event-id", timestamp, data: { sessionId: "copilot-session", context: { cwd: "/tmp/project", branch: "feature/copilot" } } },
      { type: "user.message", timestamp, data: { content: "读取 Copilot 会话", source: "user", transformedContent: "hidden host instructions" } },
      { type: "assistant.message", timestamp, data: { content: "已读取会话正文。" } }
    ].map(record => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(path.join(sessionDir, "events.jsonl"), content);
    await writeFile(path.join(sessionDir, "other.jsonl"), content);
    await utimes(path.join(sessionDir, "events.jsonl"), new Date(timestamp), new Date(timestamp));
    await utimes(path.join(sessionDir, "other.jsonl"), new Date(timestamp), new Date(timestamp));
    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, { date, homeDir: dir, providers: ["copilot"], fs: fsAdapter });
    assert.equal(snapshot.sessions.length, 1);
    const session = snapshot.sessions[0]!;
    assert.equal(session.platform, "copilot");
    assert.equal(session.id, "copilot-session");
    assert.equal(session.title, "读取 Copilot 会话");
    assert.equal(session.summary, "已读取会话正文。");
    assert.equal(session.projectPath, "/tmp/project");
    assert.equal(session.branch, "feature/copilot");
    assert.equal(session.resumeHint, "copilot --resume=copilot-session");
    assert.equal(session.transcriptCapture?.byteLength, Buffer.byteLength(content));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("extracts Codex JSONL sessions with resume hints", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-07-02T08:00:00.000Z",
      type: "session_meta",
      payload: { session_id: "parent-session", id: "codex-thread-1", cwd: "/workspace/project" }
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "实现昨日工作会话看板" }]
      }
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "完成本地扫描器、会话区 UI 和导出字段。" }]
      }
    })
  ].join("\n");

  const session = extractWorkSessionFromText(
    content,
    "/tmp/codex/rollout-2026-07-02.jsonl",
    "codex",
    "2026-07-02T08:30:00.000Z"
  );

  assert.equal(session?.id, "codex-thread-1");
  assert.equal(session?.title, "实现昨日工作会话看板");
  assert.equal(session?.projectPath, "/workspace/project");
  assert.equal(session?.resumeHint, "codex resume codex-thread-1");
  assert.equal(session?.resumable, true);
});

test("preserves Codex subagent lineage instead of treating a child transcript as a primary Session", () => {
  const content = [
    JSON.stringify({
      timestamp: "2026-08-30T03:31:02.892Z",
      type: "session_meta",
      payload: {
        id: "child-thread",
        parent_thread_id: "root-thread",
        thread_source: "subagent",
        source: { subagent: { thread_spawn: {
          parent_thread_id: "root-thread",
          agent_path: "/root/radar_pipeline",
          agent_nickname: "Confucius",
          agent_role: "worker"
        } } }
      }
    }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "执行雷达子任务" }] } })
  ].join("\n");
  const session = extractWorkSessionFromText(content, "/tmp/child.jsonl", "codex", "2026-08-30T04:00:00.000Z");
  assert.deepEqual(session?.lineage, {
    origin: "subagent",
    parentSessionId: "root-thread",
    agentPath: "/root/radar_pipeline",
    agentNickname: "Confucius",
    agentRole: "worker"
  });
});

test("Codex archived sessions are completed and model summaries cannot reopen them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-archive-"));
  const archive = path.join(root, ".codex", "archived_sessions");
  await mkdir(archive, { recursive: true });
  const sessionPath = path.join(archive, "rollout-archived.jsonl");
  await writeFile(sessionPath, [
    JSON.stringify({ timestamp: "2026-07-21T04:00:00.000Z", type: "session_meta", payload: { id: "archived-id", cwd: root } }),
    JSON.stringify({ timestamp: "2026-07-21T04:01:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "归档这条会话" }] } })
  ].join("\n"));
  await utimes(sessionPath, new Date("2026-07-21T04:01:00.000Z"), new Date("2026-07-21T04:01:00.000Z"));
  try {
    const settings = { ...createEmptyData().settings, sessionScanRoots: [archive], enabledSessionProviders: ["codex" as const] };
    const snapshot = await loadAgentWorkSnapshot(settings, {
      date: "2026-07-21",
      fs: fsAdapter,
      homeDir: root,
      summarizer: async () => ({ summaries: [{ id: "archived-id", platform: "codex", title: "模型标题", summary: "模型认为仍在进行。", artifacts: [], status: "active" }], warnings: [] })
    });
    assert.equal(snapshot.sessions[0]?.status, "completed");
    assert.equal(snapshot.sessions[0]?.title, "模型标题");
    assert.match(snapshot.sessions[0]?.transcriptCapture?.sha256 ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts current Claude Code session metadata and nested messages", () => {
  const content = [
    JSON.stringify({ type: "mode", mode: "default", sessionId: "16d0cc2d-b022-4205-863d-3924305c92f9" }),
    JSON.stringify({
      type: "user",
      sessionId: "16d0cc2d-b022-4205-863d-3924305c92f9",
      cwd: "/workspace/feature-worktree",
      timestamp: "2026-07-02T09:00:00.000Z",
      message: { role: "user", content: "修复会话恢复按钮" }
    }),
    JSON.stringify({
      type: "ai-title",
      sessionId: "16d0cc2d-b022-4205-863d-3924305c92f9",
      aiTitle: "修复会话恢复按钮"
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "16d0cc2d-b022-4205-863d-3924305c92f9",
      cwd: "/workspace/feature-worktree",
      message: { role: "assistant", content: [{ type: "text", text: "按钮已接入真实 session id。" }] }
    })
  ].join("\n");

  const session = extractWorkSessionFromText(
    content,
    "/tmp/.claude/projects/project/16d0cc2d-b022-4205-863d-3924305c92f9.jsonl",
    "claude",
    "2026-07-02T10:00:00.000Z"
  );

  assert.equal(session?.id, "16d0cc2d-b022-4205-863d-3924305c92f9");
  assert.equal(session?.title, "修复会话恢复按钮");
  assert.equal(session?.summary, "按钮已接入真实 session id。");
  assert.equal(session?.projectPath, "/workspace/feature-worktree");
  assert.equal(session?.resumeHint, "claude --resume 16d0cc2d-b022-4205-863d-3924305c92f9");
  assert.equal(session?.resumable, true);
});

test("uses only provider-owned metadata for resume identity and cwd", () => {
  const claude = extractWorkSessionFromText(
    [
      JSON.stringify({ type: "user", message: { sessionId: "nested-untrusted", cwd: "/tmp/untrusted" } }),
      JSON.stringify({
        type: "user",
        sessionId: "canonical-session",
        cwd: "/tmp/trusted-worktree",
        message: { role: "user", content: "继续可信会话" }
      })
    ].join("\n"),
    "/tmp/.claude/projects/project/canonical-session.jsonl",
    "claude",
    "2026-07-02T10:00:00.000Z"
  );
  const codex = extractWorkSessionFromText(
    JSON.stringify({ type: "response_item", payload: { root: "/tmp/untrusted", id: "nested-untrusted" } }),
    "/tmp/.codex/sessions/rollout-019f1111-2222-7333-8444-555555555555.jsonl",
    "codex",
    "2026-07-02T10:00:00.000Z"
  );

  assert.equal(claude?.id, "canonical-session");
  assert.equal(claude?.projectPath, "/tmp/trusted-worktree");
  assert.equal(codex?.resumable, false);
  assert.notEqual(codex?.id, "019f1111-2222-7333-8444-555555555555");
  assert.equal(codex?.projectPath, undefined);
});

test("a UUID in a Claude task path does not create a resumable session", () => {
  const session = extractWorkSessionFromText(
    JSON.stringify({ subject: "旧任务记录", description: "没有平台会话元数据" }),
    "/tmp/.claude/tasks/019f1111-2222-7333-8444-555555555555/task.jsonl",
    "claude",
    "2026-07-02T10:00:00.000Z"
  );
  assert.equal(session?.resumable, false);
  assert.notEqual(session?.id, "019f1111-2222-7333-8444-555555555555");
});

test("scans yesterday Codex and Claude files from configured local roots", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-sessions-"));
  const codexRoot = path.join(temp, "codex");
  const claudeRoot = path.join(temp, "claude", "projects");
  const targetTime = new Date("2026-07-02T14:30:00.000Z");

  try {
    await mkdir(codexRoot, { recursive: true });
    await mkdir(path.join(claudeRoot, "project-a"), { recursive: true });
    const codexFile = path.join(codexRoot, "rollout-2026-07-02.jsonl");
    const claudeFile = path.join(claudeRoot, "project-a", "session.jsonl");
    await writeFile(
      codexFile,
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "codex-yesterday", cwd: "/tmp/project" } }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ text: "整理昨日 Codex 工作" }] }
        })
      ].join("\n")
    );
    await writeFile(
      claudeFile,
      JSON.stringify({
        sessionId: "claude-task-1",
        subject: "等 batch v2 完成 + 报告 final",
        description: "读 best/alpha_search_v2_*.json 找 ann>15% alpha。",
        status: "completed",
        cwd: "/tmp/claude-project"
      })
    );
    await utimes(codexFile, targetTime, targetTime);
    await utimes(claudeFile, targetTime, targetTime);

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T09:00:00.000Z"),
      roots: [codexRoot, claudeRoot],
      fs: fsAdapter,
      maxFiles: 10,
      maxSessions: 10
    });

    assert.equal(snapshot.date, "2026-07-02");
    assert.equal(snapshot.sessions.length, 2);
    assert.ok(snapshot.sessions.some((session) => session.platform === "codex" && session.resumeHint === "codex resume codex-yesterday"));
    assert.ok(snapshot.sessions.some((session) => session.platform === "claude" && session.title.includes("等 batch v2 完成")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("scanner captures the canonical transcript hash, byte length, and complete byte coverage", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-evidence-capture-"));
  const realRoot = path.join(temp, "real-sessions");
  const root = path.join(temp, ".codex", "sessions");
  const sessionPath = path.join(realRoot, "rollout-2026-07-02.jsonl");
  const content = [
    JSON.stringify({ timestamp: "2026-07-02T09:00:00.000Z", type: "session_meta", payload: { id: "capture-id" } }),
    JSON.stringify({
      timestamp: "2026-07-02T09:01:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "冻结这段证据" }] }
    })
  ].join("\n");

  try {
    await mkdir(realRoot, { recursive: true });
    await mkdir(path.dirname(root), { recursive: true });
    await symlink(realRoot, root, "dir");
    await writeFile(sessionPath, content);
    const targetTime = new Date("2026-07-02T10:00:00.000Z");
    await utimes(sessionPath, targetTime, targetTime);

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [root],
      fs: fsAdapter
    });
    const session = snapshot.sessions[0] as (typeof snapshot.sessions)[number] & {
      transcriptCapture?: {
        canonicalPath: string;
        sha256: string;
        byteLength: number;
        coverage: { startByte: number; endByte: number };
      };
    };

    assert.equal(session.path, await realpath(sessionPath));
    assert.deepEqual(session.transcriptCapture, {
      canonicalPath: await realpath(sessionPath),
      sha256: "da66d7a01759dbfbceace356dc1f2d87976249c58fb22c5afe79245986b587be",
      byteLength: 261,
      coverage: { startByte: 0, endByte: 261 }
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("scanner reports a discovered transcript that cannot be captured instead of silently omitting it", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-evidence-warning-"));
  const root = path.join(temp, ".codex", "sessions");
  const goodPath = path.join(root, "good-2026-07-02.jsonl");
  const badPath = path.join(root, "bad-2026-07-02.jsonl");
  const targetTime = new Date("2026-07-02T10:00:00.000Z");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(goodPath, JSON.stringify({ timestamp: "2026-07-02T09:00:00.000Z", type: "session_meta", payload: { id: "good" } }));
    await writeFile(badPath, JSON.stringify({ timestamp: "2026-07-02T09:00:00.000Z", type: "session_meta", payload: { id: "bad" } }));
    await utimes(goodPath, targetTime, targetTime);
    await utimes(badPath, targetTime, targetTime);
    const canonicalBadPath = await realpath(badPath);

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [root],
      fs: {
        ...fsAdapter,
        async readBytes(target) {
          if (target === canonicalBadPath) throw new Error("permission denied");
          return readFile(target);
        }
      }
    });

    assert.deepEqual(snapshot.sessions.map((item) => item.id), ["good"]);
    assert.match(snapshot.warnings.join(" "), /bad-2026-07-02\.jsonl/);
    assert.match(snapshot.warnings.join(" "), /permission denied/);
    assert.ok(snapshot.evidenceCoverage?.some((entry) =>
      entry.sourceId.endsWith("bad-2026-07-02.jsonl") &&
      entry.disposition === "failed" &&
      entry.detail.includes("permission denied")
    ));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("scanner records read, skipped, deduplicated, and truncated evidence dispositions", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-evidence-coverage-"));
  const root = path.join(temp, ".codex", "sessions");
  const targetTime = new Date("2026-07-02T10:00:00.000Z");
  const event = (id: string, timestamp = "2026-07-02T09:00:00.000Z") => [
    JSON.stringify({ timestamp, type: "session_meta", payload: { id } }),
    JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: id }] } })
  ].join("\n");

  try {
    await mkdir(root, { recursive: true });
    const files = [
      ["01-good.jsonl", event("shared-id")],
      ["02-duplicate.jsonl", event("shared-id")],
      ["03-outside.jsonl", event("outside", "2026-07-01T09:00:00.000Z")],
      ["04-over-limit.jsonl", event("over-limit")],
      ["05-over-limit.jsonl", event("over-limit-two")]
    ] as const;
    for (const [index, [name, content]] of files.entries()) {
      const target = path.join(root, name);
      await writeFile(target, content);
      const rankedTime = new Date(targetTime.getTime() - index * 1_000);
      await utimes(target, rankedTime, rankedTime);
    }

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      date: "2026-07-02",
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [root],
      fs: fsAdapter,
      maxFiles: 4,
      maxSessions: 10
    });

    const dispositions = snapshot.evidenceCoverage?.map((entry) => entry.disposition) ?? [];
    assert.ok(dispositions.includes("read"));
    assert.ok(dispositions.includes("deduplicated"));
    assert.ok(dispositions.includes("skipped"));
    assert.ok(dispositions.includes("truncated"));
    assert.ok(snapshot.evidenceCoverage?.some((entry) => entry.detail.includes("规范副本")));
    assert.equal(snapshot.evidenceScope?.evidenceCutoff, "2026-07-03T12:00:00.000Z");
    assert.equal(snapshot.evidenceScope?.timeZone.length ? true : false, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("scanner records discovery failures and Session-cap omissions as incomplete coverage", async () => {
  const settings = createEmptyData().settings;
  const missingRoot = "/tmp/.codex/traceink-missing-root";
  const failed = await loadAgentWorkSnapshot(settings, {
    date: "2026-07-02",
    now: new Date("2026-07-03T12:00:00.000Z"),
    roots: [missingRoot],
    fs: {
      ...fsAdapter,
      async readdir() {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
    }
  });
  assert.deepEqual(failed.sessions, []);
  assert.ok(failed.evidenceCoverage?.some((entry) =>
    entry.sourceId.endsWith(missingRoot) &&
    entry.disposition === "failed" &&
    entry.detail.includes("permission denied")
  ));

  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-session-cap-"));
  try {
    const root = path.join(temp, ".codex", "sessions");
    await mkdir(root, { recursive: true });
    for (const [index, id] of ["first", "second"].entries()) {
      const file = path.join(root, `${index}-${id}.jsonl`);
      await writeFile(file, JSON.stringify({ timestamp: "2026-07-02T09:00:00.000Z", type: "session_meta", payload: { id } }));
      const ranked = new Date(`2026-07-02T10:00:0${index}.000Z`);
      await utimes(file, ranked, ranked);
    }
    const capped = await loadAgentWorkSnapshot(settings, {
      date: "2026-07-02",
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [root],
      fs: fsAdapter,
      maxSessions: 1
    });
    assert.equal(capped.sessions.length, 1);
    assert.ok(capped.evidenceCoverage?.some((entry) =>
      entry.disposition === "truncated" && entry.detail.includes("Session 容量上限")
    ));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("descends the Codex year/month/day hierarchy even when parent directory mtimes are newer", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-codex-tree-"));
  const root = path.join(temp, ".codex", "sessions");
  const dayDir = path.join(root, "2026", "07", "02");
  const file = path.join(dayDir, "rollout-2026-07-02T09-00-00-019f1111-2222-7333-8444-555555555555.jsonl");
  try {
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        type: "session_meta",
        payload: { id: "019f1111-2222-7333-8444-555555555555", cwd: "/tmp/project" }
      })
    );
    await utimes(file, new Date("2026-07-02T09:00:00.000Z"), new Date("2026-07-02T09:00:00.000Z"));
    for (const directory of [root, path.join(root, "2026"), path.join(root, "2026", "07")]) {
      await utimes(directory, new Date("2026-07-03T09:00:00.000Z"), new Date("2026-07-03T09:00:00.000Z"));
    }

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [root],
      fs: fsAdapter
    });
    assert.equal(snapshot.sessions[0]?.id, "019f1111-2222-7333-8444-555555555555");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("keeps a cross-midnight Codex session eligible for target-day provider analysis", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-cross-midnight-"));
  const root = path.join(temp, ".codex", "sessions");
  const oldDayDir = path.join(root, "2026", "06", "30");
  const file = path.join(oldDayDir, "rollout-2026-06-30T09-00-00-019f1111-2222-7333-8444-666666666666.jsonl");
  const todayOnlyFile = path.join(
    oldDayDir,
    "rollout-2026-06-30T10-00-00-019f1111-2222-7333-8444-777777777777.jsonl"
  );
  try {
    await mkdir(oldDayDir, { recursive: true });
    await writeFile(
      file,
      [
        JSON.stringify({
          timestamp: "2026-06-30T09:00:00.000Z",
          type: "session_meta",
          payload: { id: "019f1111-2222-7333-8444-666666666666", cwd: "/tmp/project" }
        }),
        JSON.stringify({ timestamp: "2026-07-02T10:00:00.000Z", type: "event_msg", payload: { type: "task_started" } })
      ].join("\n")
    );
    await writeFile(
      todayOnlyFile,
      [
        JSON.stringify({
          timestamp: "2026-06-30T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "019f1111-2222-7333-8444-777777777777", cwd: "/tmp/project" }
        }),
        JSON.stringify({ timestamp: "2026-07-03T02:00:00.000Z", type: "event_msg", payload: { type: "task_started" } })
      ].join("\n")
    );
    await utimes(file, new Date("2026-07-03T01:00:00.000Z"), new Date("2026-07-03T01:00:00.000Z"));
    await utimes(todayOnlyFile, new Date("2026-07-03T02:00:00.000Z"), new Date("2026-07-03T02:00:00.000Z"));
    await utimes(oldDayDir, new Date("2026-06-30T09:00:00.000Z"), new Date("2026-06-30T09:00:00.000Z"));

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T04:00:00.000Z"),
      roots: [root],
      fs: fsAdapter
    });

    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0]?.id, "019f1111-2222-7333-8444-666666666666");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("recognizes a Git worktree without replacing its canonical cwd", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-worktree-"));
  const root = path.join(temp, "codex-sessions");
  const worktree = path.join(temp, "repo-worktrees", "resume fix");
  const mainRepo = path.join(temp, "repo");
  const file = path.join(root, "session.jsonl");
  try {
    await mkdir(root, { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${mainRepo}/.git/worktrees/resume-fix\n`);
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "worktree-session", cwd: worktree } })
    );
    await utimes(file, new Date("2026-07-02T09:00:00.000Z"), new Date("2026-07-02T09:00:00.000Z"));

    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [root],
      fs: fsAdapter
    });
    assert.equal(snapshot.sessions[0]?.projectPath, worktree);
    assert.equal(snapshot.sessions[0]?.worktreePath, worktree);
    assert.equal(snapshot.sessions[0]?.repositoryPath, mainRepo);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("merges model summaries without allowing canonical paths or ids to change", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-summary-merge-"));
  const file = path.join(temp, "rollout.jsonl");
  try {
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id: "canonical-id", cwd: "/trusted/worktree" } })
    );
    await utimes(file, new Date("2026-07-02T09:00:00.000Z"), new Date("2026-07-02T09:00:00.000Z"));
    const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots: [path.join(temp, "codex")],
      fs: {
        ...fsAdapter,
        async readdir(target) {
          if (target === path.join(temp, "codex")) return ["rollout.jsonl"];
          return readdir(target);
        },
        async stat(target) {
          if (target === path.join(temp, "codex", "rollout.jsonl")) return stat(file);
          return stat(target);
        },
        async readFile(target, encoding) {
          if (target === path.join(temp, "codex", "rollout.jsonl")) return readFile(file, encoding);
          return readFile(target, encoding);
        },
        async readBytes(target) {
          if (target === path.join(temp, "codex", "rollout.jsonl") || target === await realpath(file)) return readFile(file);
          return readFile(target);
        },
        async realpath(target) {
          if (target === path.join(temp, "codex", "rollout.jsonl")) return realpath(file);
          return realpath(target);
        }
      },
      summarizer: async () => ({
        summaries: [
          {
            id: "canonical-id",
            platform: "codex",
            title: "Agent 生成标题",
            summary: "Agent 生成摘要",
            artifacts: ["src/main.ts", "canonical-id", ".git", ".agents", file],
            status: "active"
          }
        ],
        warnings: []
      })
    });

    assert.equal(snapshot.sessions[0]?.title, "Agent 生成标题");
    assert.equal(snapshot.sessions[0]?.id, "canonical-id");
    assert.equal(snapshot.sessions[0]?.projectPath, "/trusted/worktree");
    assert.deepEqual(snapshot.sessions[0]?.artifacts, ["src/main.ts"]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("missing session roots return an empty snapshot", async () => {
  const snapshot = await loadAgentWorkSnapshot(createEmptyData().settings, {
    now: new Date("2026-07-03T09:00:00.000Z"),
    roots: ["/tmp/agent-notebook-missing-root"],
    fs: fsAdapter
  });

  assert.equal(snapshot.date, "2026-07-02");
  assert.equal(snapshot.sessions.length, 0);
});

test("provider selection supports both, either provider, and neither", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "agent-notebook-provider-selection-"));
  const codexRoot = path.join(temp, ".codex", "sessions");
  const claudeRoot = path.join(temp, ".claude", "projects", "project-a");
  const roots = [path.dirname(claudeRoot), codexRoot];
  const targetTime = new Date("2026-07-02T09:00:00.000Z");
  try {
    await mkdir(codexRoot, { recursive: true });
    await mkdir(claudeRoot, { recursive: true });
    const codexFile = path.join(codexRoot, "rollout.jsonl");
    const claudeFile = path.join(claudeRoot, "session.jsonl");
    await writeFile(codexFile, JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-provider-test", cwd: "/tmp/codex-project" }
    }));
    await writeFile(claudeFile, JSON.stringify({
      type: "user",
      sessionId: "claude-provider-test",
      cwd: "/tmp/claude-project",
      message: { role: "user", content: "验证平台选择" }
    }));
    await utimes(codexFile, targetTime, targetTime);
    await utimes(claudeFile, targetTime, targetTime);

    const scan = (providers: Array<"codex" | "claude">) => loadAgentWorkSnapshot(createEmptyData().settings, {
      now: new Date("2026-07-03T12:00:00.000Z"),
      roots,
      providers,
      fs: fsAdapter
    });
    const [both, codexOnly, claudeOnly, neither] = await Promise.all([
      scan(["codex", "claude"]),
      scan(["codex"]),
      scan(["claude"]),
      scan([])
    ]);

    assert.deepEqual(new Set(both.sessions.map(({ platform }) => platform)), new Set(["codex", "claude"]));
    assert.deepEqual(codexOnly.sessions.map(({ platform }) => platform), ["codex"]);
    assert.deepEqual(claudeOnly.sessions.map(({ platform }) => platform), ["claude"]);
    assert.deepEqual(neither.sessions, []);
    assert.deepEqual(neither.sources, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("historical date discovery precedes newer files and exposes discovery truncation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-discovery-"));
  try {
    const scanRoot = path.join(root, "codex", "sessions");
    const oldDir = path.join(scanRoot, "2026", "08", "29");
    const newDir = path.join(scanRoot, "2026", "09", "05");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    const line = (date: string) => JSON.stringify({ type: "response_item", timestamp: new Date(`${date}T12:00:00`).toISOString(), payload: { type: "message", role: "user", content: "target activity" } });
    const oldFile = path.join(oldDir, "old.jsonl");
    const oldTime = new Date("2026-08-29T12:00:00");
    const newTime = new Date("2026-09-05T12:00:00");
    await writeFile(oldFile, line("2026-08-29"));
    await utimes(oldFile, oldTime, oldTime);
    await Promise.all(Array.from({ length: 180 }, async (_, i) => {
      const file = path.join(newDir, `new-${i}.jsonl`);
      await writeFile(file, line("2026-09-05"));
      await utimes(file, newTime, newTime);
    }));
    const snapshot = await loadAgentWorkSnapshot({ ...createEmptyData().settings, sessionScanRoots: [scanRoot], enabledSessionProviders: ["codex"] },
      { date: "2026-08-29", now: new Date("2026-09-06T12:00:00Z"), fs: fsAdapter, maxFiles: 180, maxDepth: 5, maxEntries: 2400 });
    assert.equal(snapshot.sessions.length, 1);
    assert.ok(snapshot.sessions[0]!.path.endsWith("old.jsonl"));
    assert.ok(snapshot.warnings.some((warning) => warning.includes("发现范围不完整")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
