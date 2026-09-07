import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSessionTargets, jumpToSession, parseProcesses } from '../src/session-jump.mjs';
import { sourceSession, conversationSession, worklineSessions } from '../src/service.mjs';

const id = '11111111-2222-3333-4444-555555555555';
const otherId = '66666666-2222-3333-4444-555555555555';
const session = { id, platform: 'codex', title: 'same title', path: '/home/me/.codex/rollout.jsonl', resumable: true, updatedAt: '2026-09-07T03:00:00Z' };
const claude = { ...session, platform: 'claude', path: '/custom/claude/projects/demo/session.jsonl' };
const started = 'Mon Sep  7 03:12:33 2026';
const ps = (pid, parent, tty, command) => `${pid} ${parent} ${tty} ${started} ${command}`;
const app = ps(20, 1, '??', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
const appServer = ps(21, 20, '??', '/Applications/ChatGPT.app/Contents/Resources/codex');
const otty = ps(10, 1, '??', '/Applications/Otty.app/Contents/MacOS/Otty');
const pane = { id: 'p_live_1', agent: 'Codex', agent_session_id: id };

function runtime({ processes = [ps(1, 0, '??', '/sbin/launchd')], panes = [], files = '', tmux = '', registry = {}, env = {}, fail = [] } = {}) {
  const calls = [];
  const options = { platform: 'darwin', homeDir: '/home/me', env,
    run: async (command, args, options) => {
      calls.push({ command, args });
      if (fail.includes(command)) throw new Error('probe failed');
      if (command === 'ps') {
        assert.equal(options.env.TZ, 'UTC');
        assert.ok(args.includes('pid=,ppid=,tty=,lstart=,comm='), 'process inspection never requests prompts or environment values');
        return processes.join('\n');
      }
      if (command === 'lsof') return files;
      if (command.endsWith('otty-cli')) return JSON.stringify({ ok: true, data: panes });
      if (command === 'tmux') return tmux;
      throw new Error(`unexpected probe ${command}`);
    },
    readFile: async file => { if (!registry[file]) throw new Error('missing'); return JSON.stringify(registry[file]); }
  };
  return { options, calls, inspect: sessions => inspectSessionTargets(sessions, options) };
}

test('only exact source identity resolves; child evidence selects its own provider’s primary conversation', () => {
  const otherProvider = { ...session, platform: 'claude', path: '/other.jsonl' };
  const child = { ...session, id: otherId, path: '/child.jsonl', lineage: { origin: 'subagent', parentSessionId: id } };
  const evidence = { evidenceId: 'e1', sourcePath: child.path, provider: 'codex' };
  const forged = { ...evidence, evidenceId: 'forged', sessionId: id };
  const view = { sessions: [session, child, otherProvider], index: { evidence: [evidence, forged] } };
  assert.equal(sourceSession(view, 'e1'), child);
  assert.equal(sourceSession(view, 'forged'), undefined);
  assert.equal(conversationSession(view, child), session);
  assert.deepEqual(worklineSessions(view, { evidenceIds: ['e1', 'e1', 'forged'] }), [session]);
  assert.equal(sourceSession({ ...view, sessions: [child, { ...child }] }, 'e1'), undefined, 'ambiguous canonical handles are not guessed');
  assert.equal(conversationSession({ sessions: [child, otherProvider] }, child), undefined, 'cross-provider ID collision is not a parent');
});

test('Otty resolves exact provider and ID; focus rechecks the current pane and never starts a provider', async () => {
  const r = runtime({ processes: [otty, app, appServer, ps(11, 10, 'ttys001', '/bin/codex')], panes: [pane, { ...pane, id: 'p_other', agent_session_id: otherId }], files: `p11\nn${session.path}\n` });
  const [state] = await r.inspect([session]);
  assert.equal(state.targets.length, 1, 'an existing CLI is not redirected into the app');
  assert.equal(state.targets[0].id, 'otty:p_live_1');
  const launches = [];
  await jumpToSession(session, state.targets[0].id, { inspect: r.inspect, run: async (...args) => { launches.push(args); } });
  assert.deepEqual(launches[0].slice(0, 2), ['/Applications/Otty.app/Contents/MacOS/otty-cli', ['pane', 'focus', '--pane', 'p_live_1']]);
  const [wrongProvider] = await r.inspect([claude]);
  assert.deepEqual(wrongProvider.targets, []);
  const duplicate = runtime({ processes: [otty], panes: [pane, { ...pane, id: 'p_second' }] });
  const labels = (await duplicate.inspect([session]))[0].targets.map(target => target.label);
  assert.equal(new Set(labels).size, 2, 'two windows for the same session are distinguishable');
  const gone = runtime({ processes: [otty], panes: [{ ...pane, agent_session_id: otherId }] });
  await assert.rejects(jumpToSession(session, state.targets[0].id, { inspect: gone.inspect, run: async () => assert.fail('must not focus reused pane') }), /状态已变化/);
});

test('Codex app uses an existing-thread deep link and exposes both windows if the ID already has two owners', async () => {
  const r = runtime({ processes: [app, appServer, otty], files: `p21\nn${session.path}\n` });
  const [state] = await r.inspect([session]);
  const calls = [];
  await jumpToSession(session, state.targets[0].id, { inspect: r.inspect, run: async (...args) => calls.push(args) });
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${id}`]]);
  const both = runtime({ processes: [app, appServer, otty], panes: [pane], files: `p21\nn${session.path}\n` });
  assert.deepEqual((await both.inspect([session]))[0].targets.map(t => t.kind), ['otty', 'codex-app']);
  const idleApp = runtime({ processes: [app, appServer] });
  assert.match((await idleApp.inspect([session]))[0].targets[0].label, /打开原会话/);
});

test('Claude idle registry matches PID start time, supports custom roots, and rejects stale PID reuse', async () => {
  const processes = [ps(30, 1, '??', '/Users/me/Applications/iTerm.app/Contents/MacOS/iTerm2'), ps(31, 30, 'ttys004', 'claude')];
  const registryFile = '/custom/claude/sessions/31.json';
  const registry = { [registryFile]: { pid: 31, sessionId: id, procStart: started } };
  const r = runtime({ processes, registry });
  const [state] = await r.inspect([claude]);
  assert.equal(state.targets[0].kind, 'iterm');
  assert.equal(state.targets[0].tty, '/dev/ttys004');
  const focus = [];
  await jumpToSession(claude, state.targets[0].id, { inspect: r.inspect, run: async (...args) => focus.push(args) });
  assert.equal(focus[0][1].at(-1), '/dev/ttys004');
  assert.match(focus[0][1][1], /select s\s+select t\s+select w/);
  assert.ok(!/write text|do script|send.?keys/.test(focus[0][1][1]));
  registry[registryFile].procStart = started.replace('03:', '04:');
  assert.deepEqual((await r.inspect([claude]))[0].targets, []);
  await assert.rejects(jumpToSession(claude, state.targets[0].id, { inspect: r.inspect, run: async () => assert.fail('stale process') }), /状态已变化/);
});

test('uncertain, inaccessible, unmapped and absent owners never cause CLI resume or app crossover', async () => {
  for (const options of [
    {}, { fail: ['ps'] },
    { processes: [app, appServer], fail: ['lsof'] },
    { processes: [app, appServer, ps(40, 1, 'ttys005', '/bin/codex')] },
    { processes: [app, appServer, ps(40, 1, 'ttys005', '/bin/codex')], files: `p40\nn${session.path}\n` }
  ]) {
    const r = runtime(options);
    const [state] = await r.inspect([session]);
    assert.deepEqual(state.targets, []);
    assert.ok(state.reason);
    await assert.rejects(jumpToSession(session, 'stale', { inspect: r.inspect, run: async () => assert.fail('must not launch') }));
  }
});

test('tmux focuses the exact pane in the current server and command failure never falls back to resume', async () => {
  const r = runtime({ processes: [ps(40, 1, 'pts/4', '/bin/codex')], env: { TMUX: '/tmp/tmux-1/default,1,0' },
    files: `p40\nn${session.path}\n`, tmux: '%4\t/dev/pts/4\t$2\t@7' });
  const [state] = await r.inspect([session]);
  const calls = [];
  await jumpToSession(session, state.targets[0].id, { inspect: r.inspect, run: async (file, args) => calls.push([file, args]) });
  assert.deepEqual(calls, [['tmux', ['switch-client', '-t', '%4']]], 'one command selects the exact session, window and pane');
  let attempts = 0;
  await assert.rejects(jumpToSession(session, state.targets[0].id, { inspect: r.inspect, run: async () => { attempts++; throw new Error('permission denied'); } }), /permission denied/);
  assert.equal(attempts, 1);
});

test('unverified IDs and subagents are rejected before system probes; cancelled actions cannot focus', async () => {
  const r = runtime();
  const invalid = [{ ...session, id: 'new' }, { ...session, id: `${id}; touch /tmp/no` }, { ...session, resumable: false }, { ...session, lineage: { origin: 'subagent' } }, { ...session, lineage: { origin: 'automation' } }];
  assert.ok((await r.inspect(invalid)).every(state => !state.targets.length && state.reason));
  assert.deepEqual(r.calls, []);
  const active = runtime({ processes: [app, appServer] });
  const [state] = await active.inspect([session]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(jumpToSession(session, state.targets[0].id, { inspect: active.inspect, signal: controller.signal, run: async () => assert.fail('cancelled') }), { name: 'AbortError' });
  assert.equal(parseProcesses('broken').length, 0);
});
