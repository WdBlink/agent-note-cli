import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { brief, readSource, sourceSession, conversationSession, worklineSessions, today, validateDate } from './service.mjs';
import { render } from './presentation.mjs';
import { Terminal } from './terminal.mjs';
import { version, checkForUpdate, readReleaseNotes, upgradeInstructions } from './updates.mjs';
import { inspectSessionTargets, jumpToSession } from './session-jump.mjs';

const sourceNames = { all: 'Codex + Claude + Copilot + Cursor', codex: 'Codex', claude: 'Claude Code', copilot: 'GitHub Copilot', cursor: 'Cursor' };
const modeNames = { raw: '尚未生成', compiled: '已保存', stale: '来源有变化' };
const expand = value => path.resolve(value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
const ref = index => index && ({ artifactId: index.artifactId, revision: index.revision, contentHash: index.contentHash });
const shiftDate = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const option = (id, label, hint, preview) => ({ id, label, hint, preview });

export async function runInteractive(initialOptions = {}, { terminal = new Terminal({ color: initialOptions.color }), service = brief, sourceReader = readSource, updateChecker = checkForUpdate,
  sessionInspector = inspectSessionTargets, sessionJumper = jumpToSession } = {}) {
  const options = { ...initialOptions, date: initialOptions.date ?? today(), workline: undefined, refresh: false };
  const preferenceFile = path.join(options.dataDir ?? path.join(os.homedir(), '.local/share/agent-note'), 'ui-preferences.json');
  let preferences = {}, preferenceError;
  try {
    preferences = JSON.parse(await fs.readFile(preferenceFile, 'utf8'));
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('设置必须是 JSON 对象。');
  } catch (error) {
    if (error.code !== 'ENOENT') preferenceError = error;
    preferences = {};
  }
  options.source ??= options.settings?.enabledSessionProviders
    ? options.settings.enabledSessionProviders.length === 1 ? options.settings.enabledSessionProviders[0] : 'all'
    : sourceNames[preferences.source] ? preferences.source : 'all';
  let view, snapshot;
  const updateContext = () => {
    terminal.context = `${options.date}  ·  ${sourceNames[options.source]}  ·  ${options.project ? path.basename(options.project) : '所有项目'}${options.readOnly ? '  ·  只读' : ''}`;
  };
  const invalidate = () => { view = undefined; snapshot = undefined; updateContext(); };
  const persistPreferences = async patch => {
    const next = { ...preferences, ...patch };
    await fs.mkdir(path.dirname(preferenceFile), { recursive: true, mode: 0o700 });
    const temporary = `${preferenceFile}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, preferenceFile);
      preferences = next;
    } finally { await fs.rm(temporary, { force: true }); }
  };

  async function perform(title, task) {
    while (!terminal.quit) {
      try { return await terminal.busy(title, task); } catch (error) {
        while (!terminal.quit) {
          const action = await terminal.menu({ title: `${title} / 未完成`, description: '已保存的内容仍然保留。',
          note: '选择查看详情可阅读完整错误。', items: [
            option('retry', '重试', '按相同范围再次执行', error.message),
            option('details', '查看错误详情', '来源、权限或模型错误', error.message),
            option('back', '返回', '继续浏览应用')
          ] });
          if (action?.id === 'details') {
            await terminal.read({ title: '错误详情', text: `${error.message}\n\n范围：${terminal.context}\n\n可返回首页调整日期、项目或来源；模型登录与权限需在对应 Provider CLI 中处理。` });
          } else if (action?.id === 'retry') break;
          else return undefined;
        }
      }
    }
  }

  async function load({ generate = false, refresh = false, workline, rescan = false } = {}) {
    const title = rescan ? '重新扫描来源' : workline ? '准备深读' : generate ? '整理工作脉络' : '读取简报与来源';
    const next = await perform(title, progress => service({ ...options, ...progress,
      readOnly: !generate, refresh, workline: workline?.worklineId,
      indexReference: workline ? ref(view?.index) : undefined
    }, { ...(workline && snapshot ? { snapshot } : {}), onSnapshot: value => { snapshot = value; } }));
    if (next) view = next;
    return next;
  }

  async function exportView() {
    if (!view) return;
    const format = await terminal.menu({ title: '导出', description: '导出当前阅读结果，保留来源与证据覆盖提示。', items: [
      option('markdown', 'Markdown 文档', '适合阅读、归档与笔记'), option('json', '完整 JSON', '保留 Index 与深读的结构化结果')
    ] });
    if (!format) return;
    const filename = await terminal.prompt({ title: '导出 / 保存位置', label: '文件路径',
      value: path.join(process.cwd(), `${options.date}-agent-note.${format.id === 'json' ? 'json' : 'md'}`),
      hint: '不会覆盖已有文件；可输入绝对路径或 ~/ 路径。',
      validate: async value => {
        if (!value || /[\r\n\0]/.test(value)) throw new Error('请输入有效文件路径。');
        try { await fs.access(expand(value)); throw new Error('文件已存在，请换一个文件名。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!(await fs.stat(path.dirname(expand(value)))).isDirectory()) throw new Error('父目录不存在。');
      }
    });
    if (filename === null) return;
    const saved = await perform('保存导出文件', async () => {
      await fs.writeFile(expand(filename), render(view, format.id), { flag: 'wx', mode: 0o600 });
      return true;
    });
    if (saved) await terminal.read({ title: '导出完成', text: `已保存\n\n${expand(filename)}\n\n${format.id === 'json' ? '包含完整结构化结果。' : '可用文本编辑器或笔记应用打开。'}` });
  }

  let jumpNotice = '';
  const sessionLabel = session => `${sourceNames[session.platform] ?? session.platform} · ${session.title || session.id}`;
  const sessionContext = session => `${session.worktreePath ?? session.projectPath ?? '项目未知'}\n会话 ID：${session.id}`;
  const sourceSummary = workline => {
    const sessions = worklineSessions(view, workline);
    return sessions.length ? `来源会话：${sessions.slice(0, 2).map(sessionLabel).join('；')}${sessions.length > 2 ? ` 等 ${sessions.length} 个会话` : ''}` : '来源会话：暂无可定位的主会话';
  };
  async function jump(sessions) {
    jumpNotice = '';
    if (!sessions.length) {
      await terminal.read({ title: '直达会话 / 未打开', text: '没有找到与当前来源对应的主会话。请重新扫描来源；不会按标题猜测或新建会话。' });
      return;
    }
    try {
      const states = await terminal.busy('定位会话窗口', ({ signal }) => sessionInspector(sessions, { signal }));
      if (!states || terminal.quit) return;
      let state = states[0];
      if (states.length > 1) {
        const selected = await terminal.menu({ title: '直达会话', description: '选择要继续沟通的来源会话。', searchable: true, enterLabel: '直达', items: states.map((item, i) => ({
          ...option(String(i), sessionLabel(item.session), item.targets.map(t => t.label).join(' / ') || '未定位窗口',
            `${sessionLabel(item.session)}\n\n${sessionContext(item.session)}\n\n${item.reason || item.targets.map(t => t.label).join('\n')}`), state: item
        })) });
        if (!selected) return;
        state = selected.state;
      }
      if (!state.targets.length) {
        await terminal.read({ title: '直达会话 / 未打开', text: `${sessionLabel(state.session)}\n\n${state.reason}\n\n${sessionContext(state.session)}` });
        return;
      }
      let target = state.targets[0];
      if (state.targets.length > 1) {
        const selected = await terminal.menu({ title: '选择会话窗口', description: sessionLabel(state.session), enterLabel: '直达', items: state.targets.map(t => ({ ...option(t.id, t.label, '切换到现有窗口'), target: t })) });
        if (!selected) return;
        target = selected.target;
      }
      if (terminal.quit) return;
      const destination = await terminal.busy('直达会话', ({ signal }) => sessionJumper(state.session, target.id, { signal }));
      if (destination && !terminal.quit) jumpNotice = `已请求直达 ${destination} · 返回后继续阅读`;
    } catch (error) {
      await terminal.read({ title: '直达会话 / 未打开', text: `${error.message}\n\n未创建或恢复任何会话。可切回原窗口，或稍后重试。` });
    }
  }
  const jumpSource = id => jump([conversationSession(view, sourceSession(view, id))].filter(Boolean));

  async function sources(workline) {
    if (!view && !await load()) return;
    const items = view.index
      ? view.index.evidence.filter(e => !workline || workline.evidenceIds.includes(e.evidenceId)).map(e => ({
        ...option(e.evidenceId, sourceSession(view, e.evidenceId)?.title || path.basename(e.sourcePath), `${sourceNames[e.provider]} · ${e.range}`, `${e.sourcePath}\n\n冻结范围：${e.range}\n\nEnter 阅读原文 · o 直达会话${sourceSession(view, e.evidenceId)?.lineage?.origin === 'subagent' ? '（所属主会话）' : ''}`)
      }))
      : view.sessions.map(s => option(`${s.platform}:${s.id}:${s.path}`, s.title || s.id, `${s.platform} · ${s.projectPath ?? '项目未知'}`, s.path));
    let selection = 0;
    while (!terminal.quit) {
      const selected = await terminal.menu({ title: workline ? '工作线 / 来源' : '会话与来源', description: 'Enter 阅读冻结原文 · o 直达原会话继续沟通', initial: selection, note: jumpNotice, enterLabel: '原文', actions: { o: '直达' }, items: [
        ...items, option('coverage', '扫描与证据覆盖', `${view.sessions.length} 条会话`, view.diagnostic ?? '查看未读、失败与截断信息。')
      ], searchable: true });
      if (!selected) return;
      selection = Math.max(0, items.findIndex(item => item.id === selected.id));
      if (selected.action === 'o') { if (selected.id !== 'coverage') await jumpSource(selected.id); continue; }
      if (selected.id === 'coverage') {
        const coverage = [view.diagnostic, ...view.warnings, ...view.evidenceCoverage.map(e => `${e.disposition}  ${e.sourceId}\n${e.detail}`)].filter(Boolean);
        await terminal.read({ title: '扫描与证据覆盖', text: coverage.length ? coverage.join('\n\n') : '未记录扫描异常。' });
      } else {
        const transcript = await perform('读取冻结原文', () => sourceReader(view, selected.id));
        if (transcript) {
          const position = {};
          const session = sourceSession(view, selected.id);
          const text = [
            ...(session ? [sessionLabel(session), `会话 ID：${session.id}${session.lineage?.origin === 'subagent' ? '\n直达将返回所属主会话。' : ''}`] : []),
            transcript.path, transcript.warning, transcript.truncated ? '注意：当前显示经过截断。' : '',
            ...transcript.messages.map(m => `${m.role === 'user' ? ({ human: '用户', agent: 'Agent 指令', automation: '自动任务' }[m.authorKind] ?? '用户角色（身份未确认）') : '助手'}  ${m.timestamp ?? ''}\n${m.content}`),
            `已省略工具事件：${transcript.omittedToolEvents}`
          ].filter(Boolean).join('\n\n');
          let action;
          do {
            action = await terminal.read({ title: `来源 / ${selected.label}`, text, position, note: jumpNotice, actions: { o: '直达会话' } });
            if (action === 'o') await jumpSource(selected.id);
          } while (action && !terminal.quit);
        }
      }
    }
  }

  async function worklineDetail(workline) {
    if (view.dossier?.worklineId !== workline.worklineId) view = { ...view, dossier: null };
    const position = {};
    const participation = workline.participation.status === 'undetermined' ? workline.participation.reason :
      [['human', '你的参与'], ['agent', 'Agent 的参与'], ['joint', '共同推进']].filter(([key]) => workline.participation[key]).map(([key, label]) => `${label}：${workline.participation[key]}`).join('\n');
    while (!terminal.quit) {
      const action = await terminal.read({ title: '工作线', markdown: true, text: `# ${workline.title}\n\n${sourceSummary(workline)}\n\n${workline.summary}\n\n## 当前停在\n\n${workline.currentStop}\n\n## 可能变化 · AI 判断，尚未采纳\n\n${workline.possibleChange}\n\n## 参与情况\n\n${participation}\n\n来源：${workline.evidenceIds.length} 项\n版本：${view.index.revision}${view.mode === 'stale' ? '\n来源有变化；当前阅读已保存版本。' : ''}`,
        position, note: jumpNotice, actions: { o: '直达会话', d: options.readOnly ? '阅读已存深读' : '深读', s: '来源', e: '导出' } });
      if (!action) return;
      if (action === 'o') await jump(worklineSessions(view, workline));
      if (action === 's') await sources(workline);
      if (action === 'e') await exportView();
      if (action === 'd') {
        // Bind selection to the displayed ID and revision; never reinterpret an ordinal after a scan.
        let saved;
        try {
          saved = await terminal.busy('读取已存深读', progress => service({ ...options, ...progress, readOnly: true,
            workline: workline.worklineId, indexReference: ref(view.index) }, { snapshot }));
        } catch (error) {
          if (!error.message.includes('尚未生成深读')) { await terminal.read({ title: '深读未打开', text: error.message }); continue; }
          if (options.readOnly) { await terminal.read({ title: '尚无深读', text: '当前处于只读模式。这条工作线还没有已保存的深读。' }); continue; }
          const choice = await terminal.menu({ title: '准备深读', description: workline.title, items: [
            option('generate', '生成这条工作线的深读', '将发送选定证据并使用模型额度', '分析工作线 → 核查证据 → 生成深读\n\n只处理当前选定工作线，完成后保存在本地。'),
            option('back', '返回工作线', '继续阅读简报')
          ] });
          if (choice?.id === 'generate') saved = await load({ generate: true, workline });
        }
        if (saved?.dossier) {
          view = saved;
          const d = saved.dossier.content;
          const text = [`# ${d.title}`, sourceSummary(workline), ...[['priorContext', '之前的背景'], ['whatHappened', '发生了什么'], ['possibleChange', '可能的变化 · 尚未采纳'], ['falsifiableObservation', '如何验证'], ['humanQuestion', '留给你的问题']].map(([key, label]) => `## ${label}\n\n${d[key]}`),
            ...[['supportingEvidence', '支持证据'], ['opposingEvidence', '相反证据']].filter(([key]) => d[key].length).map(([key, label]) => `## ${label}\n\n${d[key].map(e => `${e.claim}\n[${e.evidenceIds.join(', ')}]`).join('\n\n')}`),
            ...(d.gaps.length ? [`## 证据缺口\n\n${d.gaps.join('\n')}`] : []),
            ...(saved.dossier.validation.critiqueIssues.length ? [`## 核查提出的问题\n\n${saved.dossier.validation.critiqueIssues.join('\n')}\n\n最终结论仍需对照原文判断。`] : [])
          ].join('\n\n');
          const position = {};
          let key;
          do {
            key = await terminal.read({ title: '工作线 / 深读', markdown: true, text, position, note: jumpNotice, actions: { o: '直达会话', s: '来源', e: '导出' } });
            if (key === 'o') await jump(worklineSessions(view, workline));
            if (key === 's') await sources(workline);
            if (key === 'e') await exportView();
          } while (key && !terminal.quit);
        }
      }
    }
  }

  async function browse() {
    if (!view && !await load()) return;
    let selectedId;
    let scanNotice = '';
    while (!terminal.quit) {
      const worklines = view.index?.worklines ?? [];
      const items = worklines.map(w => option(w.worklineId, w.title, w.currentStop, `${w.summary}\n\n当前停在\n${w.currentStop}\n\n${w.evidenceIds.length} 项来源 · ${w.sessionIds.length} 个会话`));
      if (!options.readOnly && view.sessions.length) items.push(option('generate', view.index ? '重新整理工作脉络' : '生成这一天的简报', '使用模型额度 · 已保存版本会保留', '将当前范围的会话证据发送给所选模型服务。\n\n已有内容保持可读，完成后发布新版本。'));
      items.push(option('sources', '会话与来源', `${view.sessions.length} 条会话 · 查看原文及覆盖范围`));
      if (view.index) items.push(option('export', '导出当前结果', 'Markdown / JSON'));
      items.push(option('rescan', '重新扫描', '只检查来源与已存结果，不调用模型'));
      const choice = await terminal.menu({ title: '工作脉络', description: scanNotice || (worklines.length ? `${worklines.length} 条工作线 · ${modeNames[view.mode]}` : view.sessions.length ? '会话已就绪，选择生成简报开始整理。' : '这一天没有发现会话。可返回调整日期、项目或来源。'),
        items, searchable: true, initial: Math.max(0, items.findIndex(i => i.id === selectedId)), note: view.mode === 'stale' ? '来源已有变化 · 当前显示已保存版本' : view.diagnostic ?? '' });
      if (!choice) return;
      selectedId = choice.id;
      scanNotice = '';
      if (choice.id === 'generate') {
        const next = await load({ generate: true, refresh: Boolean(view.index) });
        if (next?.index?.worklines.length) selectedId = next.index.worklines[0].worklineId;
      }
      else if (choice.id === 'rescan') {
        const next = await load({ rescan: true });
        scanNotice = next ? `扫描完成 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · ${next.sessions.length} 条会话 · ${next.index?.worklines.length ?? 0} 条工作线`
          : '扫描未完成 · 仍显示上次结果';
      }
      else if (choice.id === 'sources') await sources();
      else if (choice.id === 'export') await exportView();
      else {
        await worklineDetail(worklines.find(w => w.worklineId === choice.id));
        view = { ...view, dossier: null };
      }
    }
  }

  async function dates() {
    const choice = await terminal.menu({ title: '日期', description: '切换阅读日期，当前已保存的内容不会丢失。', items: [
      ...Array.from({ length: 7 }, (_, i) => { const date = shiftDate(today(), -i); return option(date, `${i === 0 ? '今天' : i === 1 ? '昨天' : '    '}  ${date}`, date === options.date ? '当前选择' : '阅读这一天'); }),
      option('manual', '其他日期', '输入 YYYY-MM-DD')
    ] });
    if (!choice) return;
    const date = choice.id === 'manual' ? await terminal.prompt({ title: '选择日期', label: '日期', value: options.date, hint: '格式：YYYY-MM-DD', validate: validateDate }) : choice.id;
    if (date) { options.date = date; invalidate(); await browse(); }
  }

  async function projects() {
    const all = await perform('发现项目', progress => service({ ...options, ...progress, project: undefined, readOnly: true }));
    if (!all) return;
    const paths = [...new Set(all.sessions.map(s => s.projectPath).filter(Boolean))].sort();
    const choice = await terminal.menu({ title: '项目', description: '按当前日期已发现的会话选择；也可直接输入项目路径。', searchable: true, items: [
      option('all', '所有项目', '取消项目筛选'), ...paths.map(p => option(p, path.basename(p), p)), option('manual', '输入项目路径', '包含该目录及子目录中的主会话家族')
    ] });
    if (!choice) return;
    const selected = choice.id === 'manual' ? await terminal.prompt({ title: '项目路径', label: '项目目录', value: options.project ?? process.cwd(), hint: '可选择历史项目；不要求目录目前仍存在。', validate: value => { if (!value) throw new Error('请输入项目路径。'); } }) : choice.id;
    if (selected !== null) { options.project = selected === 'all' ? undefined : expand(selected); invalidate(); }
  }

  async function providers() {
    const choice = await terminal.menu({ title: '会话来源', description: '选择本地会话来源。生成使用 Codex、Claude Code 或 Cursor Agent CLI；--compiler 可固定整理模型，Copilot 使用已配置的模型 CLI。', items: [
      option('codex', 'Codex', options.source === 'codex' ? '当前选择' : '只读取 Codex 会话，并用 Codex CLI 整理'),
      option('claude', 'Claude Code', options.source === 'claude' ? '当前选择' : '只读取 Claude Code 会话，并用 Claude Code CLI 整理'),
      option('copilot', 'GitHub Copilot', options.source === 'copilot' ? '当前选择' : '读取本地 Copilot CLI 会话'),
      option('cursor', 'Cursor', options.source === 'cursor' ? '当前选择' : '只读取 Cursor Agent transcript，并用 Cursor Agent CLI 整理'),
      option('all', '全部来源', options.source === 'all' ? '当前选择' : 'Codex、Claude Code、Copilot 与 Cursor')
    ] });
    if (choice) {
      options.source = choice.id;
      if (choice.id === 'all') options.settings = { ...options.settings, enabledSessionProviders: ['codex', 'claude', 'copilot', 'cursor'] };
      invalidate();
      await perform('保存来源偏好', async () => { await persistPreferences({ source: options.source }); return true; });
    }
  }

  const help = '在终端里，读懂和 Agent 一起推进的工作。\n\n基本操作\n↑↓、j / k 或 Ctrl-N/P 移动，Enter 打开，Esc 返回，q 或 Ctrl-C 退出。列表按 / 搜索，数字 1–9 可直接打开对应项。\n\n长文阅读\n↑↓、j / k 或 Ctrl-N/P 逐行滚动。Ctrl-F/B 整页翻动，Ctrl-D/U 半页翻动；Emacs 可用 Ctrl-V / Alt-V。PageDown/Up 同样可用，Space 保留向下翻页。g / G 或 Home / End 跳转首尾。工作线中 o 直达会话，d 深读，s 查看来源，e 导出。来源列表 Enter 阅读原文、o 直达；多个会话先选择。直达只切换现有窗口，状态不明时不会另开 CLI 进程。\n\n模型调用\n浏览和切换范围只读取会话与已保存结果。只有选择生成简报、重新整理或首次深读才调用模型并使用额度。进度页按 Esc 取消；已保存的结果仍保留。\n\n来源与版本\n来源按冻结范围校验后打开。工作线选择绑定到看到的版本；列表变化时会提示重新选择。\n\n脚本接口\nagent-note brief --read-only --format json\nagent-note brief --date YYYY-MM-DD --source codex\nagent-note ui --source claude\n\n数据\n来源偏好保存在 UI 设置中。日期与项目只影响本次浏览。Provider 的登录和模型默认值由宿主机配置管理。';

  const updateController = new AbortController();
  let updateStatus = process.env.AGENT_NOTE_NO_UPDATE_CHECK === '1' ? '自动检查已关闭' : '正在后台检查更新…';
  let releaseNotes;
  const showReleaseNotes = async title => {
    try { releaseNotes ??= await readReleaseNotes(); }
    catch { await terminal.read({ title: '更新说明暂不可用', text: upgradeInstructions }); return false; }
    await terminal.read({ title, text: `${releaseNotes}\n\n## 如何更新\n\n${upgradeInstructions}`, markdown: true, note: () => updateStatus });
    return true;
  };
  terminal.start();
  try {
    if (process.env.AGENT_NOTE_NO_UPDATE_CHECK !== '1') {
      void Promise.resolve().then(() => updateChecker({ signal: updateController.signal })).then(latest => {
        updateStatus = latest ? `发现新版本 v${latest} · 打开「版本与更新」查看升级方法` : `v${version} · 当前已是最新版本`;
      }, () => { updateStatus = '暂时无法检查更新 · 下次启动时重试'; }).then(() => {
        if (!updateController.signal.aborted) terminal.draw?.();
      });
    }
    updateContext();
    await terminal.transition();
    if (preferenceError) await terminal.read({ title: '设置读取失败', text: `${preferenceFile}\n\n${preferenceError.message}\n\n本次使用默认来源；可在首页重新选择并保存来源。` });
    if (!terminal.quit && preferences.lastSeenVersion !== version && await showReleaseNotes(`本次更新 / v${version}`) && !preferenceError) {
      try { await persistPreferences({ lastSeenVersion: version }); }
      catch (error) { await terminal.read({ title: '更新阅读状态未保存', text: `${error.message}\n\n下次启动可能再次显示本次更新说明。` }); }
    }
    let homeSelection = 0;
    while (!terminal.quit) {
      const choice = await terminal.menu({ title: '首页', initial: homeSelection, description: '今天，和 Agent 一起推进了什么？', note: () => updateStatus, items: [
        option('brief', '工作脉络', view?.index ? `${view.index.worklines.length} 条工作线 · ${modeNames[view.mode]}` : '阅读简报，按工作线继续深读', 'WORK / 工作脉络\n\n从会话里找回推进的事情、当前停点和你的参与。\n\n已有简报直接阅读，新的整理由你发起。'),
        option('dates', '回看日期', options.date, 'HISTORY / 回看\n\n选择今天、最近几天或任意日期。\n\n每一天都保留自己的工作脉络。'),
        option('projects', '选择项目', options.project ?? '所有项目', 'SCOPE / 范围\n\n只关注一个项目，或查看一天里跨项目的工作。'),
        option('providers', '会话来源', sourceNames[options.source], 'SOURCES / 来源\n\n选择 Codex、Claude Code、Copilot、Cursor，或同时读取全部来源。'),
        option('sources', '浏览会话原文', '查看来源、冻结证据和覆盖信息', 'EVIDENCE / 证据\n\n不生成摘要也能阅读已发现的对话。\n\n已整理的引用按冻结范围校验。'),
        option('help', '使用帮助', '按键、模型调用与数据位置', 'GUIDE / 使用帮助\n\n随时按 Esc 返回。\n\n所有操作都在当前终端内完成。'),
        option('updates', '版本与更新', `当前 v${version} · 更新说明与升级方法`, upgradeInstructions)
      ] });
      if (!choice) break;
      homeSelection = ['brief', 'dates', 'projects', 'providers', 'sources', 'help', 'updates'].indexOf(choice.id);
      if (choice.id === 'brief') await browse();
      if (choice.id === 'dates') await dates();
      if (choice.id === 'projects') await projects();
      if (choice.id === 'providers') await providers();
      if (choice.id === 'sources') await sources();
      if (choice.id === 'help') await terminal.read({ title: '使用帮助', text: help });
      if (choice.id === 'updates') await showReleaseNotes(`版本与更新 / v${version}`);
    }
    await terminal.transition(true);
  } finally { updateController.abort(); terminal.close(); }
}
