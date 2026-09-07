import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brief, validateDate } from '../src/service.mjs';
import { render } from '../src/presentation.mjs';
import { loadAgentWorkSnapshot, DEFAULT_SETTINGS, TraceinkAssetRepository, NodeSqliteSaver, StructuredTodayRuntimeStore, runStructuredTodayIndexPreparation, loadTraceinkSkillBundle } from '../dist/backend.mjs';
import { structuredRunner } from './model-fixture.mjs';

const date = '2026-08-29';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'codex');
  await fs.mkdir(root);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, [
    { type: 'session_meta', payload: { id: 'session-1', cwd: dir } },
    { type: 'response_item', timestamp: '2026-08-29T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '重构 Today 后端。' }] } },
    { type: 'response_item', timestamp: '2026-08-29T01:10:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '实现结构化 workflow。' }] } }
  ].map(JSON.stringify).join('\n'));
  await fs.utimes(file, new Date('2026-08-29T02:00:00Z'), new Date('2026-08-29T02:00:00Z'));
  const options = { date, roots: [root], source: 'codex', dataDir: path.join(dir, 'cli') };
  return { dir, root, file, options };
}

test('CLI uses identical App workflow, evidence, contract, model stages and saved artifacts', async t => {
  const f = await fixture(t);
  const calls = [];
  const delegate = structuredRunner();
  const runner = async req => { calls.push(req); return delegate(req); };
  const view = await brief(f.options, { runner });
  assert.equal(view.mode, 'compiled');
  assert.equal(view.index.schema, 'today-workline-index/v1');
  assert.equal(calls.length, 2, 'one family digest then synthesis, not a replacement one-shot prompt');
  assert.ok(calls[0].stdin.includes('Digest exactly one'));
  assert.ok(calls[1].stdin.includes('Reconstruct cross-Session'));
  const bundle = await loadTraceinkSkillBundle();
  assert.ok(calls[0].stdin.includes(bundle.editorialContractHash));
  const snapshot = await loadAgentWorkSnapshot({ ...DEFAULT_SETTINGS, sessionScanRoots: [f.root], enabledSessionProviders: ['codex'] }, {
    date, fs: { stat: fs.stat, readdir: fs.readdir, readFile: fs.readFile, readBytes: fs.readFile, realpath: fs.realpath }
  });
  assert.equal(snapshot.sessions.length, 1);
  const repository = new TraceinkAssetRepository(path.join(f.dir, 'direct.json'));
  const checkpointer = NodeSqliteSaver.fromConnectionString(':memory:');
  const runtimeStore = new StructuredTodayRuntimeStore(':memory:');
  t.after(() => checkpointer.close());
  t.after(() => runtimeStore.close());
  const direct = await runStructuredTodayIndexPreparation({ logicalDate: date, snapshot, settings: { ...DEFAULT_SETTINGS, enabledSessionProviders: ['codex'] }, repository, checkpointer, runtimeStore, runner: delegate });
  for (const key of ['worklines', 'evidence', 'coverage', 'sessions']) assert.deepEqual(view.index[key], direct.artifact[key], key);
  assert.deepEqual(view.index.dispositions.map(({ nodeOutputId, ...d }) => d), direct.artifact.dispositions.map(({ nodeOutputId, ...d }) => d));
  const reopened = await brief(f.options, { runner: async () => { throw new Error('must not call model'); } });
  assert.deepEqual(reopened.index, view.index);
  const stored = JSON.parse(await fs.readFile(path.join(view.dataDir, 'traceink-assets-v1.json'), 'utf8'));
  assert.equal(stored.structuredIndexes[0].contentHash, view.index.contentHash);
  const dossier = await brief({ ...f.options, workline: '1' }, { runner });
  assert.equal(calls.length, 5, 'selected dossier uses the App analysis/critique/compose stages');
  assert.equal(dossier.dossier.worklineId, view.index.worklines[0].worklineId);
  assert.deepEqual(JSON.parse(render(view, 'json')).index, view.index);
  assert.match(render(dossier, 'markdown'), /留给你的问题/);
});

test('failed refresh preserves published revision and releases lock', async t => {
  const f = await fixture(t);
  const original = await brief(f.options, { runner: structuredRunner() });
  await assert.rejects(brief({ ...f.options, refresh: true }, { runner: async () => { throw new Error('provider offline'); } }));
  const saved = await brief({ ...f.options, readOnly: true }, { runner: async () => assert.fail('read only called model') });
  assert.equal(saved.index.contentHash, original.index.contentHash);
  await assert.rejects(fs.access(path.join(saved.dataDir, 'writer.lock')));
});

test('CLI read-only JSON uses original scanner and does not fabricate a summary', async t => {
  const f = await fixture(t);
  const output = execFileSync(process.execPath, ['src/cli.mjs', 'brief', '--date', date, '--root', f.root, '--source', 'codex', '--data-dir', path.join(f.dir, 'command'), '--read-only', '--format', 'json'], { encoding: 'utf8', stdio: 'pipe' });
  const view = JSON.parse(output);
  assert.equal(view.index, null);
  assert.equal(view.sessions[0].id, 'session-1');
  assert.equal(view.sessions[0].transcriptCapture.sha256, createHash('sha256').update(await fs.readFile(f.file)).digest('hex'));
  assert.equal(view.mode, 'raw');
  assert.match(execFileSync(process.execPath, ['src/cli.mjs'], { encoding: 'utf8' }), /Agent Note CLI/);
  assert.throws(() => validateDate('2026-02-30'));
});

test('exports stay clean without terminal controls or application chrome', () => {
  const view = { date, timeZone: 'UTC', mode: 'raw', sessions: [], index: null, dossier: null, warnings: ['\x1b[31mwarning\x1b[0m'], evidenceCoverage: [] };
  assert.ok(!render(view).includes('\x1b'));
  assert.ok(!render(view).includes('▄▀█'));
});

test('project selection preserves original backend families when child cwd differs', async t => {
  const f = await fixture(t);
  const snapshot = { date, generatedAt: new Date().toISOString(), warnings: [], sources: [], sessions: [
    { id: 'root', platform: 'codex', projectPath: '/work/app', updatedAt: '2026-08-29T01:00:00Z', path: '/codex/root.jsonl' },
    { id: 'child', platform: 'codex', projectPath: '/work/elsewhere', updatedAt: '2026-08-29T01:00:00Z', path: '/codex/child.jsonl', lineage: { origin: 'subagent', parentSessionId: 'root' } },
    { id: 'other', platform: 'codex', projectPath: '/work/apple', updatedAt: '2026-08-29T01:00:00Z', path: '/codex/other.jsonl' }
  ] };
  const view = await brief({ ...f.options, project: '/work/app', readOnly: true }, { scan: async () => structuredClone(snapshot) });
  assert.deepEqual(view.sessions.map(s => s.id).sort(), ['child', 'root']);
});

test('timezone scopes cannot reuse a different local day boundary', async t => {
  const f = await fixture(t);
  const invoke = zone => JSON.parse(execFileSync(process.execPath, ['src/cli.mjs', 'brief', '--date', date, '--root', f.root, '--source', 'codex', '--data-dir', f.options.dataDir, '--read-only', '--timezone', zone, '--format', 'json'], { encoding: 'utf8', stdio: 'pipe' }));
  assert.notEqual(invoke('UTC').dataDir, invoke('Asia/Shanghai').dataDir);
});

test('CLI reads Cursor transcripts as a first-class source', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-cursor-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionId = '2c0aa10b-d54b-461b-b06c-2a09f67d3192';
  const root = path.join(dir, 'cursor', 'projects', 'demo');
  const transcript = path.join(root, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, [
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Saturday, Aug 29, 2026, 9:00 AM (UTC+8)</timestamp>\n<user_query>\n把 Cursor 接进 brief\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '已把 Cursor transcript 当作会话来源。' }] } }
  ].map(JSON.stringify).join('\n'));
  await fs.utimes(transcript, new Date('2026-08-29T02:00:00Z'), new Date('2026-08-29T02:00:00Z'));
  const output = execFileSync(process.execPath, ['src/cli.mjs', 'brief', '--date', date, '--root', root, '--source', 'cursor', '--data-dir', path.join(dir, 'data'), '--read-only', '--format', 'json'], { encoding: 'utf8', stdio: 'pipe' });
  const view = JSON.parse(output);
  assert.equal(view.sessions[0].platform, 'cursor');
  assert.equal(view.sessions[0].id, sessionId);
  assert.equal(view.sessions[0].title, '把 Cursor 接进 brief');
  assert.equal(view.index, null);
});

async function cursorFixture(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `agent-note-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sessionId = '2c0aa10b-d54b-461b-b06c-2a09f67d3192';
  const root = path.join(dir, 'cursor', 'projects', 'demo');
  const transcript = path.join(root, 'agent-transcripts', sessionId, `${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, [
    { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Saturday, Aug 29, 2026, 9:00 AM (UTC+8)</timestamp>\n<user_query>\n把 Cursor 接进 brief\n</user_query>' }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: '已把 Cursor transcript 当作会话来源。' }] } }
  ].map(JSON.stringify).join('\n'));
  await fs.utimes(transcript, new Date('2026-08-29T02:00:00Z'), new Date('2026-08-29T02:00:00Z'));
  return { dir, root, sessionId, dataDir: path.join(dir, 'data') };
}

test('CLI compiles Cursor-only briefs with Cursor Agent CLI', async t => {
  const { root, sessionId, dataDir } = await cursorFixture(t, 'cursor-compile');
  const calls = [];
  const view = await brief({
    date,
    roots: [root],
    source: 'cursor',
    dataDir
  }, { runner: jsonEnvelopeRunner(calls) });
  assert.equal(view.mode, 'compiled');
  assert.equal(view.index.schema, 'today-workline-index/v1');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, 'agent');
  assert.deepEqual(calls[0].args.slice(0, 8), ['--print', '--output-format', 'json', '--mode', 'ask', '--trust', '--sandbox', 'enabled']);
  assert.equal(calls[0].stdoutMode, 'single-json');
  assert.match(calls[0].stdin, /Return one JSON object satisfying this JSON Schema/);
  assert.doesNotMatch(calls[0].stdin, /output\.schema\.json/);
  assert.ok(calls[0].stdin.includes('Digest exactly one'));
  assert.ok(calls[1].stdin.includes('Reconstruct cross-Session'));
  assert.equal(view.index.sessions[0].sessionId, sessionId);
});

test('--compiler reads one source but compiles with another provider CLI', async t => {
  const { root, dataDir } = await cursorFixture(t, 'cursor-compiler-override');
  const calls = [];
  const view = await brief({
    date,
    roots: [root],
    source: 'cursor',
    compiler: 'claude',
    dataDir
  }, { runner: jsonEnvelopeRunner(calls) });
  assert.equal(view.mode, 'compiled');
  assert.equal(view.sessions[0].platform, 'cursor', 'the scan still reads Cursor transcripts');
  assert.equal(calls[0].command, 'claude');
  assert.ok(calls[0].args.includes('--json-schema'), 'Claude Code enforces the schema over its own flag');
  assert.doesNotMatch(calls[0].stdin, /Return one JSON object satisfying this JSON Schema/);
});

test('--compiler rejects a provider outside the supported set', async t => {
  const { root, dataDir } = await cursorFixture(t, 'cursor-compiler-invalid');
  await assert.rejects(
    brief({ date, roots: [root], source: 'cursor', compiler: 'gemini', dataDir },
      { runner: async () => assert.fail('invalid compiler must not reach a CLI') }),
    /--compiler/
  );
});

// Claude Code and Cursor Agent CLI share the same result-envelope shape.
function jsonEnvelopeRunner(calls = []) {
  return async request => {
    calls.push(request);
    const variables = JSON.parse(request.stdin.split('VARIABLES:\n')[1] ?? '{}');
    const evidenceId = JSON.parse(variables.allowedEvidenceIdsJson ?? '[]')[0] ?? `session:cursor:${variables.expectedSessionId ?? 'session-1'}`;
    const sessionId = variables.expectedSessionId ?? JSON.parse(variables.allowedSessionIdsJson ?? '[]')[0] ?? 'session-1';
    let output;
    if (request.stdin.includes('Digest exactly one')) {
      output = {
        sessionId,
        summary: '完成 Cursor 编译路径。',
        currentStop: '等待接入 Today UI。',
        participation: { human: '用户确定方向。', agent: 'Agent 完成实现。' },
        evidenceIds: [evidenceId],
        uncertainties: []
      };
    } else if (request.stdin.includes('Reconstruct cross-Session')) {
      output = {
        worklines: [{
          worklineId: 'workline-cursor-today',
          title: 'Cursor 编译路径',
          summary: '把 Cursor Agent CLI 接到 Today 流程。',
          startedAt: '2026-08-29T01:00:00.000Z',
          endedAt: '2026-08-29T01:10:00.000Z',
          currentStop: '等待 UI 切换。',
          possibleChange: 'Cursor-only 来源可以独立整理。',
          participation: { human: '确定产品方向。', agent: '完成工程实现。' },
          evidenceReadiness: 'ready',
          sessionIds: [sessionId],
          evidenceIds: [evidenceId],
          extensions: []
        }],
        assignments: [{ sessionId, worklineIds: ['workline-cursor-today'] }],
        unresolvedSessionIds: []
      };
    } else {
      throw new Error(`Unexpected structured prompt: ${request.stdin.slice(0, 80)}`);
    }
    return {
      stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(output) }),
      stderr: ''
    };
  };
}
