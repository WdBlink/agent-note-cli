import { Bot, Quote, UserRound } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import type { TodayWorklineIndexV1 } from "../../src/structured-today-contracts";
import type { SessionTranscriptRequest } from "./api";
import { structuredTranscriptEvidence } from "../../src/session-family";

export interface StructuredTodayEvidenceTarget {
  title: string;
  platform: "codex" | "claude" | "copilot";
  request: SessionTranscriptRequest;
  citation?: {
    label: string;
    evidenceId: string;
    precision: "session";
  };
}

export interface StructuredTodayCitationTarget {
  evidenceId: string;
  label: string;
  aliases: string[];
  provider: "codex" | "claude" | "copilot";
  title: string;
  target: StructuredTodayEvidenceTarget;
}

export function createStructuredTodayCitationTargets(
  index: TodayWorklineIndexV1,
  evidenceIds: string[],
  labelPrefix: "E" | ""
): StructuredTodayCitationTarget[] {
  return evidenceIds.flatMap((evidenceId, position) => {
    const evidence = structuredTranscriptEvidence(index.evidence.find((item) => item.evidenceId === evidenceId));
    if (!evidence) return [];
    const session = index.sessions.find((item) =>
      item.sessionId === evidence.sessionId &&
      item.provider === evidence.provider &&
      item.sourcePath === evidence.sourcePath
    );
    if (!session && !index.sessions.some((item) => item.evidenceIds.includes(evidenceId))) return [];
    const title = session?.title ?? `子 Agent · ${evidence.sessionId}`;
    const number = String(position + 1);
    const label = `${labelPrefix}${number}`;
    return [{
      evidenceId,
      label,
      aliases: [number, `E${number}`],
      provider: evidence.provider,
      title,
      target: {
        title,
        platform: evidence.provider,
        request: {
          id: evidence.sessionId,
          platform: evidence.provider,
          path: evidence.sourcePath,
          structuredTodayRef: {
            artifactId: index.artifactId,
            revision: index.revision,
            contentHash: index.contentHash,
            logicalDate: index.logicalDate,
            evidenceId
          }
        },
        citation: {
          label: `[${label}]`,
          evidenceId,
          precision: "session"
        }
      }
    }];
  });
}

export function InlineCitationText({
  text,
  targets,
  onOpen
}: {
  text: string;
  targets: StructuredTodayCitationTarget[];
  onOpen: ((target: StructuredTodayEvidenceTarget, returnFocus: HTMLElement) => void) | undefined;
}): ReactElement {
  const byAlias = new Map(targets.flatMap((target) => target.aliases.map((alias) => [alias, target] as const)));
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\[(E?\d+)\]/g)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const alias = match[1]!;
    const target = byAlias.get(alias);
    parts.push(target
      ? <CitationButton key={`${start}:${alias}`} target={target} displayLabel={alias} onOpen={onOpen} />
      : match[0]);
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function EvidenceCitationList({
  evidenceIds,
  targets,
  onOpen
}: {
  evidenceIds: string[];
  targets: StructuredTodayCitationTarget[];
  onOpen: ((target: StructuredTodayEvidenceTarget, returnFocus: HTMLElement) => void) | undefined;
}): ReactElement {
  const byId = new Map(targets.map((target) => [target.evidenceId, target]));
  return (
    <span className="structured-today-citation-list" aria-label="引用来源">
      <Quote size={13} aria-hidden="true" />
      {evidenceIds.map((evidenceId) => {
        const target = byId.get(evidenceId);
        return target
          ? <CitationButton key={evidenceId} target={target} displayLabel={target.label} onOpen={onOpen} />
          : <code key={evidenceId}>{evidenceId}</code>;
      })}
    </span>
  );
}

function CitationButton({
  target,
  displayLabel,
  onOpen
}: {
  target: StructuredTodayCitationTarget;
  displayLabel: string;
  onOpen: ((target: StructuredTodayEvidenceTarget, returnFocus: HTMLElement) => void) | undefined;
}): ReactElement {
  const providerLabel = target.provider === "codex" ? "Codex" : "Claude Code";
  return (
    <button
      type="button"
      className="structured-today-citation"
      title={`${providerLabel} · ${target.title}`}
      aria-label={`打开引用 ${displayLabel}：${providerLabel} · ${target.title}`}
      onClick={(event) => onOpen?.(target.target, event.currentTarget)}
    >
      {target.provider === "codex" ? <Bot size={11} aria-hidden="true" /> : <UserRound size={11} aria-hidden="true" />}
      <span>{displayLabel}</span>
    </button>
  );
}
