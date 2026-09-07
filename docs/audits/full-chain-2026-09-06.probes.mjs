// Audit probes assert observed defects, not the desired fixed behavior.
// Run: node --import tsx --test docs/audits/full-chain-2026-09-06.probes.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { brief } from '../../src/service.mjs';
import { structuredRunner } from '../../test/model-fixture.mjs';
import { DEFAULT_SETTINGS, loadAgentWorkSnapshot } from '../../dist/backend.mjs';
import { buildStructuredTodayIndexInput } from '../../backend/upstream/app/desktop/structured-today-input.ts';
import { parseSessionTranscript } from '../../backend/upstream/app/desktop/transcript-reader.ts';
import { loadStructuredTodayEditorialContract } from '../../backend/upstream/src/structured-today-model-functions.ts';
import { freezeStructuredTodayProviderPlan } from '../../backend/upstream/app/desktop/structured-today-cli-caller.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const date = '2026-08-29';
const marker = 'AUDIT_UNIQUE_FROZEN_FACT_7B8C';
const message = (text, day = date) => ({ type: 'response_item', timestamp: `${day}T01:00:00Z`, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const lines = (id, cwd, text = marker, day = date) => [
  { type: 'session_meta', payload: { id, cwd } }, message(text, day)
].map(JSON.stringify).join('\n') + '\n';
const evidence = value => console.log('AUDIT_RESULT ' + JSON.stringify(value));
const runtimeFs = { stat: fs.stat, readdir: fs.readdir, readFile: fs.readFile, readBytes: fs.readFile, realpath: fs.realpath };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-audit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'codex');
  await fs.mkdir(root);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, lines('session-1', dir));
  await fs.utimes(file, new Date(`${date}T02:00:00Z`), new Date(`${date}T02:00:00Z`));
  const options = { date, roots: [root], source: 'codex', dataDir: path.join(dir, 'data') };
  const cliArgs = ['src/cli.mjs', 'brief', '--date', date, '--root', root, '--source', 'codex', '--data-dir', options.dataDir, '--format', 'json'];
  return { dir, root, file, options, cliArgs };
}

test('AUDIT terminal digest failure remains stuck after recovery', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(brief(f.options, { runner: async () => { calls++; throw new Error('transient outage'); } }), /publication gates/);
  const firstCalls = calls;
  const delegate = structuredRunner();
  await assert.rejects(brief(f.options, { runner: async req => { calls++; return delegate(req); } }), /publication gates/);
  assert.equal(calls, firstCalls);
  evidence({ probe: 'terminal-retry', firstCalls, retryCalls: calls - firstCalls, stillFails: true });
});

test('AUDIT dossier publishes without frozen text after source deletion; CLI exits zero on stale index', async t => {
  const f = await fixture(t);
  const prompts = [];
  const delegate = structuredRunner();
  const runner = async req => { prompts.push(req.stdin); return delegate(req); };
  await brief(f.options, { runner });
  assert.ok(prompts[0].includes(marker));
  await fs.rm(f.file);
  prompts.length = 0;
  const view = await brief({ ...f.options, workline: '1' }, { runner });
  assert.equal(view.mode, 'stale');
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every(prompt => !prompt.includes(marker)));
  assert.ok(view.dossier.content.supportingEvidence.length);
  const child = spawnSync(process.execPath, [...f.cliArgs, '--read-only'], { cwd: repo, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).mode, 'stale');
  evidence({ probe: 'dossier-grounding', sourceDeleted: true, frozenTextInDossierPrompts: false, dossierCalls: prompts.length, published: true, staleReadExit: child.status });
});

test('AUDIT evidence budget duplicates short messages and exceeds serialized cap', async t => {
  const f = await fixture(t);
  const snapshot = await loadAgentWorkSnapshot({ ...DEFAULT_SETTINGS, sessionScanRoots: [f.root], enabledSessionProviders: ['codex'] }, { date, fs: runtimeFs });
  const content = Array.from({ length: 4000 }, (_, i) => JSON.stringify(message(`msg-${i}`))).join('\n');
  const result = await buildStructuredTodayIndexInput({ logicalDate: date, snapshot, editorialContract: await loadStructuredTodayEditorialContract(), artifactId: 'audit', revision: 1, workflowRunId: 'audit', readTranscript: async () => ({ content, truncated: false }) });
  const raw = result.sessions[0].evidenceText;
  const messages = JSON.parse(raw).messages;
  assert.ok(raw.length > 240000);
  assert.equal(messages.length, 8001);
  evidence({ probe: 'evidence-budget', cap: 240000, characters: raw.length, originalMessages: 4000, outputMessages: messages.length, uniqueIds: new Set(messages.map(m => m.id)).size });
});

test('AUDIT individual message truncation is marked complete', () => {
  const parsed = parseSessionTranscript({ content: JSON.stringify(message('x'.repeat(81000))), platform: 'codex', sessionId: 'audit', title: 'audit', path: '/tmp/audit' });
  assert.equal(parsed.truncated, false);
  assert.ok(parsed.messages[0].content.length < 81000);
  evidence({ probe: 'message-truncation', original: 81000, retained: parsed.messages[0].content.length, truncated: parsed.truncated });
});

test('AUDIT target-day digest also receives later-day messages as complete evidence', async t => {
  const f = await fixture(t);
  const laterFact = 'AUDIT_NEXT_DAY_ONLY_MERGED_CHANGE';
  await fs.appendFile(f.file, JSON.stringify(message(laterFact, '2026-08-30')) + '\n');
  await fs.utimes(f.file, new Date('2026-08-30T02:00:00Z'), new Date('2026-08-30T02:00:00Z'));
  let digestInput;
  const delegate = structuredRunner();
  await brief(f.options, { runner: async req => {
    if (req.stdin.includes('Digest exactly one')) digestInput = req.stdin;
    return delegate(req);
  } });
  const variables = JSON.parse(digestInput.split('VARIABLES:\n')[1]);
  const item = JSON.parse(variables.sessionEvidenceJson);
  const body = JSON.parse(item.evidenceText);
  assert.equal(variables.logicalDate, date);
  assert.ok(body.messages.some(m => m.content === laterFact));
  assert.equal(body.coverage, 'complete');
  evidence({ probe: 'date-boundary', requested: date, laterFactDate: '2026-08-30', laterFactInDigest: true, coverage: body.coverage });
});

test('AUDIT negative critique is still labelled semantic passed and hidden in text output', async t => {
  const f = await fixture(t);
  const delegate = structuredRunner();
  const runner = async req => {
    const response = await delegate(req);
    if (!req.stdin.includes('Critique unsupported')) return response;
    const event = JSON.parse(response.stdout);
    event.item.text = JSON.stringify({ acceptable: false, issues: ['AUDIT_UNRESOLVED_UNSUPPORTED_CLAIM'], missingEvidenceIds: [] });
    return { ...response, stdout: JSON.stringify(event) + '\n' };
  };
  const view = await brief({ ...f.options, workline: '1' }, { runner });
  assert.equal(view.dossier.validation.semantic, 'passed');
  assert.ok(view.dossier.validation.critiqueIssues.includes('AUDIT_UNRESOLVED_UNSUPPORTED_CLAIM'));
  const { render } = await import('../../src/presentation.mjs');
  assert.ok(!render(view).includes('AUDIT_UNRESOLVED_UNSUPPORTED_CLAIM'));
  evidence({ probe: 'critique-gate', critiqueAcceptable: false, finalSemantic: view.dossier.validation.semantic, issueShownInText: false });
});

test('AUDIT historical date is starved by ninety newer files', async t => {
  const f = await fixture(t);
  await fs.rm(f.file);
  const old = path.join(f.root, '2026/08/29');
  const recent = path.join(f.root, '2026/09/05');
  await fs.mkdir(old, { recursive: true });
  await fs.mkdir(recent, { recursive: true });
  await fs.writeFile(path.join(old, 'old.jsonl'), lines('old', f.dir));
  await Promise.all(Array.from({ length: 90 }, async (_, i) => {
    const file = path.join(recent, `new-${i}.jsonl`);
    await fs.writeFile(file, lines(`new-${i}`, f.dir, 'new activity', '2026-09-05'));
    await fs.utimes(file, new Date('2026-09-05T02:00:00Z'), new Date('2026-09-05T02:00:00Z'));
  }));
  const view = await brief({ ...f.options, readOnly: true });
  assert.equal(view.sessions.length, 0);
  assert.ok(view.evidenceCoverage.some(e => e.disposition === 'truncated'));
  evidence({ probe: 'historical-scan', existingTarget: 1, newerFiles: 90, returned: view.sessions.length, reportsTruncation: true });
});

test('AUDIT project filter runs after the global session cap', async t => {
  const f = await fixture(t);
  const target = path.join(f.dir, 'target');
  await fs.writeFile(f.file, lines('session-1', target));
  await fs.utimes(f.file, new Date(`${date}T01:00:00Z`), new Date(`${date}T01:00:00Z`));
  await Promise.all(Array.from({ length: 48 }, async (_, i) => {
    const file = path.join(f.root, `other-${i}.jsonl`);
    await fs.writeFile(file, lines(`other-${i}`, '/other/project'));
    await fs.utimes(file, new Date(`${date}T02:00:00Z`), new Date(`${date}T02:00:00Z`));
  }));
  const view = await brief({ ...f.options, project: target, readOnly: true });
  assert.equal(view.sessions.length, 0);
  assert.ok(view.evidenceCoverage.some(e => e.sourceId.endsWith('session.jsonl') && e.disposition === 'truncated'));
  evidence({ probe: 'project-cap', targetSessions: 1, unrelatedSessions: 48, returned: view.sessions.length });
});

test('AUDIT numeric workline selection silently changes after automatic refresh', async t => {
  const f = await fixture(t);
  let reverse = false;
  const delegate = structuredRunner();
  const runner = async req => {
    const result = await delegate(req);
    if (!req.stdin.includes('Reconstruct cross-Session')) return result;
    const event = JSON.parse(result.stdout);
    const out = JSON.parse(event.item.text);
    const base = out.worklines[0];
    out.worklines = ['workline-A', 'workline-B'].map(worklineId => ({ ...base, worklineId, title: worklineId }));
    if (reverse) out.worklines.reverse();
    out.assignments[0].worklineIds = out.worklines.map(w => w.worklineId);
    event.item.text = JSON.stringify(out);
    return { ...result, stdout: JSON.stringify(event) + '\n' };
  };
  const before = await brief(f.options, { runner });
  assert.equal(before.index.worklines[0].worklineId, 'workline-A');
  await fs.appendFile(f.file, JSON.stringify(message('new evidence')) + '\n');
  await fs.utimes(f.file, new Date(`${date}T03:00:00Z`), new Date(`${date}T03:00:00Z`));
  reverse = true;
  const after = await brief({ ...f.options, workline: '1' }, { runner });
  assert.equal(after.dossier.worklineId, 'workline-B');
  evidence({ probe: 'workline-selection', displayedFirst: 'workline-A', selectedByOne: after.dossier.worklineId, autoRefreshed: true });
});

test('AUDIT Ctrl-C leaves a permanent lock that blocks even read-only', async t => {
  const f = await fixture(t);
  const ready = path.join(f.dir, 'provider-ready');
  const fake = path.join(f.dir, 'fake-provider');
  await fs.writeFile(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const settings = path.join(f.dir, 'settings.json');
  await fs.writeFile(settings, JSON.stringify({ codexCliPath: fake }));
  const child = spawn(process.execPath, [...f.cliArgs, '--settings', settings], { cwd: repo, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  const exited = once(child, 'exit');
  let started = false;
  for (let i = 0; i < 300; i++) {
    try { await fs.access(ready); started = true; break; } catch { await delay(20); }
  }
  assert.ok(started, 'fake provider must start before interrupt');
  process.kill(-child.pid, 'SIGINT');
  await exited;
  const scopes = await fs.readdir(f.options.dataDir);
  await fs.access(path.join(f.options.dataDir, scopes[0], 'writer.lock'));
  await assert.rejects(brief({ ...f.options, readOnly: true }), /已有 CLI/);
  evidence({ probe: 'signal-lock', signal: 'SIGINT to process group', lockRemains: true, readOnlyBlocked: true });
});

test('AUDIT default provider plan invokes both CLIs for a single-provider corpus', () => {
  const plan = freezeStructuredTodayProviderPlan(DEFAULT_SETTINGS, [{ sessionId: 'only-claude', provider: 'claude' }]);
  assert.equal(plan.digestBySessionId['only-claude'], 'claude');
  assert.equal(plan.functionProviders.SynthesizeWorklineIndex, 'codex');
  evidence({ probe: 'provider-default', corpus: ['claude'], digest: 'claude', synthesis: plan.functionProviders.SynthesizeWorklineIndex, critique: plan.functionProviders.CritiqueWorklineDossier });
});

test('AUDIT plain reopen is free but explicit refresh recomputes the unchanged digest', async t => {
  const f = await fixture(t);
  let calls = 0;
  const delegate = structuredRunner();
  const runner = async req => { calls++; return delegate(req); };
  await brief(f.options, { runner });
  const first = calls;
  await brief(f.options, { runner });
  assert.equal(calls, first);
  await brief({ ...f.options, refresh: true }, { runner });
  assert.equal(calls - first, 2);
  evidence({ probe: 'digest-reuse', firstCalls: first, plainReopenCalls: 0, unchangedRefreshCalls: calls - first });
});
