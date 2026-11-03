import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { brief, conversationSession, sourceSession } from '../src/service.mjs';
import { structuredRunner, writeWorkflowFixture, workflowRunner } from './model-fixture.mjs';

test('workflow child remains grouped through index, dossier, source navigation and cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await writeWorkflowFixture(root);
  const options = { date: '2026-08-29', source: 'all', compiler: 'codex', roots: fixture.roots, dataDir: path.join(root, 'data') };
  let digests = 0;
  const runner = workflowRunner(structuredRunner(), request => {
    if (request.stdin.includes('Digest exactly one')) {
      digests++;
      const variables = JSON.parse(request.stdin.split('VARIABLES:\n')[1]);
      assert.match(variables.sessionEvidenceJson, /family-child:codex:worker-1/);
      assert.match(variables.sessionEvidenceJson, /parentProvider/);
    }
  });
  const view = await brief(options, { runner });
  assert.equal(digests, 1);
  assert.equal(view.index.worklines.length, 1);
  const evidence = view.index.evidence.find(item => item.provider === 'codex');
  assert.ok(evidence?.contentHash);
  const worker = sourceSession(view, evidence.evidenceId);
  assert.equal(worker.id, 'worker-1');
  assert.equal(conversationSession(view, worker)?.platform, 'claude');
  const workline = view.index.worklines[0].worklineId;
  const deep = await brief({ ...options, workline }, { runner });
  assert.equal(deep.dossier.sourceIndex.contentHash, view.index.contentHash);
  const cached = await brief({ ...options, readOnly: true }, { runner: () => assert.fail('cache called a model') });
  assert.deepEqual(cached.index, view.index);
  await fs.appendFile(fixture.childPath, JSON.stringify({ type: 'response_item', timestamp: '2026-08-29T01:11:00Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '新证据。' }] } }) + '\n');
  const stale = await brief({ ...options, readOnly: true }, { runner: () => assert.fail('stale called a model') });
  assert.equal(stale.mode, 'stale');
});
