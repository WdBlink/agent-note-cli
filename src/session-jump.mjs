import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const normalizeSpace = text => String(text ?? '').trim().replace(/\s+/g, ' ');
const provider = command => ({ codex: 'codex', claude: 'claude', 'claude.exe': 'claude' })[path.basename(command)];
const appProcess = process => /\/(?:Codex|ChatGPT)\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(process.command);
const ttyPath = tty => tty && tty !== '??' && tty !== '?' ? `/dev/${tty}` : undefined;

async function command(file, args, options = {}) {
  return (await exec(file, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024, ...options })).stdout;
}

function ancestors(process, processes) {
  const result = [], seen = new Set();
  while (process && !seen.has(process.pid)) {
    result.push(process); seen.add(process.pid); process = processes.find(p => p.pid === process.parent);
  }
  return result;
}

export function parseProcesses(text) {
  return text.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), tty: ttyPath(match[3]), started: normalizeSpace(match[4]), command: match[5] }] : [];
  });
}

function fileOwners(text) {
  const files = new Map();
  let pid;
  for (const line of text.split('\n')) {
    if (/^p\d+$/.test(line)) { pid = Number(line.slice(1)); files.set(pid, []); }
    if (line.startsWith('n') && files.has(pid)) files.get(pid).push(line.slice(1));
  }
  return files;
}

// Positive identity matches only. No title/cwd guesses and no resume/fork subprocesses.
export async function inspectSessionTargets(sessions, { run = command, readFile = fs.readFile, platform = process.platform,
  homeDir = os.homedir(), env = process.env, signal } = {}) {
  const states = sessions.map(session => ({ session, targets: [], reason: '' }));
  const eligible = states.filter(state => {
    const s = state.session;
    if (!s || !['codex', 'claude'].includes(s.platform)) state.reason = '本测试版支持 Codex 和 Claude Code 的现有会话。';
    else if (s.resumable !== true || !uuid.test(s.id) || typeof s.path !== 'string' || !path.isAbsolute(s.path) ||
      ['subagent', 'automation'].includes(s.lineage?.origin)) state.reason = '没有经过来源校验的主会话 ID。';
    return !state.reason;
  });
  if (!eligible.length) return states;
  if (!['darwin', 'linux'].includes(platform)) {
    for (const state of eligible) state.reason = '当前系统尚未接入窗口定位；未启动新的会话进程。';
    return states;
  }
  const options = { signal, env: { ...env, LC_ALL: 'C', TZ: 'UTC' } };
  let processes;
  try {
    processes = parseProcesses(await run('ps', ['-axo', 'pid=,ppid=,tty=,lstart=,comm='], options));
    if (!processes.length) throw new Error('empty process list');
  } catch {
    signal?.throwIfAborted();
    for (const state of eligible) state.reason = '无法读取会话进程状态；未尝试恢复会话。';
    return states;
  }
  const agents = processes.filter(p => provider(p.command));
  const apps = processes.filter(appProcess);
  const otty = platform === 'darwin' && processes.find(p => /\/Otty\.app\/Contents\/MacOS\/Otty$/.test(p.command));
  const ottyCli = otty && path.join(path.dirname(otty.command), 'otty-cli');
  let panes = [], owners = new Map(), tmuxPanes = [], inspectionFailed = false;
  const probes = await Promise.allSettled([
    ottyCli ? run(ottyCli, ['pane', 'list', '--json'], options).then(text => {
      const data = JSON.parse(text);
      if (!data.ok || !Array.isArray(data.data)) throw new Error('invalid pane list');
      panes = data.data;
    }) : undefined,
    agents.length ? run('lsof', ['-nP', '-a', '-p', agents.map(p => p.pid).join(','), '-Fpn'], options)
      .then(text => { owners = fileOwners(text); }) : undefined,
    env.TMUX ? run('tmux', ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_tty}\t#{session_id}\t#{window_id}'], options)
      .then(text => { tmuxPanes = text.trim().split('\n').map(line => {
        const [id, tty, session, window] = line.split('\t'); return { id, tty, session, window };
      }); }) : undefined
  ]);
  inspectionFailed = probes.some(result => result.status === 'rejected');
  signal?.throwIfAborted();

  const registryRoots = new Set([env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')]);
  for (const { session } of eligible) {
    if (session.platform === 'claude' && path.basename(path.dirname(path.dirname(session.path))) === 'projects') {
      registryRoots.add(path.dirname(path.dirname(path.dirname(session.path))));
    }
  }
  const claudeIds = new Map();
  // Claude closes transcript files between writes; its PID registry survives idle periods.
  await Promise.all(agents.filter(p => provider(p.command) === 'claude').map(async process => {
    for (const root of registryRoots) {
      try {
        const data = JSON.parse(await readFile(path.join(root, 'sessions', `${process.pid}.json`), 'utf8'));
        // procStart is written in UTC; reject stale PID reuse, even by another Claude process.
        if (data.pid === process.pid && normalizeSpace(data.procStart) === process.started && uuid.test(data.sessionId)) {
          claudeIds.set(process.pid, data.sessionId);
        }
      } catch { /* Missing/older registry versions remain unconfirmed, never evidence of closure. */ }
    }
  }));
  signal?.throwIfAborted();

  for (const state of eligible) {
    const s = state.session;
    const matches = agents.filter(p => provider(p.command) === s.platform &&
      (owners.get(p.pid)?.includes(s.path) || (s.platform === 'claude' && claudeIds.get(p.pid) === s.id)));
    for (const pane of panes) {
      const paneProvider = ({ Codex: 'codex', 'Claude Code': 'claude' })[pane.agent];
      if (paneProvider === s.platform && pane.agent_session_id === s.id && /^p_[a-zA-Z0-9_]+$/.test(pane.id)) {
        state.targets.push({ id: `otty:${pane.id}`, kind: 'otty', pane: pane.id, executable: ottyCli, label: `Otty · ${pane.id}` });
      }
    }
    for (const process of matches) {
      const chain = ancestors(process, processes);
      const app = s.platform === 'codex' && chain.find(appProcess);
      if (app) {
        if (!state.targets.some(target => target.kind === 'codex-app')) state.targets.push({ id: `codex-app:${app.pid}`, kind: 'codex-app', label: 'Codex app · 已载入' });
        continue;
      }
      if (!process.tty) continue;
      const pane = tmuxPanes.find(p => p.tty === process.tty && /^%\d+$/.test(p.id) && /^\$\d+$/.test(p.session) && /^@\d+$/.test(p.window));
      const terminal = chain.some(p => /\/iTerm[^/]*\.app\/Contents\/MacOS\/iTerm2$/.test(p.command)) ? 'iterm'
        : chain.some(p => /\/Terminal\.app\/Contents\/MacOS\/Terminal$/.test(p.command)) ? 'terminal' : undefined;
      if (pane) state.targets.push({ id: `tmux:${pane.id}:${process.pid}:${process.started}`, kind: 'tmux', pane: pane.id, session: pane.session, window: pane.window, label: `tmux · ${pane.id}` });
      else if (platform === 'darwin' && terminal) state.targets.push({ id: `${terminal}:${process.pid}:${process.started}`, kind: terminal, tty: process.tty, label: `${terminal === 'iterm' ? 'iTerm2' : 'Terminal'} · ${process.tty}` });
    }
    // The documented deep link opens this ID in the running app. Do not cross over from an
    // unlocated CLI/headless owner; an idle process need not hold its transcript open.
    const outsideApp = agents.some(p => provider(p.command) === 'codex' && !ancestors(p, processes).some(appProcess));
    if (!state.targets.length && s.platform === 'codex' && apps.length && !outsideApp && !inspectionFailed) {
      state.targets.push({ id: `codex-app:${apps[0].pid}`, kind: 'codex-app', label: 'Codex app · 打开原会话' });
    }
    if (!state.targets.length) state.reason = matches.length
      ? `会话已被进程使用${matches[0].tty ? `（${matches[0].tty}）` : ''}，但暂不能精确定位窗口。请切回原窗口继续。`
      : inspectionFailed ? '部分客户端状态读取失败，无法确认会话位置；未尝试恢复。'
        : '未定位到可直达的窗口。请先在原客户端打开会话，再重试；本测试版不会另开 CLI 进程。';
  }
  return states;
}

function terminalFocusScript(kind) {
  // Only the constant script contains AppleScript. The validated tty is passed as argv.
  return `on run argv
    tell application id "${kind === 'iterm' ? 'com.googlecode.iterm2' : 'com.apple.Terminal'}"
      repeat with w in windows
        repeat with t in tabs of w
          ${kind === 'iterm' ? 'repeat with s in sessions of t' : 'set s to t'}
            if tty of s is item 1 of argv then
              ${kind === 'iterm' ? 'select s\n              select t\n              select w' : 'set selected of t to true\n              set index of w to 1'}
              activate
              return "focused"
            end if
          ${kind === 'iterm' ? 'end repeat' : ''}
        end repeat
      end repeat
    end tell
    error "The original terminal is no longer available."
  end run`;
}

export async function jumpToSession(session, targetId, { inspect = inspectSessionTargets, run = command, signal } = {}) {
  // Selection can outlive a window or PID. Resolve again; never substitute a different target.
  const [state] = await inspect([session], { signal });
  const target = state.targets.find(candidate => candidate.id === targetId);
  if (!target) throw new Error('会话窗口状态已变化，请重新选择。未创建或恢复任何会话。');
  signal?.throwIfAborted();
  const options = { signal };
  if (target.kind === 'otty') await run(target.executable, ['pane', 'focus', '--pane', target.pane], options);
  else if (target.kind === 'codex-app') await run('/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${session.id}`], options);
  else if (target.kind === 'tmux') {
    await run('tmux', ['switch-client', '-t', target.pane], options);
  } else if (['iterm', 'terminal'].includes(target.kind) && /^\/dev\/tty[a-zA-Z0-9/]+$/.test(target.tty)) {
    await run('/usr/bin/osascript', ['-e', terminalFocusScript(target.kind), target.tty], options);
  } else throw new Error('当前会话窗口尚不支持直达。');
  return target.label;
}
