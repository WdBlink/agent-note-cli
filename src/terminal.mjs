import { emitKeypressEvents } from 'node:readline';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { clean } from './presentation.mjs';
import { renderNotebook } from './notebook-pixels.mjs';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const segments = text => Array.from(segmenter.segment(clean(text).replace(/\t/g, '    ')), s => s.segment);
const wide = /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\p{Extended_Pictographic}\p{Regional_Indicator}\u{20000}-\u{3fffd}]/u;
const cells = char => /^[\p{Mark}\u200d\ufe0f]+$/u.test(char) ? 0 : wide.test(char) ? 2 : 1;
export const width = text => segments(text).reduce((sum, char) => sum + cells(char), 0);

export function fit(text, columns) {
  let result = '', used = 0;
  for (const char of segments(text).filter(c => c !== '\n' && c !== '\r')) {
    if (used + cells(char) > columns) break;
    result += char;
    used += cells(char);
  }
  return result;
}

export function wrap(text, columns) {
  const lines = [];
  for (const paragraph of clean(text).split('\n')) {
    let line = '', used = 0;
    for (const char of segments(paragraph)) {
      const size = cells(char);
      if (used + size > columns && line) { lines.push(line); line = ''; used = 0; }
      line += char; used += size;
    }
    lines.push(line);
  }
  return lines;
}

const row = (text, tone) => ({ text, tone });
const shortcut = (action, key) => `${action}(${key})`;
const shortcuts = entries => entries.filter(([, key]) => key).map(([action, key]) => shortcut(action, key)).join(' · ');
// Warm ink, paper, leather and the notebook's green bookmark. No terminal-theme dependency.
const base = '\x1b[0m\x1b[48;2;28;25;22m\x1b[38;2;223;211;191m';
const tones = {
  accent: '\x1b[38;2;215;158;104m', muted: '\x1b[38;2;166;157;142m',
  rule: '\x1b[38;2;89;75;60m', strong: '\x1b[1m\x1b[38;2;245;227;196m',
  selectedHint: '\x1b[48;2;66;48;33m\x1b[38;2;200;182;155m',
  selected: '\x1b[48;2;66;48;33m\x1b[38;2;245;211;164m\x1b[1m',
  green: '\x1b[38;2;158;181;123m', warning: '\x1b[38;2;224;148;121m'
};
// Match perceptual lightness/chroma; RGB distance turns warm ivory pink in a 256-color palette.
const lab = rgb => {
  const [r, g, b] = rgb.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const [x, y, z] = [(r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047,
    r * 0.2126729 + g * 0.7151522 + b * 0.0721750, (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883]
    .map(value => value > 216 / 24389 ? Math.cbrt(value) : value * 24389 / 3132 + 16 / 116);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const cube = [0, 95, 135, 175, 215, 255];
const colorTable = Array.from({ length: 240 }, (_, n) => lab(n >= 216 ? Array(3).fill(8 + (n - 216) * 10)
  : [cube[Math.floor(n / 36)], cube[Math.floor(n / 6) % 6], cube[n % 6]]));
const ansi256 = text => text.replace(/(\x1b\[(?:38|48));2;(\d+);(\d+);(\d+)m/g, (_, prefix, red, green, blue) => {
  const target = lab([red, green, blue].map(Number));
  let closest = 16, distance = Infinity;
  for (const [i, candidate] of colorTable.entries()) {
    const delta = candidate.reduce((sum, value, j) => sum + (value - target[j]) ** 2, 0);
    if (delta < distance) { distance = delta; closest = i + 16; }
  }
  return `${prefix};5;${closest}m`;
});
const base256 = ansi256(base);
const background = color => !color ? '' : color === '256' ? base256 : base;
const style = (text, tone, color) => color ? `${(color === '256' ? tones256 : tones)[tone] ?? ''}${text}${background(color)}` : text;
const joined = (...parts) => ({ parts });
const insetFor = columns => columns >= 50 ? Math.max(3, Math.floor((columns - 112) / 2)) : 1;
const tones256 = Object.fromEntries(Object.entries(tones).map(([key, value]) => [key, ansi256(value)]));
const notebookFrames = ['notebook', 'notebook-strap-lift', 'notebook-strap-free', 'notebook-ajar', 'notebook-open'];

function paint(line, columns, color) {
  let remaining = Math.min(columns, line.columns ?? columns);
  return (line.parts ?? [line]).map(part => {
    const text = fit(part.text, remaining);
    remaining -= width(text);
    return style(text, part.tone, color);
  }).join('');
}

export function frame({ columns = 80, rows = 24, color = false, title = '首页', context = '', body = [], footer = '', note = '', brandArtwork = false }) {
  const inset = insetFor(columns);
  const available = Math.max(1, columns - inset * 2 - 1);
  const rule = '─'.repeat(available);
  const header = [row(''), joined(row(brandArtwork ? '      AGENT NOTE' : '▤ AGENT NOTE', 'strong'), row(`    /    ${title}`, 'accent')),
    row(`${brandArtwork ? '      ' : ''}${context}`, 'muted'), row(rule, 'rule')];
  const count = Math.max(0, rows - header.length - 4);
  const content = body.slice(0, count).map(line => typeof line === 'string' ? row(line) : line);
  while (content.length < count) content.push(row(''));
  const all = [...header, ...content, row(rule, 'rule'), row(note, 'accent'), row(footer, 'muted')];
  return all.slice(0, Math.max(1, rows - 1)).map(line => background(color) + ' '.repeat(inset) + paint(line, available, color)).join('\r\n');
}

function navigation(key, pageSize) {
  if (key.ctrl) return ({ n: 1, p: -1, f: pageSize, b: -pageSize, d: Math.max(1, Math.floor(pageSize / 2)), u: -Math.max(1, Math.floor(pageSize / 2)), v: pageSize })[key.name];
  if (key.meta) return key.name === 'v' ? -pageSize : undefined;
  return ({ down: 1, up: -1, pagedown: pageSize, pageup: -pageSize, space: pageSize })[key.name]
    ?? ({ j: 1, k: -1, g: -Infinity, G: Infinity })[key.text]
    ?? ({ home: -Infinity, end: Infinity })[key.name];
}

export class Terminal {
  constructor({ input = process.stdin, output = process.stdout, signals = process, color = 'auto', exitConfirmMs = 2000 } = {}) {
    this.input = input;
    this.output = output;
    this.signals = signals;
    this.color = color === 'never' || (color === 'auto' && Boolean(process.env.NO_COLOR)) || process.env.TERM === 'dumb' ? false
      : /truecolor|24bit/.test(process.env.COLORTERM ?? '') ? true : '256';
    const program = process.env.TERM_PROGRAM;
    this.graphics = !this.color || process.env.TMUX || process.env.STY ? null
      : ['ghostty', 'kitty', 'otty'].includes(program) || (!program && process.env.TERM === 'xterm-kitty') ? 'kitty'
        : ['iTerm.app', 'WezTerm'].includes(program) ? 'iterm' : null;
    if (this.graphics) this.color = true;
    this.quit = false;
    this.context = '';
    this.keys = [];
    this.pictures = new Map();
    this.exitConfirmMs = exitConfirmMs;
  }

  start() {
    if (!this.input.isTTY || !this.output.isTTY || !this.input.setRawMode || process.env.TERM === 'dumb') {
      throw new Error('交互界面需要支持 ANSI 的终端。脚本请使用 agent-note brief --format json。');
    }
    this.wasRaw = this.input.isRaw;
    this.wasPaused = this.input.readableFlowing !== true;
    emitKeypressEvents(this.input);
    this.onKey = (text, key = {}) => {
      this.transitionAbort?.abort();
      if (key.ctrl && key.name === 'c') return this.requestExit('Ctrl+C');
      if (this.transitionAbort && text === 'q') return this.requestExit('q');
      if (this.exitConfirmation && text !== 'q') this.clearExitConfirmation();
      if (this.controller) {
        if (key.name === 'escape') this.controller.abort();
        if (text === 'q') this.controller.abort();
        return;
      }
      const resolve = this.pending;
      this.pending = undefined;
      if (resolve) resolve({ text, ...key });
      else if (this.keys.length < 4096) this.keys.push({ text, ...key });
    };
    this.onResize = () => this.draw();
    this.onExit = () => this.stop(true);
    this.input.on('keypress', this.onKey);
    this.input.on('end', this.onExit);
    this.output.on('resize', this.onResize);
    this.signals.on('SIGINT', this.onExit);
    this.signals.on('SIGTERM', this.onExit);
    this.input.setRawMode(true);
    this.input.resume();
    this.output.write('\x1b[?1049h\x1b[?25l');
  }

  stop(interrupted = false) {
    this.interrupted ||= interrupted;
    this.quit = true;
    this.clearExitConfirmation(false);
    this.transitionAbort?.abort();
    this.controller?.abort();
    this.pending?.({ name: 'escape' });
    this.pending = undefined;
  }

  requestExit(key) {
    const now = Date.now();
    if (this.exitConfirmation?.key === key && this.exitConfirmation.expiresAt > now) {
      this.stop(key === 'Ctrl+C');
      return true;
    }
    this.clearExitConfirmation(false);
    this.exitConfirmation = { key, expiresAt: now + this.exitConfirmMs };
    this.exitConfirmationTimer = setTimeout(() => {
      this.exitConfirmation = undefined;
      this.exitConfirmationTimer = undefined;
      this.draw();
    }, this.exitConfirmMs);
    this.exitConfirmationTimer.unref?.();
    this.draw();
    return false;
  }

  clearExitConfirmation(redraw = true) {
    if (!this.exitConfirmation) return;
    clearTimeout(this.exitConfirmationTimer);
    this.exitConfirmation = undefined;
    this.exitConfirmationTimer = undefined;
    if (redraw) this.draw();
  }

  exitFooter(footer) {
    return this.exitConfirmation
      ? `再次退出(${this.exitConfirmation.key}) · ${Math.ceil((this.exitConfirmation.expiresAt - Date.now()) / 1000)} 秒后取消`
      : footer;
  }

  close() {
    this.input.off('keypress', this.onKey);
    this.input.off('end', this.onExit);
    this.output.off('resize', this.onResize);
    this.signals.off('SIGINT', this.onExit);
    this.signals.off('SIGTERM', this.onExit);
    this.input.setRawMode(Boolean(this.wasRaw));
    if (this.wasPaused) this.input.pause();
    if (this.lastPicture && this.graphics === 'kitty') this.output.write(`\x1b_Ga=d,d=I,i=${process.pid},q=2\x1b\\`);
    this.output.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  }

  get columns() { return this.output.columns || 80; }
  get rows() { return this.output.rows || 24; }
  get capacity() { return Math.max(1, this.rows - 8); }
  get contentWidth() { return Math.max(1, this.columns - insetFor(this.columns) * 2 - 1); }
  // Artwork is reserved for brief transitions and longer waits; ordinary pages use a header mark.
  withArtwork(screen, asset, writingElapsed) {
    if (this.columns < 80 || this.rows < 22) return screen;
    const closed = asset !== 'notebook-ajar' && asset !== 'notebook-open';
    return { ...screen,
      body: screen.body.map(line => ({ ...(typeof line === 'string' ? row(line) : line), columns: this.contentWidth - 30 })),
      ...(this.graphics && this.color ? {
        picture: { asset, row: closed ? 8 : 6, column: insetFor(this.columns) + this.contentWidth - 25 + (closed ? 3 : 0),
          columns: closed ? 18 : 24, rows: closed ? 9 : 12 }
      } : {
        pixelArt: { asset, row: 6, column: insetFor(this.columns) + this.contentWidth - 26, writingElapsed }
      })
    };
  }

  async transition(closing = false) {
    if (this.columns < 80 || this.rows < 22 || this.interrupted || (!closing && this.keys.length)) return;
    this.transitionAbort = new AbortController();
    const signal = this.transitionAbort.signal;
    try {
      for (const asset of closing ? notebookFrames.toReversed() : notebookFrames) {
        if (signal.aborted) break;
        this.show(() => this.withArtwork({ title: closing ? '再会' : '欢迎',
          body: ['', '', row(closing ? '合上笔记，回到工作。' : '翻开今天的工作。', 'strong'), '',
            row(closing ? '下次从这里继续。' : '从会话中找回推进的事情。', 'muted')],
          footer: shortcut('跳过', '任意键'), note: '' }, asset));
        await delay(closing ? 100 : asset === 'notebook-open' ? 220 : 140, undefined, { signal });
      }
    } catch (error) { if (!signal.aborted) throw error; }
    finally { this.transitionAbort = undefined; }
  }

  next() { return this.quit ? Promise.resolve({ name: 'escape' }) : this.keys.length ? Promise.resolve(this.keys.shift()) : new Promise(resolve => { this.pending = resolve; }); }
  show(render) { this.renderScreen = render; this.draw(); }
  draw() {
    if (!this.renderScreen) return;
    const screen = this.columns < 24 || this.rows < 12
      ? { title: '窗口较小', body: ['请放大到至少 24 × 12。'], footer: shortcut('退出', 'Ctrl+C') }
      : this.renderScreen();
    const brandArtwork = this.columns >= 60 && this.rows >= 16;
    const mark = { asset: 'mark', row: 2, column: insetFor(this.columns) + 1 };
    const picture = this.color && this.graphics && (screen.picture || (brandArtwork ? {
      asset: 'notebook', row: 2, column: insetFor(this.columns) + 1, columns: 4, rows: 2
    } : undefined));
    const lines = frame({ columns: this.columns, rows: this.rows, color: this.color, context: this.context, brandArtwork,
      ...screen, footer: this.exitFooter(screen.footer ?? '') }).split('\r\n');
    if (!picture) {
      for (const art of [brandArtwork && mark, screen.pixelArt].filter(Boolean)) {
        const pixels = renderNotebook(art.asset, this.color, background(this.color), art.writingElapsed);
        for (const [y, pixelRow] of pixels.entries()) {
          const i = art.row - 1 + y;
          if (i >= lines.length) break;
          const end = Math.max(width(lines[i]), art.column - 1 + width(pixelRow));
          // Paint into reserved cells, then return past the text before erase-to-end.
          lines[i] += `\x1b[${art.column}G${pixelRow}\x1b[${end + 1}G`;
        }
      }
    }
    const size = `${this.columns}:${this.rows}`;
    const pictureKey = picture ? JSON.stringify(picture) : undefined;
    let output = '';
    if (this.lastPicture && this.lastPicture !== pictureKey) {
      if (this.graphics === 'kitty') output += `\x1b_Ga=d,d=I,i=${process.pid},q=2\x1b\\`;
      else this.lastSize = undefined; // iTerm images occupy text cells; clear them on page changes.
    }
    const resized = this.lastSize !== size;
    if (resized) {
      output += background(this.color) + '\x1b[H\x1b[2J';
      this.lastLines = [];
      this.lastSize = size;
    }
    let imageRowChanged = false;
    for (const [i, line] of lines.entries()) {
      if (line !== this.lastLines[i]) {
        const imageRow = picture && i + 1 >= picture.row && i + 1 < picture.row + picture.rows;
        const lineEnd = width(line);
        const preserveImage = imageRow && !resized && this.lastPicture === pictureKey && lineEnd < picture.column - 1;
        output += `\x1b[${i + 1};1H${line}${preserveImage ? `\x1b[${picture.column - 1 - lineEnd}X` : '\x1b[K'}`;
        if (imageRow && !preserveImage) imageRowChanged = true;
      }
    }
    this.lastLines = lines;
    if (picture && (resized || this.lastPicture !== pictureKey || (this.graphics === 'iterm' && imageRowChanged))) {
      if (!this.pictures.has(picture.asset)) this.pictures.set(picture.asset, readFileSync(new URL(`./assets/${picture.asset}.png`, import.meta.url)).toString('base64'));
      const pictureData = this.pictures.get(picture.asset);
      output += `\x1b7\x1b[${picture.row};${picture.column}H`;
      if (this.graphics === 'iterm') {
        output += `\x1b]1337;File=inline=1;size=${Buffer.byteLength(pictureData, 'base64')};width=${picture.columns};height=${picture.rows};preserveAspectRatio=1:${pictureData}\x07`;
      } else {
        for (let offset = 0; offset < pictureData.length; offset += 4096) {
          const chunk = pictureData.slice(offset, offset + 4096);
          output += `\x1b_G${offset ? '' : `a=T,f=100,i=${process.pid},q=2,C=1,c=${picture.columns},r=${picture.rows},`}m=${offset + chunk.length < pictureData.length ? 1 : 0};${chunk}\x1b\\`;
        }
      }
      output += '\x1b8';
    }
    this.lastPicture = pictureKey;
    if (output) this.output.write(output);
  }

  async menu({ title, description = '', items, searchable = false, initial = 0, note = '', actions = {}, enterLabel = '打开', root = false }) {
    let selected = initial, query = '', searching = false;
    const matches = () => items.filter(item => `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(query.toLowerCase()));
    const render = () => {
      const list = matches();
      selected = Math.max(0, Math.min(selected, list.length - 1));
      const body = [row(description, 'muted'), ''];
      const pageSize = Math.max(1, Math.floor((this.capacity - 2) / 2));
      const start = Math.floor(selected / pageSize) * pageSize;
      const split = this.columns >= (title === '首页' ? 80 : 100) && Boolean(list[selected]?.preview);
      const leftWidth = split ? Math.floor(this.contentWidth * 0.43) : this.contentWidth;
      const menuRows = [];
      for (const [i, item] of list.slice(start, start + pageSize).entries()) {
        const active = start + i === selected;
        menuRows.push(row(`${active ? '▎' : ' '} ${String(start + i + 1).padStart(2, '0')}  ${item.label}`, active ? 'selected' : 'strong'));
        menuRows.push(row(`      ${item.hint ?? ''}`, active ? 'selectedHint' : 'muted'));
      }
      if (!list.length) menuRows.push(row('没有匹配项。按 Esc 清除搜索。', 'muted'));
      const rightWidth = this.contentWidth - leftWidth - 4;
      const preview = split ? wrap(list[selected].preview, rightWidth).map((text, i) => row(text, i === 0 ? 'accent' : undefined)) : [];
      for (let i = 0; i < Math.max(menuRows.length, preview.length); i++) {
        const line = menuRows[i] ?? row('');
        const text = clean(line.text).replace(/[\r\n]+/g, ' ');
        const left = width(text) > leftWidth ? fit(text, leftWidth - 1) + '…' : text;
        const padded = left + ' '.repeat(Math.max(0, leftWidth - width(left)));
        body.push(split ? joined(row(padded, line.tone),
          row(' │  ', 'rule'), ...(preview[i]?.parts ?? [preview[i] ?? row('')])) : row(padded, line.tone));
      }
      return { title, body,
        note: searching || query ? `搜索 / ${query}▏   ${list.length} 项` : (typeof note === 'function' ? note() : note) || (list.length ? `${selected + 1} / ${list.length}` : ''),
        footer: searching ? shortcuts([['完成', 'Enter'], ['清除', 'Esc']])
          : this.columns < 50
            ? `${shortcut(Object.keys(actions).length ? '操作' : enterLabel, Object.keys(actions).join('/') || 'Enter')} ${shortcut(root ? '退出' : '返回', 'q')}`
            : shortcuts([['移动', '↑↓'], [enterLabel, 'Enter'], ...Object.entries(actions).map(([key, action]) => [action, key]),
              ...(searchable && this.columns >= 60 ? [['搜索', '/']] : []), ['返回', 'Esc'], [root ? '退出' : '返回', 'q'], ['退出', 'Ctrl+C']]) };
    };
    this.show(render);
    while (!this.quit) {
      const key = await this.next();
      if (key.name === 'escape') {
        if (searching || query) { searching = false; query = ''; selected = 0; } else return null;
      } else if (searching) {
        if (key.name === 'return') searching = false;
        else if (key.name === 'backspace') query = segments(query).slice(0, -1).join('');
        else if (!key.ctrl && !key.meta && key.text && clean(key.text) === key.text) query = (query + key.text).slice(0, 160);
        selected = 0;
      } else if (key.text === 'q') {
        if (root) {
          if (this.requestExit('q')) return null;
        } else {
          this.clearExitConfirmation(false);
          return null;
        }
      }
      else if (!key.ctrl && !key.meta && actions[key.text] && matches()[selected]) return { ...matches()[selected], action: key.text };
      else if (key.text === '/' && searchable) searching = true;
      else if (navigation(key, Math.max(1, Math.floor((this.capacity - 2) / 2))) !== undefined) {
        const next = selected + navigation(key, Math.max(1, Math.floor((this.capacity - 2) / 2)));
        selected = Math.max(0, Math.min(next, matches().length - 1));
      }
      else if (key.name === 'return') { const item = matches()[selected]; if (item) return item; }
      else if (/^[1-9]$/.test(key.text ?? '') && matches()[Number(key.text) - 1]) return matches()[Number(key.text) - 1];
      this.draw();
    }
    return null;
  }

  async read({ title, text, note = '', actions = {}, position = {}, markdown = false }) {
    let scroll = position.scroll ?? 0;
    let wrappedWidth, lines;
    const render = () => {
      const readingWidth = Math.min(84, this.contentWidth - 2);
      if (wrappedWidth !== readingWidth) {
        wrappedWidth = readingWidth;
        lines = clean(text).split('\n').flatMap(line => {
          const heading = markdown && line.match(/^(#{1,3}) (.+)$/);
          const tone = heading ? (heading[1].length === 1 ? 'strong' : 'accent') : undefined;
          return wrap(heading ? `${heading[1].length === 1 ? '' : '▎ '}${heading[2]}` : line, readingWidth)
            .map(text => row(`  ${text}`, tone));
        });
      }
      scroll = Math.max(0, Math.min(scroll, lines.length - this.capacity));
      position.scroll = scroll;
      return { title, body: lines.slice(scroll), note: (typeof note === 'function' ? note() : note) || `${scroll + 1}–${Math.min(lines.length, scroll + this.capacity)} / ${lines.length} 行`,
        footer: this.columns < 50
          ? `${shortcut('操作', Object.keys(actions).join('/') || '↑↓')} ${shortcut('返回', 'q')}`
          : shortcuts([['滚动', '↑↓'], ['键位', '?'], ...Object.entries(actions).map(([key, action]) => [action, key]), ['返回', 'q/Esc'], ['退出', 'Ctrl+C']]) };
    };
    this.show(render);
    while (!this.quit) {
      const key = await this.next();
      if (key.name === 'escape') return null;
      if (key.text === 'q') { this.clearExitConfirmation(false); return null; }
      if (!key.ctrl && !key.meta && actions[key.text]) return key.text;
      if (key.text === '?') {
        await this.read({ title: '阅读键位', text: [...Object.entries(actions).map(([key, action]) => `${key}：${action}`), '↑↓ / j k / Ctrl-N P：逐行滚动\nCtrl-F / Ctrl-B：下翻 / 上翻一页\nCtrl-D / Ctrl-U：下翻 / 上翻半页\nCtrl-V / Alt-V：下翻 / 上翻一页（Emacs）\nPageDown / PageUp：下翻 / 上翻一页\ng / G / Home / End：首行 / 末页\nSpace：下翻一页\nEsc：返回'].join('\n') });
        this.show(render);
        continue;
      }
      const delta = navigation(key, this.capacity);
      if (delta !== undefined) scroll = Math.max(0, Math.min(scroll + delta, Math.max(0, lines.length - this.capacity)));
      this.draw();
    }
    return null;
  }

  async prompt({ title, label, value = '', hint = '', validate = () => {} }) {
    let text = value, error = '';
    this.show(() => ({ title, body: [row(label, 'strong'), ...wrap(`${text}▏`, this.contentWidth).slice(-Math.max(1, this.capacity - 3)), row(hint, 'muted'), row(error, 'warning')],
      footer: shortcuts([['确认', 'Enter'], ['取消', 'Esc'], ['清空', 'Ctrl+U'], ['退出', 'Ctrl+C']]) }));
    while (!this.quit) {
      const key = await this.next();
      if (key.name === 'escape') return null;
      if (key.name === 'return') {
        try { await validate(text.trim()); return text.trim(); } catch (failure) { error = clean(failure.message); }
      } else if (key.ctrl && key.name === 'u') text = '';
      else if (key.name === 'backspace') text = segments(text).slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && key.text && clean(key.text) === key.text && !/[\r\n]/.test(key.text)) text = (text + key.text).slice(0, 4096);
      this.draw();
    }
    return null;
  }

  async busy(title, task) {
    this.keys.length = 0;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const started = Date.now();
    const stages = new Map();
    const labels = { scan: '发现会话', prepare: '准备工作脉络', digest: '整理会话家族', 'index-synthesis': '合成工作线', 'dossier-analysis': '分析工作线', 'dossier-critique': '核查证据', 'dossier-compose': '生成深读' };
    const deep = title === '准备深读';
    const render = () => {
      const elapsed = Date.now() - started;
      const pulse = Math.floor(elapsed / 160) % 24;
      const cursor = pulse <= 12 ? pulse : 24 - pulse;
      const events = Array.from(stages.values());
      const current = events.filter(p => p.status === 'running').at(-1);
      const visible = deep ? ['dossier-analysis', 'dossier-critique', 'dossier-compose'].map(stage => stages.get(`${stage}:`) ?? { stage, status: 'pending' })
        : events.filter(p => events.length < 3 || !['scan', 'prepare'].includes(p.stage));
      const body = [row(signal.aborted ? '正在取消，等待模型进程结束…' : title, 'strong'),
        row(signal.aborted ? '已发出取消请求，正在收尾。' : deep ? '对照原文梳理判断，逐步形成可追溯的深读。' : '正在处理当前范围，完成后自动继续。', 'muted'), '',
        joined(row('  '), row(signal.aborted ? '─'.repeat(16) : '─'.repeat(cursor) + '▰▰▰▰' + '─'.repeat(12 - cursor), 'accent'),
          row(`  ${signal.aborted ? '正在停止' : labels[current?.stage] ?? '准备中'}`, 'muted')), ''];
      for (const p of visible.slice(-Math.max(1, this.capacity - body.length))) {
        const done = p.status === 'ready', failed = p.status === 'failed';
        const active = p.status === 'running' && !signal.aborted;
        body.push(joined(row(`  ${done ? '✓' : failed ? '!' : active ? '▸' : '·'}  `, done ? 'green' : failed ? 'warning' : active ? 'accent' : 'muted'),
          row(labels[p.stage] ?? p.stage, active ? 'strong' : 'muted'),
          row(`  ${p.sessionId ?? ({ ready: '已完成', failed: '未完成', excluded: '已排除', running: signal.aborted ? '正在停止' : '进行中', pending: '等待' }[p.status] ?? '')}`, 'muted')));
      }
      const screen = { title, body, note: `已用 ${Math.floor(elapsed / 1000)} 秒 · ${deep ? '分析 → 核查 → 成文' : '保留已有内容'}`,
        footer: shortcuts([['取消并返回', 'q/Esc'], ['退出', 'Ctrl+C']]) };
      return elapsed < 600 ? screen : this.withArtwork(screen, signal.aborted ? 'notebook' : notebookFrames[Math.min(notebookFrames.length - 1, Math.floor((elapsed - 600) / 140))], elapsed - 1160);
    };
    let shown = false;
    const timer = setInterval(() => { shown = true; this.show(render); }, 160);
    try {
      const result = await task({ signal, onProgress: progress => { stages.set(`${progress.stage}:${progress.sessionId ?? ''}`, progress); if (shown) this.draw(); } });
      return signal.aborted ? undefined : result;
    } catch (error) {
      if (signal.aborted) return undefined;
      throw error;
    } finally {
      clearInterval(timer);
      this.controller = undefined;
    }
  }
}
