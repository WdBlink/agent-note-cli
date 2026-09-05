import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  loadAgentWorkSnapshot, DEFAULT_SETTINGS, NodeSqliteSaver,
  TraceinkAssetRepository, projectStructuredTodayReview,
  runStructuredTodayIndexPreparation, runStructuredTodayDossierPreparation,
  desktopCliRunner, structuredTodaySessionFamilies
} from '../dist/backend.mjs';

export function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('日期必须为有效的 YYYY-MM-DD。');
  return value;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function brief(options, dependencies = {}) {
  const date = validateDate(options.date ?? today());
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...(options.settings ?? {}) };
  if (options.roots?.length) settings.sessionScanRoots = options.roots;
  if (options.source && options.source !== 'all') settings.enabledSessionProviders = [options.source];
  const roots = settings.sessionScanRoots;
  if (!Array.isArray(roots) || !roots.length || roots.some(r => typeof r !== 'string' || !r.trim())) throw new Error('会话目录设置无效。');
  if (roots.some(r => !/codex|claude/i.test(r))) throw new Error('会话目录名称须包含 codex 或 claude，以便原后端识别来源。');
  if (!Array.isArray(settings.enabledSessionProviders) || !settings.enabledSessionProviders.length || settings.enabledSessionProviders.some(p => !['codex', 'claude'].includes(p))) throw new Error('请选择 Codex 或 Claude 会话来源。');
  for (const key of ['codexCliPath', 'claudeCliPath']) if (typeof settings[key] !== 'string' || !settings[key].trim()) throw new Error(`${key} 设置无效。`);
  options.onProgress?.({ stage: 'scan', status: 'running' });
  const snapshot = await (dependencies.scan ?? loadAgentWorkSnapshot)(settings, {
    date, fs: { stat: fs.stat, readdir: fs.readdir, readFile: fs.readFile, readBytes: fs.readFile, realpath: fs.realpath }, homeDir: os.homedir()
  });
  if (options.project) {
    const project = path.resolve(options.project);
    snapshot.sessions = structuredTodaySessionFamilies(snapshot.sessions).filter(({ root }) => {
      const p = root.projectPath && path.resolve(root.projectPath);
      return p && (p === project || p.startsWith(project + path.sep));
    }).flatMap(family => family.members);
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scope = createHash('sha256').update(JSON.stringify({ roots, providers: settings.enabledSessionProviders, timeZone, project: options.project ? path.resolve(options.project) : null })).digest('hex').slice(0, 16);
  const dataDir = path.join(options.dataDir ?? path.join(os.homedir(), '.local/share/agent-note'), scope);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, 'writer.lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有 CLI 正在使用该数据范围；如果上次进程异常退出，请确认进程已结束后移除空锁目录：${lock}`);
    throw error;
  }
  let checkpointer;
  try {
    const repository = new TraceinkAssetRepository(path.join(dataDir, 'traceink-assets-v1.json'));
    const document = await repository.load();
    let review = projectStructuredTodayReview(document, date, snapshot.sessions);
    if (!options.readOnly && snapshot.sessions.length && (options.refresh || review.mode !== 'compiled')) {
      options.onProgress?.({ stage: 'prepare', status: 'running' });
      checkpointer = NodeSqliteSaver.fromConnectionString(path.join(dataDir, 'structured-today-workflows-v1.sqlite'));
      await checkpointer.prune((document.structuredRuns ?? []).filter(r => r.status === 'ready').map(r => r.runId));
      await runStructuredTodayIndexPreparation({ logicalDate: date, snapshot, settings, repository, checkpointer, runner: dependencies.runner ?? desktopCliRunner, onProgress: options.onProgress });
      review = projectStructuredTodayReview(await repository.load(), date, snapshot.sessions);
    }
    let dossier;
    if (options.workline) {
      const selected = review.worklines.find((w, i) => w.workline.worklineId === options.workline || String(i + 1) === options.workline);
      if (!selected || !review.activeIndexReference) throw new Error('找不到工作线；请先运行 brief，再指定工作线编号或 ID。');
      dossier = selected.dossier;
      if (!dossier && !options.readOnly) {
        checkpointer ??= NodeSqliteSaver.fromConnectionString(path.join(dataDir, 'structured-today-workflows-v1.sqlite'));
        dossier = await runStructuredTodayDossierPreparation({ logicalDate: date, indexReference: review.activeIndexReference, worklineId: selected.workline.worklineId, settings, repository, checkpointer, runner: dependencies.runner ?? desktopCliRunner, onProgress: options.onProgress });
      }
      if (!dossier) throw new Error('这条工作线尚未生成深读；移除 --read-only 后可按 App 的相同流程生成。');
    }
    return { schema: 'agent-note-cli/view/v1', date, timeZone, mode: review.mode,
      index: review.activeIndex ?? null, dossier: dossier ?? null,
      sessions: snapshot.sessions, evidenceCoverage: snapshot.evidenceCoverage ?? [], warnings: snapshot.warnings,
      diagnostic: review.diagnostic ?? null, dataDir };
  } finally {
    checkpointer?.close();
    await fs.rmdir(lock);
  }
}
