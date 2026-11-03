import fs from 'node:fs/promises';
import path from 'node:path';

// Matches dynamic-workflow 0.4.2 launch/status JSON and provider transcript shapes.
export async function writeWorkflowFixture(root) {
  const roots = [path.join(root, 'claude'), path.join(root, 'codex')];
  for (const directory of roots) await fs.mkdir(directory, { recursive: true });
  const time = '2026-08-29T01:00:00Z';
  const call = (id, command) => ({ type: 'assistant', sessionId: 'session-1', timestamp: time,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `node /tools/dynamic-workflow/bin/workflow.mjs ${command} --json` } }] } });
  const result = (id, value) => ({ type: 'user', sessionId: 'session-1', timestamp: time,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(value) }] } });
  const parent = [
    { type: 'user', sessionId: 'session-1', cwd: root, timestamp: time, message: { role: 'user', content: '检查来源归属。' } },
    call('launch', 'run /tmp/plan.js'), result('launch', { runId: 'run-1', pid: 123 }),
    call('status', 'status run-1'), result('status', { version: 1, runId: 'run-1', steps: { check: { id: 'check', threadId: 'worker-1', startedAt: time, status: 'completed' } } }),
    { type: 'assistant', sessionId: 'session-1', timestamp: '2026-08-29T01:10:00Z', message: { role: 'assistant', content: '完成来源检查。' } }
  ];
  const child = [
    { type: 'session_meta', timestamp: time, payload: { id: 'worker-1', source: 'exec', cwd: root } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '由工作流下发的检查。' }] } },
    { type: 'response_item', timestamp: '2026-08-29T01:09:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '来源检查完成。' }] } }
  ];
  for (const [directory, records] of [[roots[0], parent], [roots[1], child]]) {
    const file = path.join(directory, 'session.jsonl');
    await fs.writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
    await fs.utimes(file, new Date(time), new Date(time));
  }
  return { roots, childPath: path.join(roots[1], 'session.jsonl') };
}

export function workflowRunner(delegate, inspect = () => {}) {
  return async request => {
    inspect(request);
    const response = await delegate(request);
    const envelope = JSON.parse(response.stdout);
    const output = JSON.parse(envelope.item.text.replaceAll('session:codex:session-1', 'session:claude:session-1'));
    const evidenceIds = ['session:claude:session-1', 'family-child:codex:worker-1'];
    if (request.stdin.includes('Digest exactly one')) output.evidenceIds = evidenceIds;
    if (request.stdin.includes('Reconstruct cross-Session')) output.worklines[0].evidenceIds = evidenceIds;
    if (request.stdin.includes('Compose the final')) output.evidenceIds = evidenceIds;
    envelope.item.text = JSON.stringify(output);
    return { ...response, stdout: JSON.stringify(envelope) + '\n' };
  };
}
