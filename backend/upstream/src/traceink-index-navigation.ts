import { createHash } from "node:crypto";
import type { TraceinkIndexArtifactV1, TraceinkWorklineSelectionV1 } from "./traceink-review-assets";
import { traceinkArtifactReference } from "./traceink-review-assets";

const NUMBERED_BOLD = /^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*$/gm;
const NUMBERED_HEADING = /^\s*#{2,4}\s+(\d+)[.、]\s+(.+?)\s*$/gm;

/** Navigation only: the Markdown remains the semantic authority and is never rewritten. */
export function traceinkWorklineSelections(index: TraceinkIndexArtifactV1): TraceinkWorklineSelectionV1[] {
  const matches = [...collect(index.rawMarkdown, NUMBERED_BOLD), ...collect(index.rawMarkdown, NUMBERED_HEADING)]
    .sort((left, right) => left.position - right.position);
  const seen = new Set<number>();
  return matches.flatMap(({ ordinal, title }) => {
    if (seen.has(ordinal) || !title) return [];
    seen.add(ordinal);
    const digest = createHash("sha256")
      .update(`${index.outputHash}\0${ordinal}\0${title}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    return [{
      worklineId: `workline-${ordinal}-${digest}`,
      ordinal,
      title,
      sourceIndex: { ...traceinkArtifactReference(index), stage: "index" }
    }];
  });
}

function collect(markdown: string, pattern: RegExp): Array<{ ordinal: number; title: string; position: number }> {
  pattern.lastIndex = 0;
  const result: Array<{ ordinal: number; title: string; position: number }> = [];
  for (const match of markdown.matchAll(pattern)) {
    const ordinal = Number(match[1]);
    const title = match[2]?.trim() ?? "";
    if (Number.isSafeInteger(ordinal) && ordinal > 0 && title) {
      result.push({ ordinal, title, position: match.index ?? 0 });
    }
  }
  return result;
}
