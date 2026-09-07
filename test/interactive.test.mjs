import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { Terminal, frame, width, fit, wrap } from '../src/terminal.mjs';
import { renderNotebook } from '../src/notebook-pixels.mjs';
import { runInteractive as runApp } from '../src/interactive.mjs';
import { version } from '../src/updates.mjs';
import { brief, readSource } from '../src/service.mjs';
import { structuredRunner } from './model-fixture.mjs';
import { desktopCliRunner } from '../dist/backend.mjs';

const runInteractive = (options, dependencies) => runApp(options, { updateChecker: async () => null, ...dependencies });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-ui-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'data'));
  await fs.writeFile(path.join(dir, 'data/ui-preferences.json'), JSON.stringify({ lastSeenVersion: version }));
  const root = path.join(dir, 'codex');
  await fs.mkdir(root);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, [
    { type: 'session_meta', payload: { id: 'session-1', cwd: dir } },
    { type: 'response_item', timestamp: '2026-08-29T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '检查终端导航与冻结原文。' }] } }
  ].map(JSON.stringify).join('\n') + '\n');
  await fs.utimes(file, new Date('2026-08-29T02:00:00Z'), new Date('2026-08-29T02:00:00Z'));
  return { dir, file, options: { date: '2026-08-29', roots: [root], source: 'codex', dataDir: path.join(dir, 'data') } };
}

class ScriptedTerminal {
  quit = false;
  context = '';
  constructor(steps) { this.steps = steps; }
  start() { this.started = true; }
  async transition() {}
  close() { this.closed = true; assert.equal(this.steps.length, 0); }
  async busy(title, task) { return task({ signal: new AbortController().signal, onProgress() {} }); }
  next(method, input) {
    const [expectedMethod, title, result, check] = this.steps.shift() ?? [];
    assert.equal(method, expectedMethod, `unexpected ${method}: ${input.title}`);
    assert.match(input.title, title);
    check?.(input);
    return result;
  }
  async menu(input) {
    const result = this.next('menu', input);
    if (result === null) return null;
    const item = input.items.find(i => i.id === (typeof result === 'string' ? result : result.id));
    assert.ok(item, `menu ${input.title} has no ${result}`);
    return result.action ? { ...item, action: result.action } : item;
  }
  async read(input) { return this.next('read', input); }
  async prompt(input) { const value = this.next('prompt', input); if (value !== null) await input.validate(value); return value; }
}

test('upgrades show bundled notes once and preserve source preferences; notes remain available from home', async t => {
  const f = await fixture(t);
  const file = path.join(f.options.dataDir, 'ui-preferences.json');
  await fs.writeFile(file, JSON.stringify({ source: 'claude', lastSeenVersion: '0.3.0', custom: true }));
  await runInteractive(f.options, { terminal: new ScriptedTerminal([
    ['read', /^本次更新/, null, page => assert.ok(page.text.includes(`Agent Note CLI ${version}`))],
    ['menu', /^首页$/, null]
  ]) });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { source: 'claude', lastSeenVersion: version, custom: true });
  await runInteractive(f.options, { terminal: new ScriptedTerminal([
    ['menu', /^首页$/, 'updates'],
    ['read', /^版本与更新/, null, page => assert.match(page.text, /brew upgrade/)],
    ['menu', /^首页$/, null]
  ]) });
  await fs.rm(file);
  await runInteractive(f.options, { terminal: new ScriptedTerminal([
    ['read', /^本次更新/, null], ['menu', /^首页$/, null]
  ]) });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).lastSeenVersion, version);
});

test('update checks do not block home, refresh status without navigation and abort on exit', async t => {
  const f = await fixture(t);
  let resolveCheck, signal, redraws = 0;
  const terminal = new ScriptedTerminal([]);
  terminal.draw = () => { redraws++; };
  terminal.menu = async page => {
    assert.match(page.title, /^首页$/);
    assert.match(page.note(), /后台检查/);
    resolveCheck('0.10.0');
    await tick();
    assert.match(page.note(), /发现新版本 v0.10.0/);
    assert.equal(redraws, 1);
    return null;
  };
  await runInteractive(f.options, { terminal, updateChecker: options => {
    signal = options.signal;
    return new Promise(resolve => { resolveCheck = resolve; });
  } });
  assert.ok(signal.aborted);
  await runInteractive(f.options, { terminal: new ScriptedTerminal([['menu', /^首页$/, null]]),
    updateChecker: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
});

test('offline update failure leaves home usable', async t => {
  const f = await fixture(t);
  const terminal = new ScriptedTerminal([]);
  terminal.menu = async page => { await tick(); assert.match(page.note(), /暂时无法检查更新/); return null; };
  await runInteractive(f.options, { terminal, updateChecker: async () => { throw new Error('offline'); } });
});

test('automatic release notes do not overwrite unreadable preferences', async t => {
  const f = await fixture(t);
  const file = path.join(f.options.dataDir, 'ui-preferences.json');
  await fs.writeFile(file, '{broken');
  await runInteractive(f.options, { terminal: new ScriptedTerminal([
    ['read', /^设置读取失败$/, null], ['read', /^本次更新/, null], ['menu', /^首页$/, null]
  ]) });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});

test('interactive app generates, opens a pinned workline, reads source, exports and returns without leaving the app', async t => {
  const f = await fixture(t);
  const exported = path.join(f.dir, 'brief.md');
  let calls = 0;
  const requests = [];
  const jumps = [];
  const delegate = structuredRunner();
  const runner = request => { calls++; return delegate(request); };
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'brief'], ['menu', /^工作脉络$/, 'generate'],
    ['menu', /^工作脉络$/, 'workline-structured-today'], ['read', /^工作线$/, 'o', page => {
      assert.equal(page.actions.o, '直达会话'); assert.match(page.text, /来源会话：Codex/); page.position.scroll = 4;
    }], ['read', /^工作线$/, 'd', page => assert.equal(page.position.scroll, 4)],
    ['menu', /^准备深读$/, 'generate'], ['read', /深读$/, 'o', page => { page.position.scroll = 8; }],
    ['read', /深读$/, 's', page => assert.equal(page.position.scroll, 8)],
    ['menu', /来源$/, 'session:codex:session-1'],
    ['read', /^来源/, 'o', page => { assert.match(page.text, /检查终端导航与冻结原文/); page.position.scroll = 2; }],
    ['read', /^来源/, null, page => assert.equal(page.position.scroll, 2)],
    ['menu', /来源$/, null], ['read', /深读$/, 'e'],
    ['menu', /^导出$/, 'markdown'], ['prompt', /保存位置/, exported], ['read', /导出完成/, null],
    ['read', /深读$/, null], ['read', /^工作线$/, null], ['menu', /^工作脉络$/, null],
    ['menu', /^首页$/, 'providers'], ['menu', /^会话来源$/, 'claude'], ['menu', /^首页$/, null]
  ]);
  await runInteractive(f.options, { terminal,
    sessionInspector: async sessions => sessions.map(session => ({ session, targets: [{ id: 'existing', label: 'Otty · 已打开' }] })),
    sessionJumper: async (session, target) => { jumps.push([session.id, target]); return 'Otty'; },
    service: (options, dependencies = {}) => {
    requests.push(options);
    return brief(options, { ...dependencies, runner });
  } });
  assert.equal(calls, 5);
  assert.deepEqual(jumps, Array(3).fill(['session-1', 'existing']), 'all three reading surfaces jump without additional model calls');
  assert.ok(requests[0].readOnly, 'opening the app must not call a provider');
  for (const request of requests.filter(r => r.workline)) {
    assert.equal(request.workline, 'workline-structured-today');
    assert.equal(request.indexReference.revision, 1);
  }
  assert.match(await fs.readFile(exported, 'utf8'), /如何验证/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.options.dataDir, 'ui-preferences.json'), 'utf8')).source, 'claude');
  assert.ok(terminal.closed);
});

test('multiple conversations require selection; source-list jump uses the highlighted canonical session', async t => {
  const f = await fixture(t);
  const sessions = [
    { id: 'first', platform: 'codex', title: '同名工作', path: '/first.jsonl' },
    { id: 'second', platform: 'claude', title: '同名工作', path: '/second.jsonl' }
  ];
  const workline = { worklineId: 'work', title: '双来源', summary: '摘要', evidenceIds: ['e1', 'e2'], sessionIds: ['first', 'second'], participation: { status: 'undetermined', reason: '未判断' } };
  const view = { mode: 'compiled', sessions, index: { revision: 1, worklines: [workline], evidence: sessions.map((s, i) => ({ evidenceId: `e${i + 1}`, provider: s.platform, sourcePath: s.path, sessionId: s.id, range: 'bytes 0-10' })) } };
  const jumps = [];
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'brief'], ['menu', /^工作脉络$/, 'work'], ['read', /^工作线$/, 'o'],
    ['menu', /^直达会话$/, '1', page => {
      assert.match(page.items[0].label, /^Codex · 同名工作/);
      assert.match(page.items[1].label, /^Claude Code · 同名工作/);
      assert.match(page.items[1].hint, /已打开/);
      assert.match(page.items[1].preview, /会话 ID：second/);
    }],
    ['read', /^工作线$/, 's'],
    ['menu', /来源$/, { id: 'e1', action: 'o' }, page => assert.equal(page.enterLabel, '原文')],
    ['menu', /来源$/, 'e2'], ['read', /^来源/, null],
    ['menu', /来源$/, null, page => assert.equal(page.initial, 1)],
    ['read', /^工作线$/, null], ['menu', /^工作脉络$/, null], ['menu', /^首页$/, null]
  ]);
  await runInteractive({ ...f.options, readOnly: true }, { terminal,
    service: async options => { assert.equal(options.readOnly, true); return view; },
    sourceReader: async (_view, id) => { assert.equal(id, 'e2'); return { path: '/second.jsonl', messages: [] }; },
    sessionInspector: async list => list.map(session => ({ session, targets: [{ id: session.id, label: 'Otty · 已打开' }] })),
    sessionJumper: async session => { jumps.push(session); return 'Otty'; }
  });
  assert.deepEqual(jumps, [sessions[1], sessions[0]]);
});

test('unlocated or failed window navigation explains the failure and keeps the source reader open', async t => {
  const f = await fixture(t);
  const session = { id: 'id', platform: 'codex', title: '来源标题', path: '/source.jsonl' };
  let attempts = 0;
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'sources'], ['menu', /^会话与来源$/, 'codex:id:/source.jsonl'],
    ['read', /^来源/, 'o'], ['read', /直达会话 \/ 未打开/, null, page => assert.match(page.text, /状态不明/)],
    ['read', /^来源/, 'o'], ['read', /直达会话 \/ 未打开/, null, page => assert.match(page.text, /permission denied/)],
    ['read', /^来源/, null], ['menu', /^会话与来源$/, null], ['menu', /^首页$/, null]
  ]);
  await runInteractive(f.options, { terminal,
    service: async () => ({ sessions: [session], index: null }),
    sourceReader: async () => ({ path: session.path, messages: [] }),
    sessionInspector: async () => [{ session, targets: attempts++ ? [{ id: 'window' }] : [], reason: '状态不明' }],
    sessionJumper: async () => { throw new Error('permission denied'); }
  });
  assert.equal(attempts, 2);
});

test('project/date changes invalidate cached view; read-only browsing never offers generation', async t => {
  const f = await fixture(t);
  const requested = [];
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'projects'], ['menu', /^项目$/, 'manual'], ['prompt', /^项目路径$/, '/work/target'],
    ['menu', /^首页$/, 'dates'], ['menu', /^日期$/, 'manual'], ['prompt', /^选择日期$/, '2026-08-28'],
    ['menu', /^工作脉络$/, null, menu => assert.ok(menu.items.every(i => i.id !== 'generate'))],
    ['menu', /^首页$/, null]
  ]);
  await runInteractive({ ...f.options, readOnly: true }, { terminal, service: options => {
    requested.push(options);
    return Promise.resolve({ date: options.date, timeZone: 'UTC', mode: 'raw', sessions: [], evidenceCoverage: [], warnings: [], index: null });
  } });
  assert.equal(requested.at(-1).date, '2026-08-28');
  assert.equal(requested.at(-1).project, '/work/target');
  assert.ok(requested.every(r => r.readOnly));
});

test('rescan reports completion and preserves the last list after cancellation or failure', async t => {
  const f = await fixture(t);
  let calls = 0;
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'brief'], ['menu', /^工作脉络$/, 'rescan'],
    ['menu', /^工作脉络$/, 'rescan', page => {
      assert.match(page.description, /扫描完成 .*2 条会话 · 0 条工作线/);
      assert.equal(page.items[page.initial].id, 'rescan');
    }],
    ['menu', /^工作脉络$/, 'rescan', page => assert.match(page.description, /扫描未完成/)],
    ['menu', /^重新扫描来源 \/ 未完成$/, 'back'],
    ['menu', /^工作脉络$/, null, page => {
      assert.match(page.description, /扫描未完成/);
      assert.match(page.items.find(item => item.id === 'sources').hint, /2 条会话/);
    }], ['menu', /^首页$/, null]
  ]);
  await runInteractive(f.options, { terminal, service: async (options, dependencies) => {
    assert.equal(options.readOnly, true);
    assert.equal(dependencies.snapshot, undefined, 'rescan reads the sources again');
    calls++;
    if (calls === 3) return undefined;
    if (calls === 4) throw new Error('source unavailable');
    return { mode: 'raw', sessions: Array(calls).fill({}), index: null };
  } });
  assert.equal(calls, 4);
});

test('recoverable operation error stays in the app and supports retry', async t => {
  const f = await fixture(t);
  let calls = 0;
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'brief'], ['menu', /未完成$/, 'details'], ['read', /^错误详情$/, null], ['menu', /未完成$/, 'retry'],
    ['menu', /^工作脉络$/, null], ['menu', /^首页$/, null]
  ]);
  await runInteractive(f.options, { terminal, service: async () => {
    if (calls++ === 0) throw new Error('temporary read failure');
    return { mode: 'raw', sessions: [], index: null };
  } });
  assert.equal(calls, 2);
  assert.ok(terminal.closed);
});

function tty(t) {
  const originalTerm = process.env.TERM;
  process.env.TERM = 'xterm-256color';
  t.after(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm; });
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = value => { input.isRaw = value; };
  let outputText = '';
  const output = new Writable({ write(chunk, _encoding, done) { outputText += chunk.toString(); done(); } });
  output.isTTY = true; output.columns = 108; output.rows = 28;
  const signals = new EventEmitter();
  const terminal = new Terminal({ input, output, signals });
  terminal.color = false;
  terminal.graphics = null;
  return { input, output, signals, terminal, text: () => outputText };
}

test('terminal handles buffered arrows, Unicode search, resize, paging and restores raw mode', async t => {
  const f = tty(t);
  f.terminal.start();
  try {
    const items = [{ id: 'one', label: '终端导航', preview: '支持逐项选择' }, { id: 'two', label: '后端校验', preview: '证据必须可回查' }];
    const selected = f.terminal.menu({ title: '测试', items, searchable: true });
    f.input.write('/后端\r\r');
    assert.equal((await selected).id, 'two');
    const arrows = f.terminal.menu({ title: '测试', items });
    f.input.write('\x1b[B\r');
    assert.equal((await arrows).id, 'two');
    const reading = f.terminal.read({ title: '长文', text: Array.from({ length: 90 }, (_, i) => `第 ${i + 1} 行`).join('\n') });
    const firstAfterPage = f.terminal.capacity + 1;
    f.input.write(' ');
    await tick();
    const beforeResize = f.text().length;
    f.output.columns = 38; f.output.rows = 16; f.output.emit('resize');
    assert.ok(f.text().slice(beforeResize).includes(`第 ${firstAfterPage} 行`));
    f.input.emit('keypress', undefined, { name: 'escape' });
    await reading;
  } finally { f.terminal.close(); }
  assert.equal(f.input.isRaw, false);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
  assert.match(f.text(), /\x1b\[\?1049l$/);
});

test('menu jump shortcut acts on the selected filtered item and does not steal search input or Ctrl-O', async t => {
  const f = tty(t);
  f.terminal.start();
  try {
    const items = [{ id: 'one', label: 'one' }, { id: 'other', label: 'other' }];
    const selecting = f.terminal.menu({ title: '来源', items, actions: { o: '直达' }, searchable: true, enterLabel: '原文' });
    f.input.write('/oth\r\x0fo');
    assert.deepEqual(await selecting, { ...items[1], action: 'o' });
    assert.match(f.text(), /Enter原文.*o直达/);
    assert.equal(items[1].action, undefined, 'selecting an action does not mutate source identity');
    const reading = f.terminal.menu({ title: '来源', items, actions: { o: '直达' } });
    f.input.write('\r');
    assert.deepEqual(await reading, items[0]);
  } finally { f.terminal.close(); }
});

test('narrow jump pages keep action and return keys visible and explain actions in help', async t => {
  const f = tty(t);
  f.output.columns = 24;
  f.terminal.start();
  try {
    const selecting = f.terminal.menu({ title: '来源', items: [{ id: 'one', label: 'one' }], actions: { o: '直达' } });
    assert.ok(width(f.terminal.renderScreen().footer) <= f.terminal.contentWidth);
    assert.match(f.terminal.renderScreen().footer, /o.*Esc/);
    f.input.write('o');
    assert.equal((await selecting).action, 'o');
    const reading = f.terminal.read({ title: '工作线', text: '正文', actions: { o: '直达会话', d: '深读', s: '来源', e: '导出' } });
    assert.ok(width(f.terminal.renderScreen().footer) <= f.terminal.contentWidth);
    assert.match(f.terminal.renderScreen().footer, /o\/d\/s\/e.*Esc/);
    f.input.write('?');
    await tick();
    assert.ok(f.text().includes('o：直达会话'));
    f.input.emit('keypress', undefined, { name: 'escape' });
    await tick();
    f.input.emit('keypress', undefined, { name: 'escape' });
    await reading;
  } finally { f.terminal.close(); }
});

test('background status redraw preserves menu selection and reader position', async t => {
  const f = tty(t);
  f.terminal.start();
  let status = '正在检查';
  try {
    const menu = f.terminal.menu({ title: '首页', note: () => status, items: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] });
    f.input.write('j');
    await tick();
    status = '发现新版本';
    f.terminal.draw();
    assert.match(f.text(), /发现新版本/);
    f.input.write('\r');
    assert.equal((await menu).id, 'two');
    const position = {};
    const reading = f.terminal.read({ title: '版本与更新', text: '更新内容\n'.repeat(100), note: () => status, position });
    f.input.write(' ');
    await tick();
    const scroll = position.scroll;
    status = '暂时无法检查更新';
    f.terminal.draw();
    assert.equal(position.scroll, scroll);
    assert.match(f.text(), /暂时无法检查更新/);
    f.input.emit('keypress', undefined, { name: 'escape' });
    await reading;
  } finally { f.terminal.close(); }
});

test('Vim and Emacs navigation scrolls menus/readers without firing plain-letter actions', async t => {
  const f = tty(t);
  f.terminal.start();
  try {
    const position = {};
    const reading = f.terminal.read({ title: '快捷键', text: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'), position, actions: { d: '深读', s: '来源', e: '导出' } });
    const page = f.terminal.capacity;
    for (const [key, expected] of [['\x06', page], ['\x02', 0], ['\x04', page / 2], ['\x15', 0], ['\x16', page], ['\x1bv', 0], ['\x0e', 1], ['\x10', 0], ['G', 200 - page], ['g', 0]]) {
      f.input.write(key);
      await tick();
      assert.equal(position.scroll, expected, JSON.stringify(key));
    }
    f.input.write('d');
    assert.equal(await reading, 'd');
    const items = Array.from({ length: 80 }, (_, i) => ({ id: String(i), label: `Item ${i}` }));
    const menu = f.terminal.menu({ title: '列表', items });
    f.input.write('\x16\x1bv\x0e\r');
    assert.equal((await menu).id, '1');
  } finally { f.terminal.close(); }
});

test('menu highlights both aligned rows and clips CJK text before the preview divider', async t => {
  const f = tty(t);
  f.terminal.color = true;
  f.terminal.start();
  try {
    const menu = f.terminal.menu({ title: '来源', items: [
      { id: 'one', label: '一条很长的会话标题'.repeat(12), hint: '/项目/'.repeat(20), preview: 'PREVIEW\n右栏正文' },
      { id: 'two', label: '另一个会话', hint: '未选中' }
    ] });
    const screen = f.terminal.renderScreen();
    const rendered = frame({ columns: 108, rows: 28, color: true, ...screen }).split('\r\n');
    const highlighted = rendered.filter(line => line.includes('\x1b[48;2;66;48;33m'));
    assert.equal(highlighted.length, 2);
    assert.ok(highlighted.every(line => line.includes('…')));
    const dividerColumns = highlighted.map(line => width(line.slice(0, line.indexOf('│'))));
    assert.equal(dividerColumns[0], dividerColumns[1]);
    assert.ok(rendered.every(line => width(line) < 108));
    f.input.write('\r');
    await menu;
  } finally { f.terminal.close(); }
});

test('terminal cancellation aborts work and restores the terminal after SIGINT', async t => {
  const f = tty(t);
  f.terminal.start();
  const running = f.terminal.busy('测试取消', ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  f.signals.emit('SIGINT');
  assert.equal(await running, undefined);
  assert.equal(f.terminal.quit, true);
  f.terminal.close();
  assert.equal(f.input.isRaw, false);
});

test('rendering respects terminal cell widths and strips source-controlled escape sequences', () => {
  const value = '证据e\u0301与路径 /工作/仓库';
  assert.equal(width('证据'), 4);
  assert.equal(width('e\u0301'), 1);
  assert.equal(fit('证据', 3), '证');
  for (const columns of [28, 40, 80, 120]) {
    for (const rows of [12, 24, 40]) {
      for (const color of [false, true, '256']) {
        const output = frame({ columns, rows, color, title: value, context: '\x1b[2J' + value, body: wrap(value.repeat(8), columns - 7), footer: value.repeat(4) });
        assert.ok(output.split('\r\n').every(line => width(line) < columns));
        assert.ok(output.split('\r\n').length < rows);
        assert.ok(!output.includes('\x1b[2J'));
        if (!color) assert.ok(!output.includes('\x1b'));
        if (color === '256') assert.ok(output.includes('\x1b[48;5;') && !output.includes(';2;'));
      }
    }
  }
});

test('warm theme keeps focus out of the preview, formats reading and animates only changed rows', async t => {
  const f = tty(t);
  f.terminal.color = true;
  f.terminal.start();
  let finish, busy;
  try {
    const menu = f.terminal.menu({ title: '首页', items: [{ id: 'read', label: '工作脉络', preview: '证据预览' }] });
    const screen = f.text();
    assert.ok(screen.includes('AGENT NOTE') && screen.includes('证据预览') && /[▀▄█]/u.test(screen), 'ordinary terminals keep the compact pixel mark and text preview');
    assert.ok(screen.includes('\x1b[48;2;28;25;22m'), 'warm background is explicit');
    const selection = screen.split('\x1b[48;2;66;48;33m')[1].split('\x1b[0m')[0];
    assert.ok(selection.includes('工作脉络') && !selection.includes('证据预览'), 'selection resets before preview');
    const stable = f.text().length;
    f.terminal.draw();
    assert.equal(f.text().length, stable, 'unchanged screen writes nothing');
    f.input.write('\r');
    await menu;

    const reading = f.terminal.read({ title: '深读', markdown: true, text: '# 主题\n\n## 如何验证\n\n' + '中文阅读'.repeat(40) });
    assert.ok(f.text().includes('▎ 如何验证'));
    f.input.emit('keypress', undefined, { name: 'escape' });
    await reading;

    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'] });
    let advance;
    busy = f.terminal.busy('准备深读', ({ onProgress }) => {
      advance = onProgress;
      onProgress({ stage: 'dossier-analysis', status: 'running' });
      return new Promise(resolve => { finish = resolve; });
    });
    t.mock.timers.tick(160);
    const offset = f.text().length;
    t.mock.timers.tick(160);
    const animation = f.text().slice(offset);
    assert.ok(animation.includes('▰▰▰▰'));
    assert.ok(!animation.includes('\x1b[2J'), 'animation must not clear the screen');
    assert.ok(!animation.includes('AGENT NOTE'), 'static logo must not repaint');
    advance({ stage: 'dossier-analysis', status: 'ready' });
    advance({ stage: 'dossier-critique', status: 'running' });
    assert.ok(f.text().includes('已完成'));
    finish(true);
    assert.equal(await busy, true);
    const stopped = f.text().length;
    t.mock.timers.tick(200);
    assert.equal(f.text().length, stopped, 'animation timer is cleaned up');
  } finally { finish?.(true); await busy; f.terminal.close(); }
});

test('fast work does not flash a progress screen or leave a delayed redraw', async t => {
  const f = tty(t);
  f.terminal.start();
  try {
    f.terminal.show(() => ({ title: '工作脉络', body: ['已有结果'] }));
    const before = f.text();
    assert.equal(await f.terminal.busy('重新扫描来源', async ({ onProgress }) => {
      onProgress({ stage: 'scan', status: 'running' });
      return 2;
    }), 2);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.text(), before);
  } finally { f.terminal.close(); }
});

test('Otty enables native images from its real terminal identifier', async t => {
  const f = tty(t);
  const names = ['TERM_PROGRAM', 'COLORTERM', 'NO_COLOR', 'TMUX', 'STY'];
  const saved = names.map(name => [name, process.env[name]]);
  t.after(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { TERM_PROGRAM: 'otty', COLORTERM: 'truecolor' });
  const terminal = new Terminal({ input: f.input, output: f.output, signals: f.signals });
  assert.equal(terminal.graphics, 'kitty');
  terminal.start();
  try {
    const menu = terminal.menu({ title: '首页', items: [{ id: 'read', label: '工作脉络' }] });
    assert.ok(f.text().includes('\x1b_Ga=T,f=100'), 'Otty receives PNG data without overriding its identity');
    f.input.write('q');
    await menu;
  } finally { terminal.close(); }
  assert.ok(f.text().includes(`a=d,d=I,i=${process.pid}`));
  process.env.NO_COLOR = '1';
  assert.equal(new Terminal().graphics, null, 'explicit color opt-out still applies');
});

test('terminal color policy respects nonempty NO_COLOR and explicit overrides across native protocols', t => {
  const names = ['TERM', 'TERM_PROGRAM', 'COLORTERM', 'NO_COLOR', 'TMUX', 'STY'];
  const saved = names.map(name => [name, process.env[name]]);
  t.after(() => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  for (const name of names) delete process.env[name];
  process.env.TERM = 'xterm-256color';
  for (const [program, protocol] of [['iTerm.app', 'iterm'], ['WezTerm', 'iterm'], ['ghostty', 'kitty'], ['kitty', 'kitty'], ['otty', 'kitty'], ['Apple_Terminal', null], ['vscode', null], ['Alacritty', null]]) {
    process.env.TERM_PROGRAM = program;
    for (const noColor of [undefined, '', '1', '0']) {
      if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
      const auto = new Terminal();
      assert.equal(Boolean(auto.color), !noColor, `${program}: NO_COLOR=${noColor}`);
      assert.equal(auto.graphics, noColor ? null : protocol);
      const forced = new Terminal({ color: 'always' });
      assert.ok(forced.color);
      assert.equal(forced.graphics, protocol);
      assert.equal(new Terminal({ color: 'never' }).color, false);
      assert.equal(new Terminal({ color: 'never' }).graphics, null);
    }
  }
  process.env.TERM_PROGRAM = 'iTerm.app';
  for (const multiplex of ['TMUX', 'STY']) {
    process.env[multiplex] = 'active';
    const terminal = new Terminal({ color: 'always' });
    assert.ok(terminal.color);
    assert.equal(terminal.graphics, null, 'color override must not bypass image transport restrictions');
    delete process.env[multiplex];
  }
  process.env.TERM = 'dumb';
  assert.equal(new Terminal({ color: 'always' }).color, false);
  process.env.TERM = 'xterm-kitty';
  process.env.TERM_PROGRAM = 'vscode';
  assert.equal(new Terminal({ color: 'always' }).graphics, null, 'an inherited TERM must not override the current terminal identity');
  process.env.TERM_PROGRAM = 'iTerm.app';
  assert.equal(new Terminal({ color: 'always' }).graphics, 'iterm');
  delete process.env.TERM_PROGRAM;
  assert.equal(new Terminal({ color: 'always' }).graphics, 'kitty');
});

test('native image protocols transmit the bundled PNG and clean up on navigation', async t => {
  const png = await fs.readFile(new URL('../src/assets/notebook.png', import.meta.url));
  for (const protocol of ['kitty', 'iterm']) {
    const f = tty(t);
    f.terminal.color = true;
    f.terminal.graphics = protocol;
    f.terminal.start();
    try {
      const menu = f.terminal.menu({ title: '首页', items: [{ id: 'read', label: '工作脉络', preview: '阅读' }] });
      const screen = f.text();
      if (protocol === 'kitty') {
        const chunks = [...screen.matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/g)];
        assert.ok(chunks[0][1].includes('q=2,C=1,c=4,r=2'));
        assert.ok(chunks.every(chunk => chunk[2].length <= 4096));
        assert.ok(chunks.at(-1)[1].includes('m=0'));
        assert.deepEqual(Buffer.from(chunks.map(chunk => chunk[2]).join(''), 'base64'), png);
      } else {
        const payload = screen.match(/\x1b\]1337;File=inline=1;size=\d+;width=4;height=2;preserveAspectRatio=1:([^\x07]+)\x07/);
        assert.ok(payload);
        assert.deepEqual(Buffer.from(payload[1], 'base64'), png);
      }
      const unchanged = f.text().length;
      f.terminal.draw();
      assert.equal(f.text().length, unchanged);
      f.input.write('\r');
      await menu;
      f.terminal.show(() => f.terminal.withArtwork({ title: '欢迎', body: ['翻开今天的工作。'] }, 'notebook-open'));
      assert.equal(f.terminal.renderScreen().pixelArt, undefined, 'native images take priority over character artwork');
      const offset = f.text().length;
      const reading = f.terminal.read({ title: '深读', text: '已打开正文' });
      const next = f.text().slice(offset);
      assert.ok(protocol === 'kitty' ? next.includes(`a=d,d=I,i=${process.pid}`) : next.includes('\x1b[2J'));
      f.input.emit('keypress', undefined, { name: 'escape' });
      await reading;
    } finally { f.terminal.close(); }
  }
  const limited = frame({ color: '256', title: '首页' });
  assert.ok(limited.includes('\x1b[38;5;187m') && !limited.includes('\x1b[38;5;224m'), 'warm title does not map to pink');
});

test('terminals without images render pixel artwork in color or one ink and clear it on resize', async t => {
  for (const color of [false, '256', true]) {
    const f = tty(t);
    f.terminal.color = color;
    f.terminal.start();
    try {
      let elapsed = 0;
      f.terminal.show(() => f.terminal.withArtwork({ title: '整理', context: '保留来源', body: ['正文'.repeat(80)] }, 'notebook-open', elapsed));
      const screen = f.terminal.renderScreen();
      assert.equal(screen.picture, undefined);
      assert.equal(screen.pixelArt.asset, 'notebook-open');
      assert.ok(screen.body[0].columns + 3 < screen.pixelArt.column, 'reserve space between text and the book');
      assert.ok(renderNotebook('notebook-open', color, '', elapsed).every(line => width(line) === 26));
      const initial = f.text();
      assert.match(initial, /[▀▄█]/u);
      assert.ok(!/\x1b(?:\]|P|_)/.test(initial), 'no image protocol is sent');
      if (!color) assert.ok(!/\x1b\[(?:38|48);/.test(initial), 'one-ink fallback respects NO_COLOR');
      const unchanged = f.text().length;
      f.terminal.draw();
      assert.equal(f.text().length, unchanged, 'static pixels do not redraw');
      elapsed = 540;
      f.terminal.draw();
      const moved = f.text().slice(unchanged);
      assert.match(moved, /[▀▄█]/u);
      assert.ok(!moved.includes('AGENT NOTE') && !moved.includes('\x1b[2J'), 'writing updates only affected rows');
      f.output.columns = 38;
      const beforeResize = f.text().length;
      f.output.emit('resize');
      assert.equal(f.terminal.renderScreen().pixelArt, undefined);
      const narrow = f.text().slice(beforeResize);
      assert.ok(narrow.includes('\x1b[2J') && narrow.includes('▤ AGENT NOTE'));
      assert.ok(!/[▀▄█]/u.test(narrow), 'narrow windows clear the large pixels and preserve text');
    } finally { f.terminal.close(); }
  }
});

test('pixel fallback opens on entry and writes during slow work without reopening', async t => {
  const f = tty(t);
  f.terminal.start();
  let finish;
  try {
    const opening = f.terminal.transition();
    assert.equal(f.terminal.renderScreen().pixelArt.asset, 'notebook');
    f.input.write('x');
    await opening;
    assert.equal((await f.terminal.next()).text, 'x');
    const work = f.terminal.busy('准备深读', () => new Promise(resolve => { finish = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 1400));
    const first = f.terminal.renderScreen().pixelArt;
    assert.equal(first.asset, 'notebook-open');
    assert.ok(first.writingElapsed >= 0);
    await new Promise(resolve => setTimeout(resolve, 240));
    const second = f.terminal.renderScreen().pixelArt;
    assert.equal(second.asset, 'notebook-open');
    assert.notDeepEqual(renderNotebook(first.asset, false, '', first.writingElapsed), renderNotebook(second.asset, false, '', second.writingElapsed));
    finish(true);
    assert.equal(await work, true);
    const stopped = f.text().length;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.text().length, stopped, 'pixel animation stops with the operation');
  } finally { finish?.(true); f.terminal.close(); }
});

test('book artwork opens and closes once, skips promptly, and stays small for quick operations', async t => {
  const f = tty(t);
  f.terminal.color = true;
  f.terminal.graphics = 'iterm';
  f.terminal.start();
  const shown = [];
  const draw = f.terminal.draw.bind(f.terminal);
  f.terminal.draw = () => { shown.push(f.terminal.renderScreen?.().picture?.asset); draw(); };
  try {
    await f.terminal.transition();
    assert.deepEqual(shown, ['notebook', 'notebook-strap-lift', 'notebook-strap-free', 'notebook-ajar', 'notebook-open']);
    shown.length = 0;
    await f.terminal.transition(true);
    assert.deepEqual(shown, ['notebook-open', 'notebook-ajar', 'notebook-strap-free', 'notebook-strap-lift', 'notebook']);
    const poses = ['notebook', 'notebook-strap-lift', 'notebook-strap-free'].map(asset => {
      const { asset: _, ...placement } = f.terminal.withArtwork({ body: [] }, asset).picture;
      return placement;
    });
    assert.deepEqual(poses[0], poses[1]);
    assert.deepEqual(poses[1], poses[2], 'the closed book stays fixed while its strap moves');
    shown.length = 0;
    const opening = f.terminal.transition();
    f.input.write('2');
    await opening;
    assert.deepEqual(shown, ['notebook']);
    assert.equal((await f.terminal.next()).text, '2', 'skipping does not swallow the first navigation key');
    const offset = f.text().length;
    assert.equal(await f.terminal.busy('读取简报与来源', async () => true), true);
    assert.ok(!f.text().slice(offset).includes('width=24'), 'fast reads do not flash a large picture');
    let finish;
    const work = f.terminal.busy('准备深读', () => new Promise(resolve => { finish = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(f.terminal.renderScreen().picture.asset, 'notebook-open');
    assert.equal(f.terminal.renderScreen().picture.columns, 24);
    const stableBook = f.text().length;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(!f.text().slice(stableBook).includes('1337;File='), 'progress updates leave the open book still');
    f.output.columns = 38; f.output.emit('resize');
    assert.equal(f.terminal.renderScreen().picture, undefined, 'small windows prioritize progress text');
    finish(true); await work;
    f.output.columns = 108;
    f.signals.emit('SIGTERM');
    const stopped = f.text().length;
    await f.terminal.transition(true);
    assert.equal(f.text().length, stopped, 'signals bypass the closing animation');
  } finally { f.terminal.close(); }
});

test('cancelled provider releases the writer lock and a subsequent run succeeds', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const running = brief({ ...f.options, signal: controller.signal }, { runner: async request => {
    began();
    return desktopCliRunner({ ...request, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 5000 });
  } });
  const rejected = assert.rejects(running);
  await started;
  controller.abort();
  await rejected;
  const scopes = (await fs.readdir(f.options.dataDir)).filter(p => p !== 'ui-preferences.json');
  await assert.rejects(fs.access(path.join(f.options.dataDir, scopes[0], 'writer.lock')));
  const view = await brief(f.options, { runner: structuredRunner() });
  assert.equal(view.mode, 'compiled');
});

test('pinned selection refuses a different revision; source reader rejects mutated frozen bytes', async t => {
  const f = await fixture(t);
  const runner = structuredRunner();
  const first = await brief(f.options, { runner });
  const reference = { artifactId: first.index.artifactId, revision: first.index.revision, contentHash: first.index.contentHash };
  await brief({ ...f.options, refresh: true }, { runner });
  await assert.rejects(brief({ ...f.options, workline: first.index.worklines[0].worklineId, indexReference: reference }, { runner }), /已有新版本/);
  await fs.writeFile(f.file, 'source replaced');
  await assert.rejects(readSource(first, first.index.evidence[0].evidenceId), /封存|不足|变化/);
});
