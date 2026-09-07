// The daily workline review is not exported from backend/index.mjs, so the CLI never
// runs it. It is still part of the shared backend snapshot this branch modified, so
// its Cursor branch is covered here rather than left to the App to discover.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileDailyWorklineReview } from '../backend/upstream/src/workline-review.ts';
import { DEFAULT_SETTINGS } from '../backend/upstream/src/constants.ts';

const logicalDate = '2026-09-07';

function session() {
  return {
    id: 'cursor-session-1',
    platform: 'cursor',
    title: 'Cursor 会话',
    summary: '摘要',
    artifacts: [],
    status: 'active',
    path: '/tmp/cursor/session.jsonl',
    updatedAt: '2026-09-07T02:00:00.000Z',
    startedAt: '2026-09-07T01:00:00.000Z',
    transcriptCapture: {
      canonicalPath: '/tmp/cursor/session.jsonl',
      sha256: 'a'.repeat(64),
      byteLength: 10,
      coverage: { startByte: 0, endByte: 10 }
    }
  };
}

// Freeze without touching the real transcript: this test is about provider dispatch.
async function frozenRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workline-review-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return (sessions, use) => use(sessions.map(s => ({ ...s, path: path.join(root, 'frozen.jsonl'), artifacts: [] })), root);
}

async function capture(t, enabledSessionProviders) {
  const calls = [];
  await assert.rejects(compileDailyWorklineReview(
    { ...DEFAULT_SETTINGS, enabledSessionProviders },
    logicalDate,
    [session()],
    {
      transcriptFreezer: await frozenRoot(t),
      runner: async request => { calls.push(request); throw new Error('provider offline'); }
    }
  ), /CLI 调用失败/);
  return calls;
}

test('a Cursor-only review compiles with Cursor Agent CLI', async t => {
  const [call, ...rest] = await capture(t, ['cursor']);
  assert.equal(rest.length, 0, 'nothing else is enabled to fall back to');
  assert.equal(call.command, DEFAULT_SETTINGS.cursorCliPath);
  assert.deepEqual(call.args, ['--print', '--output-format', 'json', '--mode', 'ask', '--trust', '--sandbox', 'enabled']);
  assert.equal(call.stdoutMode, 'single-json');
  assert.match(call.stdin, /Return one JSON object satisfying this JSON Schema/);
  assert.match(call.stdin, /"worklines"/, 'the schema travels inline, not as a file path');
  assert.doesNotMatch(call.stdin, /schema\.json/);
});

test('a Cursor-only review leaves the model to the account default', async t => {
  const [call] = await capture(t, ['cursor']);
  assert.ok(!call.args.includes('--model'));
});

test('Cursor joins the fallback order behind Codex and Claude Code', async t => {
  const calls = await capture(t, ['codex', 'claude', 'cursor']);
  assert.deepEqual(
    calls.map(call => call.command),
    [DEFAULT_SETTINGS.codexCliPath, DEFAULT_SETTINGS.claudeCliPath, DEFAULT_SETTINGS.cursorCliPath]
  );
});

test('the Claude Code arguments no longer carry the removed --safe-mode flag', async t => {
  const [call] = await capture(t, ['claude']);
  assert.ok(!call.args.includes('--safe-mode'), 'the flag was removed from Claude Code and now exits non-zero');
  assert.ok(call.args.includes('--json-schema'));
  assert.ok(call.args.includes('--no-session-persistence'));
});
