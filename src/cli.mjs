#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { clean, render } from './presentation.mjs';

const help = `Agent Note CLI · 与 Agent Notebook 相同的 Today 后端

  agent-note                         打开交互终端应用
  agent-note ui --source codex        在应用内浏览、筛选与深读
  agent-note brief                   生成或重开今日工作脉络
  agent-note brief --workline 1       深读第 1 条工作线
  agent-note brief --read-only        只读取已有结果，不调用模型
  agent-note brief --refresh          按相同后端流程创建新版本

  --date YYYY-MM-DD                   日期，默认今天
  --timezone IANA                     时区，默认系统时区
  --project PATH                      只查看该项目及子目录
  --source NAME                      all|codex|claude|copilot|cursor，默认 all
  --compiler codex|claude|cursor      整理用的模型 CLI，默认跟随来源
  --root PATH                        扫描目录，可重复；目录名需含 codex、claude、copilot 或 cursor
  --settings FILE                    App 格式的 settings JSON
  --codex-model NAME                  覆盖 Codex 模型
  --claude-model NAME                 覆盖 Claude 模型
  --cursor-model NAME                 覆盖 Cursor 模型
  --data-dir PATH                    CLI 数据目录
  --format text|markdown|json         输出格式
  --color auto|always|never           TUI 配色，always 覆盖 NO_COLOR，默认 auto
  --help / --version                  帮助 / 版本

首次生成及刷新使用与 App 相同的模型调用，会发送会话证据并消耗你的额度。
已有未变化的 brief 可直接重开。--read-only 永不调用模型。
进度写入 stderr；导出的 JSON 保留后端原始 index 与 dossier。
`;
const expand = value => path.resolve(value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);

async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    date: { type: 'string' }, timezone: { type: 'string' }, project: { type: 'string' }, source: { type: 'string' }, compiler: { type: 'string' },
    root: { type: 'string', multiple: true }, settings: { type: 'string' }, 'data-dir': { type: 'string' },
    'codex-model': { type: 'string' }, 'claude-model': { type: 'string' }, 'cursor-model': { type: 'string' },
    format: { type: 'string', default: 'text' }, workline: { type: 'string' }, color: { type: 'string', default: 'auto' },
    'read-only': { type: 'boolean' }, refresh: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }
  } });
  if (v.help) return void process.stdout.write(help);
  if (v.version) return void process.stdout.write(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version + '\n');
  if (positionals.length > 1 || (positionals[0] && !['brief', 'ui'].includes(positionals[0]))) throw new Error('未知命令。请运行 agent-note --help。');
  if (!['text', 'markdown', 'json'].includes(v.format)) throw new Error('--format 必须为 text、markdown 或 json。');
  if (!['auto', 'always', 'never'].includes(v.color)) throw new Error('--color 必须为 auto、always 或 never。');
  if (v.source && !['all', 'codex', 'claude', 'copilot', 'cursor'].includes(v.source)) throw new Error('--source 必须为 all、codex、claude、copilot 或 cursor。');
  if (v.compiler && !['codex', 'claude', 'cursor'].includes(v.compiler)) throw new Error('--compiler 必须为 codex、claude 或 cursor。');
  if (v['read-only'] && v.refresh) throw new Error('--read-only 与 --refresh 不能同时使用。');
  if (v.timezone) {
    new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format();
    process.env.TZ = v.timezone;
  }
  if (positionals[0] === 'ui' && (v.format !== 'text' || v.workline || v.refresh)) throw new Error('ui 内使用菜单生成、深读和导出；这些参数请配合 brief 命令使用。');
  const interactive = positionals[0] === 'ui' || (!positionals[0] && !v.workline && !v.refresh && v.format === 'text' && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb');
  if (process.argv.length === 2 && !interactive) return void process.stdout.write(help);
  if (v['codex-model']) process.env.AGENT_NOTEBOOK_TODAY_CODEX_MODEL = v['codex-model'];
  if (v['claude-model']) process.env.AGENT_NOTEBOOK_TODAY_CLAUDE_MODEL = v['claude-model'];
  if (v['cursor-model']) process.env.AGENT_NOTEBOOK_TODAY_CURSOR_MODEL = v['cursor-model'];
  let settings;
  if (v.settings) {
    const document = JSON.parse(await fs.readFile(expand(v.settings), 'utf8'));
    settings = document.settings ?? document;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings 必须为 JSON 对象。');
  }
  const { brief } = await import('./service.mjs');
  const options = {
    date: v.date, project: v.project ? expand(v.project) : undefined, source: v.source, compiler: v.compiler,
    roots: v.root?.map(expand), settings, dataDir: v['data-dir'] ? expand(v['data-dir']) : undefined,
    readOnly: v['read-only'], refresh: v.refresh, workline: v.workline,
    onProgress(progress) {
      const labels = { scan: '发现会话', prepare: '运行 App 的 Today 流程（使用模型额度）', digest: '整理会话家族', 'index-synthesis': '合成工作脉络', 'dossier-analysis': '分析工作线', 'dossier-critique': '核查证据', 'dossier-compose': '生成深读' };
      process.stderr.write(clean(`  ${progress.status === 'ready' ? '✓' : '·'} ${labels[progress.stage] ?? progress.stage}${progress.sessionId ? ' · ' + progress.sessionId : ''}\n`));
    }
  };
  if (interactive) {
    const { runInteractive } = await import('./interactive.mjs');
    return runInteractive({ ...options, color: v.color });
  }
  const controller = new AbortController();
  const stop = () => { process.exitCode = 130; controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const view = await brief({ ...options, signal: controller.signal });
    process.stdout.write(render(view, v.format));
    if (view.mode === 'stale' || view.warnings.length || view.evidenceCoverage.some(e => ['failed', 'truncated'].includes(e.disposition)) || (view.index && !view.index.coverage.complete)) process.exitCode = 2;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
process.stdout.on('error', error => { if (error.code === 'EPIPE') process.exit(0); else throw error; });
main().catch(error => { process.stderr.write(`agent-note: ${clean(error.message)}\n`); process.exitCode ||= 1; });
