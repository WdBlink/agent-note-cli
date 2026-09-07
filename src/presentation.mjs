import { stripVTControlCharacters } from 'node:util';
export const clean = text => stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '');

export function render(view, format = 'text') {
  if (format === 'json') return JSON.stringify(view, null, 2) + '\n';
  const md = format === 'markdown';
  const h = (depth, text) => `${md ? '#'.repeat(depth) + ' ' : ''}${text}`;
  const lines = [h(1, `Agent Note · ${view.date}`), `${view.timeZone} · ${view.mode} · ${view.sessions.length} 条会话`, ''];
  if (!view.index) lines.push(view.sessions.length ? '尚未整理。运行 agent-note brief 生成与 App 相同的工作脉络。' : '当天没有发现可用会话。', '');
  if (view.diagnostic) lines.push(view.diagnostic, '');
  if (view.index) {
    const index = view.index;
    lines.push(`工作线 ${index.worklines.length} · 已归属 ${index.coverage.assigned}/${index.coverage.admitted} · 未解决 ${index.coverage.unresolved} · 失败 ${index.coverage.failed}`, '');
    for (const [i, w] of index.worklines.entries()) {
      lines.push(h(2, `${String(i + 1).padStart(2, '0')}  ${w.title}`), w.summary, '', `当前停在：${w.currentStop}`, `可能变化（AI 判断，尚未采纳）：${w.possibleChange}`);
      if (w.participation.status === 'undetermined') lines.push(`参与情况：${w.participation.reason}`);
      else for (const [k, label] of [['human', '你的参与'], ['agent', 'Agent 的参与'], ['joint', '共同推进']]) if (w.participation[k]) lines.push(`${label}：${w.participation[k]}`);
      lines.push(`证据：${w.evidenceReadiness} · 会话 ${w.sessionIds.join(', ')}`, `来源：${w.evidenceIds.join(', ')}`, `工作线 ID：${w.worklineId}`, '');
    }
    for (const d of index.dispositions) if (d.kind !== 'assigned') lines.push(`${d.sessionId} · ${d.kind} · ${d.reason}`);
    lines.push(h(2, '来源'), ...index.evidence.map(e => `${e.evidenceId}\n  ${e.sourcePath} · ${e.range}`), '');
  }
  if (view.dossier) {
    const d = view.dossier.content;
    lines.push(h(2, d.title));
    for (const [key, label] of [['priorContext', '之前的背景'], ['whatHappened', '发生了什么'], ['possibleChange', '可能的变化'], ['falsifiableObservation', '如何验证'], ['humanQuestion', '留给你的问题']]) lines.push(h(3, label), d[key], '');
    for (const [key, label] of [['supportingEvidence', '支持证据'], ['opposingEvidence', '相反证据']]) if (d[key].length) lines.push(h(3, label), ...d[key].map(e => `${e.claim} [${e.evidenceIds.join(', ')}]`), '');
    if (d.gaps.length) lines.push(h(3, '证据缺口'), ...d.gaps, '');
  }
  const gaps = view.evidenceCoverage.filter(e => ['failed', 'truncated', 'unresolved'].includes(e.disposition));
  if (view.warnings.length || gaps.length) lines.push(h(2, '覆盖范围提示'), ...view.warnings, ...gaps.map(e => `${e.sourceId} · ${e.detail}`), '');
  return clean(lines.join('\n')) + '\n';
}
