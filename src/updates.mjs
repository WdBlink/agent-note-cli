import fs from 'node:fs/promises';
import pkg from '../package.json' with { type: 'json' };

export const version = pkg.version;
export const releaseUrl = 'https://github.com/WdBlink/agent-note-cli/releases';
export const upgradeInstructions = `Homebrew 安装：\nbrew update\nbrew upgrade wdblink/tap/agent-note-cli\n\n其他安装方式：\n${releaseUrl}\n\n更新完成后重新启动 agent-note。`;

export function isNewer(candidate, current) {
  const parse = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : null;
  const next = parse(candidate), previous = parse(current);
  if (!next || !previous || ![...next, ...previous].every(Number.isSafeInteger)) return false;
  const difference = next.findIndex((part, i) => part !== previous[i]);
  return difference !== -1 && next[difference] > previous[difference];
}

export async function checkForUpdate({ signal, fetcher = fetch } = {}) {
  const response = await fetcher('https://api.github.com/repos/WdBlink/agent-note-cli/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])])
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  const release = await response.json();
  if (!release || typeof release.tag_name !== 'string' || release.draft || release.prerelease) throw new Error('无可用的稳定版本信息');
  const latest = release.tag_name.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('版本格式无效');
  return isNewer(latest, version) ? latest : null;
}

export async function readReleaseNotes() {
  return fs.readFile(new URL(`../docs/releases/v${version}.md`, import.meta.url), 'utf8');
}
