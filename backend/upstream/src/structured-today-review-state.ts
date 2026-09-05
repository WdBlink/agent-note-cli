import type {
  StructuredTodayIndexReferenceV1,
  TraceinkAssetStoreDocumentV1
} from "../app/desktop/traceink-asset-store";
import {
  activeStructuredTodayIndexReferenceForDate,
  findStructuredTodayIndex,
  latestStructuredTodayDossier,
  latestStructuredTodayProposalDispositions,
  latestStructuredTodayProposals,
  latestStructuredTodayReflection
} from "../app/desktop/traceink-asset-store";
import type {
  SessionDispositionV1,
  StructuredTodayProposalArtifactV1,
  StructuredTodayProposalDispositionV1,
  StructuredTodayProposalItemV1,
  StructuredTodayReflectionV1,
  TodayWorklineDossierV1,
  TodayWorklineIndexV1,
  TodayWorklineV1
} from "./structured-today-contracts";
import { STRUCTURED_TODAY_WORKFLOW_VERSION } from "./structured-today-contracts";
import type { TodayBoardEvidenceRevision } from "./today-board";
import type { AgentWorkSession } from "./types";
import { familyChildEvidenceId } from "./session-family";

export type StructuredTodayReviewMode = "raw" | "compiled" | "stale";

export interface StructuredTodayWorklineReviewState {
  workline: TodayWorklineV1;
  dossier?: TodayWorklineDossierV1;
  reflection?: StructuredTodayReflectionV1;
  proposals?: StructuredTodayProposalArtifactV1;
  proposalItems: Array<{
    proposal: StructuredTodayProposalItemV1;
    latestDisposition?: StructuredTodayProposalDispositionV1;
  }>;
}

export interface StructuredTodayReviewProjection {
  mode: StructuredTodayReviewMode;
  activeIndex?: TodayWorklineIndexV1;
  activeIndexReference?: StructuredTodayIndexReferenceV1;
  worklines: StructuredTodayWorklineReviewState[];
  dispositions: SessionDispositionV1[];
  uncompiledEvidence: TodayBoardEvidenceRevision[];
  diagnostic?: string;
}

const EXACT_BYTE_RANGE = /^bytes 0-(0|[1-9]\d*)$/;

export function projectStructuredTodayReview(
  store: TraceinkAssetStoreDocumentV1,
  logicalDate: string,
  sessions: AgentWorkSession[]
): StructuredTodayReviewProjection {
  const current = currentManifest(sessions);
  const activeReference = activeStructuredTodayIndexReferenceForDate(store, logicalDate);
  const activeIndex = activeReference ? findStructuredTodayIndex(store, activeReference) : undefined;
  if (!activeReference || !activeIndex) {
    return {
      mode: "raw",
      worklines: [],
      dispositions: [],
      uncompiledEvidence: [...current.values()].sort(compareRevision)
    };
  }

  const stored = storedManifest(activeIndex);
  const uncompiledEvidence = [...current.values()]
    .filter((entry) => stored.get(entry.identity)?.revision !== entry.revision)
    .sort(compareRevision);
  const currentIdentities = new Set(current.keys());
  const missingStored = [...stored.keys()].filter((identity) => !currentIdentities.has(identity));
  const workflowStale = activeIndex.provenance.workflowVersion !== STRUCTURED_TODAY_WORKFLOW_VERSION;
  const stale = uncompiledEvidence.length > 0 || missingStored.length > 0 || workflowStale;
  const diagnostic = workflowStale
    ? "这份工作脉络由旧版参与权威规则生成；请重新整理后再据此判断人的参与。"
    : missingStored.length > 0
    ? `${missingStored.length} indexed Session${missingStored.length === 1 ? " is" : "s are"} absent from the current snapshot.`
    : undefined;
  return {
    mode: stale ? "stale" : "compiled",
    activeIndex,
    activeIndexReference: activeReference,
    worklines: activeIndex.worklines.map((workline) => {
      const dossier = latestStructuredTodayDossier(store, activeReference, workline.worklineId);
      const reflection = dossier ? latestStructuredTodayReflection(store, dossier) : undefined;
      const proposals = reflection ? latestStructuredTodayProposals(store, reflection) : undefined;
      const dispositions = proposals ? latestStructuredTodayProposalDispositions(store, proposals) : [];
      const dispositionByProposal = new Map(dispositions.map((item) => [item.proposalId, item]));
      return {
        workline,
        ...(dossier ? { dossier } : {}),
        ...(reflection ? { reflection } : {}),
        ...(proposals ? { proposals } : {}),
        proposalItems: proposals?.proposals.map((proposal) => {
          const latestDisposition = dispositionByProposal.get(proposal.proposalId);
          return { proposal, ...(latestDisposition ? { latestDisposition } : {}) };
        }) ?? []
      };
    }),
    dispositions: activeIndex.dispositions,
    uncompiledEvidence,
    ...(diagnostic ? { diagnostic } : {})
  };
}

function currentManifest(sessions: AgentWorkSession[]): Map<string, TodayBoardEvidenceRevision> {
  const result = new Map<string, TodayBoardEvidenceRevision>();
  for (const session of sessions) {
    const path = session.transcriptCapture?.canonicalPath ?? session.path;
    const identity = sessionIdentity(session.platform, session.id, path);
    result.set(identity, {
      identity,
      revision: session.transcriptCapture
        ? `sha256:${session.transcriptCapture.sha256}:${session.transcriptCapture.byteLength}`
        : "capture-unavailable"
    });
  }
  return result;
}

function storedManifest(index: TodayWorklineIndexV1): Map<string, TodayBoardEvidenceRevision> {
  const result = new Map<string, TodayBoardEvidenceRevision>();
  for (const evidence of index.evidence) {
    const child = evidence.sourceKind === "linked-material" && evidence.provider
      ? parseFamilyChildEvidenceId(evidence.evidenceId, evidence.provider)
      : undefined;
    if (evidence.sourceKind !== "session" && !child) continue;
    if (!evidence.provider) continue;
    const sessionId = evidence.sourceKind === "session" ? evidence.sessionId : child;
    if (!sessionId) continue;
    const end = evidence.range ? EXACT_BYTE_RANGE.exec(evidence.range)?.[1] : undefined;
    const revision = evidence.range === "metadata-only"
      ? "capture-unavailable"
      : end
        ? `sha256:${evidence.contentHash}:${end}`
        : `sha256:${evidence.contentHash}:range-unavailable`;
    const identity = sessionIdentity(evidence.provider, sessionId, evidence.sourcePath);
    result.set(identity, { identity, revision });
  }
  return result;
}

function parseFamilyChildEvidenceId(evidenceId: string, provider: string): string | undefined {
  const prefix = `family-child:${provider}:`;
  if (!evidenceId.startsWith(prefix)) return undefined;
  try {
    const sessionId = decodeURIComponent(evidenceId.slice(prefix.length));
    return sessionId && familyChildEvidenceId({ platform: provider as AgentWorkSession["platform"], id: sessionId }) === evidenceId
      ? sessionId
      : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdentity(provider: string, sessionId: string, sourcePath: string): string {
  return `${provider}:${sessionId}:${sourcePath}`;
}

function compareRevision(left: TodayBoardEvidenceRevision, right: TodayBoardEvidenceRevision): number {
  return left.identity.localeCompare(right.identity) || left.revision.localeCompare(right.revision);
}
