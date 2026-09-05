import type {
  TraceinkEvidenceRefV1,
  TraceinkIndexArtifactV1,
  TraceinkWorklineSelectionV1
} from "./traceink-review-assets";
import { traceinkWorklineSelections } from "./traceink-index-navigation";

export interface TraceinkWorklinePresentationV1 {
  selection: TraceinkWorklineSelectionV1;
  /** Exact source slice. It is never rewritten and remains subordinate to artifact.rawMarkdown. */
  rawMarkdown: string;
  timeText?: string;
  statusText?: string;
  participationText?: string;
  currentStopMarkdown?: string;
  changeSignalMarkdown?: string;
  resultMarkdown?: string;
  evidenceReadinessText?: string;
  evidenceIds: string[];
}

interface WorklineSection {
  ordinal: number;
  start: number;
  end: number;
  rawMarkdown: string;
}

const NUMBERED_BOLD = /^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/gm;
const NUMBERED_HEADING = /^\s*#{2,4}\s+(\d+)[.、]\s+(.+?)\s*$/gm;
const FIELD_LINE = /^\s*\*\*(.+?)[：:]\*\*\s*(.*)$/;

/**
 * Builds a fallible display sidecar from the canonical Markdown. It never
 * filters, rewrites, or replaces the source document.
 */
export function traceinkIndexPresentation(index: TraceinkIndexArtifactV1): TraceinkWorklinePresentationV1[] {
  const selections = traceinkWorklineSelections(index);
  const sections = worklineSections(index.rawMarkdown);
  return selections.flatMap((selection) => {
    const section = sections.find((candidate) => candidate.ordinal === selection.ordinal);
    if (!section) return [];
    const fields = boldFields(section.rawMarkdown);
    return [{
      selection,
      rawMarkdown: section.rawMarkdown,
      ...optionalField("timeText", firstField(fields, ["时间", "时间范围"])),
      ...optionalField("statusText", firstField(fields, ["状态", "当前状态"])),
      ...optionalField("participationText", firstField(fields, ["参与", "参与方式", "参与标记"])),
      ...optionalField("currentStopMarkdown", firstField(fields, ["当前停点", "当前停止点"])),
      ...optionalField("changeSignalMarkdown", firstField(fields, [
        "可能产生的变化",
        "可能的变化信号",
        "变化信号",
        "已经明确的方向"
      ])),
      ...optionalField("resultMarkdown", firstField(fields, ["结果", "今日运行结果"])),
      ...optionalField("evidenceReadinessText", firstField(fields, ["证据完整度", "证据可展开度", "证据就绪度"])),
      evidenceIds: evidenceIdsForSection(section.rawMarkdown, index.evidence)
    }];
  });
}

function worklineSections(markdown: string): WorklineSection[] {
  const matches = [...collect(markdown, NUMBERED_BOLD), ...collect(markdown, NUMBERED_HEADING)]
    .sort((left, right) => left.start - right.start);
  const firstByOrdinal = new Map<number, { ordinal: number; start: number }>();
  for (const match of matches) {
    if (!firstByOrdinal.has(match.ordinal)) firstByOrdinal.set(match.ordinal, match);
  }
  const first = [...firstByOrdinal.values()].sort((left, right) => left.start - right.start);
  return first.map((match, index) => {
    const end = first[index + 1]?.start ?? markdown.length;
    return {
      ordinal: match.ordinal,
      start: match.start,
      end,
      rawMarkdown: markdown.slice(match.start, end).trimEnd()
    };
  });
}

function collect(markdown: string, pattern: RegExp): Array<{ ordinal: number; start: number }> {
  pattern.lastIndex = 0;
  const result: Array<{ ordinal: number; start: number }> = [];
  for (const match of markdown.matchAll(pattern)) {
    const ordinal = Number(match[1]);
    if (Number.isSafeInteger(ordinal) && ordinal > 0) result.push({ ordinal, start: match.index ?? 0 });
  }
  return result;
}

function boldFields(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  let activeLabel: string | undefined;
  let activeLines: string[] = [];
  const flush = () => {
    if (!activeLabel) return;
    const value = activeLines.join("\n").trim();
    if (value) result.set(activeLabel, value);
  };
  for (const line of markdown.split(/\r?\n/)) {
    const field = line.match(FIELD_LINE);
    if (field) {
      flush();
      activeLabel = field[1]?.trim();
      activeLines = [field[2] ?? ""];
      continue;
    }
    if (!activeLabel) continue;
    if (/^\s*---\s*$/.test(line) || /^\s*#{1,6}\s+/.test(line)) {
      flush();
      activeLabel = undefined;
      activeLines = [];
      continue;
    }
    activeLines.push(line);
  }
  flush();
  return result;
}

function firstField(fields: Map<string, string>, labels: string[]): string | undefined {
  for (const label of labels) {
    const exact = fields.get(label);
    if (exact) return exact;
    const decorated = [...fields.entries()].find(([candidate]) => candidate.startsWith(label));
    if (decorated?.[1]) return decorated[1];
  }
  return undefined;
}

function optionalField<Key extends string>(key: Key, value: string | undefined): Partial<Record<Key, string>> {
  return value ? { [key]: value } as Record<Key, string> : {};
}

function evidenceIdsForSection(markdown: string, evidence: TraceinkEvidenceRefV1[]): string[] {
  const ids = new Set<string>();
  const codeMentions = [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]?.trim()).filter(Boolean) as string[];
  for (const item of evidence) {
    if (markdown.includes(item.path) || (item.sessionId && markdown.includes(item.sessionId))) {
      ids.add(item.id);
      continue;
    }
    if (!item.sessionId) continue;
    const uniquePrefix = codeMentions.some((mention) => {
      const prefix = mention.replace(/(?:…|\.\.\.)$/, "");
      if (prefix === mention || prefix.length < 8 || !item.sessionId!.startsWith(prefix)) return false;
      return evidence.filter((candidate) => candidate.sessionId?.startsWith(prefix)).length === 1;
    });
    if (uniquePrefix) ids.add(item.id);
  }
  return [...ids];
}
