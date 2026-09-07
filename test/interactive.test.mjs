import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { Terminal, frame, width, fit, wrap } from '../src/terminal.mjs';
import { runInteractive } from '../src/interactive.mjs';
import { brief, readSource } from '../src/service.mjs';
import { structuredRunner } from './model-fixture.mjs';
import { desktopCliRunner } from '../dist/backend.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-note-ui-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
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
    const item = input.items.find(i => i.id === result);
    assert.ok(item, `menu ${input.title} has no ${result}`);
    return item;
  }
  async read(input) { return this.next('read', input); }
  async prompt(input) { const value = this.next('prompt', input); if (value !== null) await input.validate(value); return value; }
}

test('interactive app generates, opens a pinned workline, reads source, exports and returns without leaving the app', async t => {
  const f = await fixture(t);
  const exported = path.join(f.dir, 'brief.md');
  let calls = 0;
  const requests = [];
  const delegate = structuredRunner();
  const runner = request => { calls++; return delegate(request); };
  const terminal = new ScriptedTerminal([
    ['menu', /^首页$/, 'brief'], ['menu', /^工作脉络$/, 'generate'],
    ['menu', /^工作脉络$/, 'workline-structured-today'], ['read', /^工作线$/, 'd'],
    ['menu', /^准备深读$/, 'generate'], ['read', /深读$/, 's'],
    ['menu', /来源$/, 'session:codex:session-1'],
    ['read', /^来源/, null, page => assert.match(page.text, /检查终端导航与冻结原文/)],
    ['menu', /来源$/, null], ['read', /深读$/, 'e'],
    ['menu', /^导出$/, 'markdown'], ['prompt', /保存位置/, exported], ['read', /导出完成/, null],
    ['read', /深读$/, null], ['read', /^工作线$/, null], ['menu', /^工作脉络$/, null],
    ['menu', /^首页$/, 'providers'], ['menu', /^会话来源$/, 'claude'], ['menu', /^首页$/, null]
  ]);
  await runInteractive(f.options, { terminal, service: (options, dependencies = {}) => {
    requests.push(options);
    return brief(options, { ...dependencies, runner });
  } });
  assert.equal(calls, 5);
  assert.ok(requests[0].readOnly, 'opening the app must not call a provider');
  for (const request of requests.filter(r => r.workline)) {
    assert.equal(request.workline, 'workline-structured-today');
    assert.equal(request.indexReference.revision, 1);
  }
  assert.match(await fs.readFile(exported, 'utf8'), /如何验证/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.options.dataDir, 'ui-preferences.json'), 'utf8')).source, 'claude');
  assert.ok(terminal.closed);
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
  try {
    const menu = f.terminal.menu({ title: '首页', items: [{ id: 'read', label: '工作脉络', preview: '证据预览' }] });
    const screen = f.text();
    assert.ok(screen.includes('▤ AGENT NOTE') && screen.includes('证据预览'), 'ordinary terminals keep the compact book mark and text preview');
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

    let advance, finish;
    const busy = f.terminal.busy('准备深读', ({ onProgress }) => {
      advance = onProgress;
      onProgress({ stage: 'dossier-analysis', status: 'running' });
      return new Promise(resolve => { finish = resolve; });
    });
    await new Promise(resolve => setTimeout(resolve, 180));
    const offset = f.text().length;
    await new Promise(resolve => setTimeout(resolve, 180));
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
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.text().length, stopped, 'animation timer is cleaned up');
  } finally { f.terminal.close(); }
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
  process.env.NO_COLOR = '';
  assert.equal(new Terminal().graphics, null, 'explicit color opt-out still applies');
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
