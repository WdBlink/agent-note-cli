import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  loadAgentWorkSnapshot, DEFAULT_SETTINGS, NodeSqliteSaver,
  TraceinkAssetRepository, projectStructuredTodayReview,
  runStructuredTodayIndexPreparation, runStructuredTodayDossierPreparation,
  desktopCliRunner, structuredTodaySessionFamilies, StructuredTodayRuntimeStore,
  readBoundedTranscriptSource, parseSessionTranscript, sessionUserAuthorKind
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
  options.signal?.throwIfAborted();
  const date = validateDate(options.date ?? today());
  const settings = { ...structuredClone(DEFAULT_SETTINGS), ...(options.settings ?? {}) };
  if (options.roots?.length) settings.sessionScanRoots = options.roots;
  if (options.source && !['all', 'copilot'].includes(options.source)) settings.enabledSessionProviders = [options.source];
  const roots = settings.sessionScanRoots;
  if (!Array.isArray(roots) || !roots.length || roots.some(r => typeof r !== 'string' || !r.trim())) throw new Error('会话目录设置无效。');
  if (roots.some(r => !/codex|claude|copilot|cursor/i.test(r))) throw new Error('会话目录名称须包含 codex、claude、copilot 或 cursor，以便原后端识别来源。');
  if (!Array.isArray(settings.enabledSessionProviders) || !settings.enabledSessionProviders.length || settings.enabledSessionProviders.some(p => !['codex', 'claude', 'copilot', 'cursor'].includes(p))) throw new Error('请选择 Codex、Claude、Copilot 或 Cursor 会话来源。');
  for (const key of ['codexCliPath', 'claudeCliPath', 'cursorCliPath']) if (typeof settings[key] !== 'string' || !settings[key].trim()) throw new Error(`${key} 设置无效。`);
  if (options.compiler && !['codex', 'claude', 'cursor'].includes(options.compiler)) throw new Error('--compiler 必须为 codex、claude、copilot 或 cursor。');
  // Reading a source and compiling it are separate capabilities: a provider CLI can be
  // unavailable or unauthenticated on this machine while its transcripts are still readable.
  const compileSettings = options.compiler ? { ...settings, enabledSessionProviders: [options.compiler] } : settings;
  options.onProgress?.({ stage: 'scan', status: 'running' });
  const snapshot = dependencies.snapshot ?? await (dependencies.scan ?? loadAgentWorkSnapshot)(settings, {
    date, ...(options.source === 'copilot' ? { providers: ['copilot'] } : {}), fs: { stat: fs.stat, readdir: fs.readdir, readFile: fs.readFile, readBytes: fs.readFile, realpath: fs.realpath }, homeDir: os.homedir()
  });
  options.signal?.throwIfAborted();
  if (options.project) {
    const project = path.resolve(options.project);
    snapshot.sessions = structuredTodaySessionFamilies(snapshot.sessions).filter(({ root }) => {
      const p = root.projectPath && path.resolve(root.projectPath);
      return p && (p === project || p.startsWith(project + path.sep));
    }).flatMap(family => family.members);
  }
  dependencies.onSnapshot?.(snapshot);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scope = createHash('sha256').update(JSON.stringify({ roots, providers: options.source === 'copilot' ? ['copilot'] : settings.enabledSessionProviders, timeZone, project: options.project ? path.resolve(options.project) : null })).digest('hex').slice(0, 16);
  const dataDir = path.join(options.dataDir ?? path.join(os.homedir(), '.local/share/agent-note'), scope);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lock = path.join(dataDir, 'writer.lock');
  try { await fs.mkdir(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`已有 CLI 正在使用该数据范围；如果上次进程异常退出，请确认进程已结束后移除空锁目录：${lock}`);
    throw error;
  }
  let checkpointer;
  let runtimeStore;
  const runner = request => (dependencies.runner ?? desktopCliRunner)({ ...request, signal: options.signal });
  try {
    const repository = new TraceinkAssetRepository(path.join(dataDir, 'traceink-assets-v1.json'));
    const document = await repository.load();
    let review = projectStructuredTodayReview(document, date, snapshot.sessions);
    if (options.indexReference && ['artifactId', 'revision', 'contentHash'].some(key => options.indexReference[key] !== review.activeIndexReference?.[key])) {
      throw new Error('工作线列表已有新版本，请返回列表重新选择。');
    }
    if (!options.readOnly && snapshot.sessions.length && (!options.workline || !review.activeIndex) && (options.refresh || review.mode !== 'compiled')) {
      options.onProgress?.({ stage: 'prepare', status: 'running' });
      checkpointer = NodeSqliteSaver.fromConnectionString(path.join(dataDir, 'structured-today-workflows-v1.sqlite'));
      runtimeStore = new StructuredTodayRuntimeStore(path.join(dataDir, 'structured-today-runtime-v1.sqlite'));
      await checkpointer.prune(runtimeStore.listRuns().filter(r => r.status === 'ready').map(r => r.runId));
      await runStructuredTodayIndexPreparation({ logicalDate: date, snapshot, settings: compileSettings, repository, checkpointer, runtimeStore, runner, onProgress: options.onProgress });
      review = projectStructuredTodayReview(await repository.load(), date, snapshot.sessions);
    }
    let dossier;
    if (options.workline) {
      const selected = review.worklines.find((w, i) => w.workline.worklineId === options.workline || String(i + 1) === options.workline);
      if (!selected || !review.activeIndexReference) throw new Error('找不到工作线；请先运行 brief，再指定工作线编号或 ID。');
      dossier = selected.dossier;
      if (!dossier && !options.readOnly) {
        checkpointer ??= NodeSqliteSaver.fromConnectionString(path.join(dataDir, 'structured-today-workflows-v1.sqlite'));
        runtimeStore ??= new StructuredTodayRuntimeStore(path.join(dataDir, 'structured-today-runtime-v1.sqlite'));
        try {
          dossier = await runStructuredTodayDossierPreparation({ logicalDate: date, indexReference: review.activeIndexReference, worklineId: selected.workline.worklineId, settings: compileSettings, repository, checkpointer, runtimeStore, runner, onProgress: options.onProgress });
        } catch (error) {
          // Frozen evidence is verified byte for byte, so a transcript rewritten since the
          // index was compiled fails deep inside the reader with no way to act on it.
          if (!/封存会话原文.*(?:SHA-256|修改标识|提前结束|短于)/.test(error?.message ?? '')) throw error;
          throw new Error(`${error.message}\n这条工作线的会话原文在生成当前工作脉络之后发生了变化。请先运行 --refresh 重新整理，再深读。`);
        }
      }
      if (!dossier) throw new Error('这条工作线尚未生成深读；移除 --read-only 后可按 App 的相同流程生成。');
    }
    return { schema: 'agent-note-cli/view/v1', date, timeZone, mode: review.mode,
      index: review.activeIndex ?? null, dossier: dossier ?? null,
      sessions: snapshot.sessions, evidenceCoverage: snapshot.evidenceCoverage ?? [], warnings: snapshot.warnings,
      diagnostic: review.diagnostic ?? null, dataDir };
  } finally {
    try { checkpointer?.close(); } finally {
      try { runtimeStore?.close(); } finally { await fs.rmdir(lock); }
    }
  }
}

export function sourceSession(view, sourceId) {
  const evidence = view.index?.evidence.find(e => e.evidenceId === sourceId);
  const matches = view.sessions.filter(s => evidence
    ? s.path === evidence.sourcePath && s.platform === evidence.provider && (!evidence.sessionId || s.id === evidence.sessionId)
    : `${s.platform}:${s.id}:${s.path}` === sourceId);
  return matches.length === 1 ? matches[0] : undefined;
}

export function conversationSession(view, session) {
  if (!session || session.lineage?.origin !== 'subagent') return session;
  // Build each provider's families separately: providers can reuse a session ID.
  return structuredTodaySessionFamilies(view.sessions.filter(s => s.platform === session.platform))
    .find(family => family.members.includes(session))?.root;
}

export function worklineSessions(view, workline) {
  const sessions = workline.evidenceIds.map(id => conversationSession(view, sourceSession(view, id))).filter(Boolean);
  return [...new Set(sessions)];
}

export async function readSource(view, sourceId) {
  const evidence = view.index?.evidence.find(e => e.evidenceId === sourceId);
  const session = sourceSession(view, sourceId);
  const end = evidence && /^bytes 0-([1-9]\d*)$/.exec(evidence.range)?.[1];
  const capture = evidence && end ? {
    canonicalPath: evidence.sourcePath, sha256: evidence.contentHash, byteLength: Number(end),
    coverage: { startByte: 0, endByte: Number(end) }
  } : session?.transcriptCapture;
  if (!capture) throw new Error('此来源没有可校验的冻结原文。');
  const source = await readBoundedTranscriptSource(capture.canonicalPath, { origin: 'traceink-asset', transcriptCapture: capture });
  return parseSessionTranscript({ ...source, platform: evidence?.provider ?? session.platform,
    userAuthorKind: sessionUserAuthorKind(session ?? {}),
    sessionId: evidence?.sessionId ?? session?.id ?? sourceId,
    title: session?.title ?? sourceId, path: capture.canonicalPath });
}
