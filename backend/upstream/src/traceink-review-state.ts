import type {
  TraceinkAssetStoreDocumentV1,
  TraceinkIndexArtifactReferenceV1
} from "../app/desktop/traceink-asset-store";
import {
  latestTraceinkDossier,
  latestTraceinkProposalDispositions,
  latestTraceinkProposals,
  latestTraceinkReflection
} from "../app/desktop/traceink-asset-store";
import {
  normalizeTraceinkArtifactReferenceV1,
  normalizeTraceinkArtifactV1,
  type TraceinkIndexArtifactV1,
  type TraceinkDossierArtifactV1,
  type TraceinkProposalCategoryV1,
  type TraceinkProposalDispositionV1,
  type TraceinkProposalsArtifactV1,
  type TraceinkWorklineSelectionV1,
  type UserReflectionAssetV1
} from "./traceink-review-assets";
import { traceinkWorklineSelections } from "./traceink-index-navigation";
import { traceinkIndexPresentation, type TraceinkWorklinePresentationV1 } from "./traceink-index-presentation";
import type { TodayBoardEvidenceRevision } from "./today-board";
import type { AgentWorkSession } from "./types";

export type TraceinkReviewMode = "raw" | "compiled" | "stale";

export interface TraceinkReviewProjection {
  mode: TraceinkReviewMode;
  activeIndex?: TraceinkIndexArtifactV1;
  activeIndexReference?: TraceinkIndexArtifactReferenceV1;
  uncompiledEvidence: TodayBoardEvidenceRevision[];
  diagnostic?: string;
  worklines?: TraceinkWorklineReviewState[];
}

export interface TraceinkWorklineReviewState {
  selection: TraceinkWorklineSelectionV1;
  presentation?: TraceinkWorklinePresentationV1;
  dossier?: TraceinkDossierArtifactV1;
  reflection?: UserReflectionAssetV1;
  proposals?: TraceinkProposalsArtifactV1;
  proposalItems: TraceinkProposalItemReviewState[];
}

export interface TraceinkProposalItemReviewState {
  proposalId: string;
  category: TraceinkProposalCategoryV1;
  proposalText: string;
  sourceQuote: string;
  evidenceIds: string[];
  latestDisposition?: TraceinkProposalDispositionV1;
}

interface ExactSessionRevision {
  identity: string;
  revision: string;
}

interface CurrentSessionManifest {
  exact: Map<string, ExactSessionRevision>;
  all: TodayBoardEvidenceRevision[];
  incompleteIdentities: Set<string>;
  conflictingIdentities: Set<string>;
}

interface StoredSessionManifest {
  exact: Map<string, ExactSessionRevision>;
  incompleteCount: number;
  conflictingCount: number;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXACT_BYTE_LOCATOR_PATTERN = /^bytes 0-(0|[1-9]\d*)$/;
const MAX_DIAGNOSTIC_LENGTH = 240;

/**
 * Projects the canonical Traceink index without interpreting its Markdown.
 * Freshness is exclusively a comparison of captured provider Session bytes.
 */
export function projectTraceinkReview(
  store: TraceinkAssetStoreDocumentV1,
  logicalDate: string,
  sessions: AgentWorkSession[]
): TraceinkReviewProjection {
  const current = currentSessionManifest(sessions);
  const rawReference = activeReferenceValue(store, logicalDate);
  if (rawReference === undefined) {
    return {
      mode: "raw",
      uncompiledEvidence: current.all,
      worklines: [],
      ...diagnosticForCurrentCapture(current)
    };
  }

  const resolved = resolveActiveIndex(store, logicalDate, rawReference);
  if (!resolved) {
    return {
      mode: "raw",
      uncompiledEvidence: current.all,
      worklines: [],
      diagnostic: boundedDiagnostic("Traceink active index reference failed integrity validation; the raw Session board remains authoritative.")
    };
  }

  const stored = storedSessionManifest(resolved.artifact);
  const presentationByWorklineId = new Map(
    traceinkIndexPresentation(resolved.artifact).map((item) => [item.selection.worklineId, item])
  );
  const uncompiledEvidence = current.all.filter((entry) => {
    if (current.incompleteIdentities.has(entry.identity) || current.conflictingIdentities.has(entry.identity)) {
      return true;
    }
    return stored.exact.get(entry.identity)?.revision !== entry.revision;
  });
  const absentStoredCount = [...stored.exact.keys()].filter((identity) => !currentIdentityIsPresent(current, identity)).length;
  const isStale = uncompiledEvidence.length > 0 ||
    absentStoredCount > 0 ||
    stored.incompleteCount > 0 ||
    stored.conflictingCount > 0 ||
    current.incompleteIdentities.size > 0 ||
    current.conflictingIdentities.size > 0;

  return {
    mode: isStale ? "stale" : "compiled",
    activeIndex: resolved.artifact,
    activeIndexReference: resolved.reference,
    uncompiledEvidence,
    worklines: traceinkWorklineSelections(resolved.artifact).map((selection) => {
      const presentation = presentationByWorklineId.get(selection.worklineId);
      const dossier = latestTraceinkDossier(store, resolved.reference, selection.worklineId);
      const reflection = dossier ? latestTraceinkReflection(store, dossier) : undefined;
      const proposals = reflection ? latestTraceinkProposals(store, reflection) : undefined;
      const dispositionByProposalId = proposals
        ? new Map(latestTraceinkProposalDispositions(store, proposals).map((item) => [item.proposalId, item]))
        : new Map<string, TraceinkProposalDispositionV1>();
      const proposalItems: TraceinkProposalItemReviewState[] = proposals?.navigation.map((item) => {
        const latestDisposition = dispositionByProposalId.get(item.id);
        return {
          proposalId: item.id,
          category: item.category,
          proposalText: item.proposalText,
          sourceQuote: item.sourceQuote,
          evidenceIds: [...item.evidenceIds],
          ...(latestDisposition ? { latestDisposition } : {})
        };
      }) ?? [];
      return {
        selection,
        ...(presentation ? { presentation } : {}),
        ...(dossier ? { dossier } : {}),
        ...(reflection ? { reflection } : {}),
        ...(proposals ? { proposals } : {}),
        proposalItems
      };
    }),
    ...freshnessDiagnostic({ current, stored, absentStoredCount })
  };
}

function resolveActiveIndex(
  store: TraceinkAssetStoreDocumentV1,
  logicalDate: string,
  rawReference: unknown
): { artifact: TraceinkIndexArtifactV1; reference: TraceinkIndexArtifactReferenceV1 } | undefined {
  const reference = normalizeTraceinkArtifactReferenceV1(rawReference);
  if (!reference || reference.stage !== "index" || !Array.isArray(store.artifacts)) return undefined;

  const candidates = store.artifacts.filter((artifact) =>
    artifact.id === reference.artifactId &&
    artifact.stage === reference.stage &&
    artifact.revision === reference.revision &&
    artifact.outputHash === reference.outputHash
  );
  if (candidates.length !== 1) return undefined;

  const artifact = normalizeTraceinkArtifactV1(candidates[0]);
  if (
    !artifact ||
    artifact.stage !== "index" ||
    artifact.logicalDate !== logicalDate ||
    artifact.id !== reference.artifactId ||
    artifact.revision !== reference.revision ||
    artifact.outputHash !== reference.outputHash
  ) return undefined;

  const { worklineId: _worklineId, sourceReflection: _sourceReflection, ...indexFields } = artifact;
  return {
    artifact: { ...indexFields, stage: "index" },
    reference: { ...reference, stage: "index" }
  };
}

function activeReferenceValue(store: TraceinkAssetStoreDocumentV1, logicalDate: string): unknown {
  const pointers = store && typeof store === "object" && !Array.isArray(store.activeIndexByDate)
    ? store.activeIndexByDate
    : undefined;
  return pointers && typeof pointers === "object"
    ? (pointers as Record<string, unknown>)[logicalDate]
    : undefined;
}

function currentSessionManifest(sessions: AgentWorkSession[]): CurrentSessionManifest {
  const exact = new Map<string, ExactSessionRevision>();
  const display = new Map<string, TodayBoardEvidenceRevision>();
  const incompleteIdentities = new Set<string>();
  const conflictingIdentities = new Set<string>();

  for (const session of sessions) {
    const capture = session.transcriptCapture;
    const provider = session.platform === "codex" || session.platform === "claude" || session.platform === "cursor"
      ? session.platform
      : undefined;
    const canonicalPath = capture?.canonicalPath || session.path;
    const identity = sessionIdentity(session.platform, session.id, canonicalPath);
    const exactCapture = Boolean(
      provider &&
      capture &&
      capture.canonicalPath.length > 0 &&
      SHA256_PATTERN.test(capture.sha256) &&
      Number.isSafeInteger(capture.byteLength) &&
      capture.byteLength >= 0
    );
    const entry: TodayBoardEvidenceRevision = exactCapture
      ? { identity, revision: `sha256:${capture!.sha256}:${capture!.byteLength}` }
      : { identity, revision: "capture-unavailable" };
    const previousDisplay = display.get(identity);
    if (previousDisplay && previousDisplay.revision !== entry.revision) {
      conflictingIdentities.add(identity);
      display.set(identity, { identity, revision: "capture-conflict" });
      exact.delete(identity);
      continue;
    }
    display.set(identity, entry);
    if (!exactCapture) {
      incompleteIdentities.add(identity);
      continue;
    }
    exact.set(identity, entry);
  }

  return {
    exact,
    all: [...display.values()].sort(compareEvidenceRevision),
    incompleteIdentities,
    conflictingIdentities
  };
}

function storedSessionManifest(artifact: TraceinkIndexArtifactV1): StoredSessionManifest {
  const exact = new Map<string, ExactSessionRevision>();
  let incompleteCount = 0;
  let conflictingCount = 0;

  for (const evidence of artifact.evidence) {
    if (evidence.kind !== "session") continue;
    const byteLength = exactByteLength(evidence.locator);
    if (
      (evidence.provider !== "codex" && evidence.provider !== "claude") ||
      !evidence.sessionId ||
      !evidence.path ||
      !evidence.contentHash ||
      !SHA256_PATTERN.test(evidence.contentHash) ||
      byteLength === undefined
    ) {
      incompleteCount += 1;
      continue;
    }
    const identity = sessionIdentity(evidence.provider, evidence.sessionId, evidence.path);
    const entry = {
      identity,
      revision: `sha256:${evidence.contentHash}:${byteLength}`
    };
    const previous = exact.get(identity);
    if (previous && previous.revision !== entry.revision) {
      exact.delete(identity);
      conflictingCount += 1;
      continue;
    }
    exact.set(identity, entry);
  }

  return { exact, incompleteCount, conflictingCount };
}

function exactByteLength(locator: string): number | undefined {
  const match = EXACT_BYTE_LOCATOR_PATTERN.exec(locator);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function currentIdentityIsPresent(current: CurrentSessionManifest, identity: string): boolean {
  return current.exact.has(identity) ||
    current.incompleteIdentities.has(identity) ||
    current.conflictingIdentities.has(identity);
}

function diagnosticForCurrentCapture(current: CurrentSessionManifest): { diagnostic?: string } {
  const count = current.incompleteIdentities.size + current.conflictingIdentities.size;
  return count > 0
    ? { diagnostic: boundedDiagnostic(`Exact transcript capture is unavailable for ${count} current Session${count === 1 ? "" : "s"}.`) }
    : {};
}

function freshnessDiagnostic(input: {
  current: CurrentSessionManifest;
  stored: StoredSessionManifest;
  absentStoredCount: number;
}): { diagnostic?: string } {
  const diagnostics: string[] = [];
  const incompleteStoredCount = input.stored.incompleteCount + input.stored.conflictingCount;
  if (incompleteStoredCount > 0) diagnostics.push("Traceink exact Session evidence is incomplete.");
  const incompleteCurrentCount = input.current.incompleteIdentities.size + input.current.conflictingIdentities.size;
  if (incompleteCurrentCount > 0) {
    diagnostics.push(`Exact transcript capture is unavailable for ${incompleteCurrentCount} current Session${incompleteCurrentCount === 1 ? "" : "s"}.`);
  }
  if (input.absentStoredCount > 0) {
    diagnostics.push(`${input.absentStoredCount} indexed Session${input.absentStoredCount === 1 ? " is" : "s are"} absent from the current evidence snapshot.`);
  }
  return diagnostics.length > 0 ? { diagnostic: boundedDiagnostic(diagnostics.join(" ")) } : {};
}

function sessionIdentity(provider: string, sessionId: string, canonicalPath: string): string {
  return `${provider}:${sessionId}:${canonicalPath}`;
}

function compareEvidenceRevision(left: TodayBoardEvidenceRevision, right: TodayBoardEvidenceRevision): number {
  return left.identity.localeCompare(right.identity) || left.revision.localeCompare(right.revision);
}

function boundedDiagnostic(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_LENGTH) return value;
  return `${value.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}
