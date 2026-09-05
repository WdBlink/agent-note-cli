import type { AgentWorkSession } from "./types";
import type { DailyReviewEvidence, DailyReviewPackage } from "./workline-review";

export type TodayBoardMode = "raw" | "compiled" | "stale" | "sealed";

export interface TodayBoardEvidenceRevision {
  identity: string;
  revision: string;
}

export interface TodayBoardPackageGeneration {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  evidenceCutoff: string;
  admittedEvidence: TodayBoardEvidenceRevision[];
  package: DailyReviewPackage;
}

export interface TodayBoardPageAsset {
  status: "unformed" | "draft" | "sealed";
  reviewPackage?: DailyReviewPackage;
  packageGenerations?: TodayBoardPackageGeneration[];
  activePackageGenerationId?: string;
  lastCompilationError?: string;
}

export interface TodayBoardProjection {
  mode: TodayBoardMode;
  activeGeneration?: TodayBoardPackageGeneration;
  uncompiledEvidence: TodayBoardEvidenceRevision[];
  compilationError?: string;
}

export function buildSessionEvidenceManifest(sessions: AgentWorkSession[]): TodayBoardEvidenceRevision[] {
  const unique = new Map<string, TodayBoardEvidenceRevision>();
  for (const session of sessions) {
    const identity = sessionIdentity(session.platform, session.id, session.path);
    unique.set(identity, {
      identity,
      revision: session.transcriptCapture
        ? `sha256:${session.transcriptCapture.sha256}:${session.transcriptCapture.byteLength}`
        : stableHash(JSON.stringify({
            startedAt: session.startedAt ?? null,
            updatedAt: session.updatedAt,
            title: session.title,
            summary: session.summary,
            artifacts: [...session.artifacts].sort(),
            status: session.status,
            branch: session.branch ?? null
          }))
    });
  }
  return [...unique.values()].sort((left, right) => left.identity.localeCompare(right.identity));
}

export function createTodayBoardGeneration(
  reviewPackage: DailyReviewPackage,
  sessions: AgentWorkSession[],
  appendIndex = 0
): TodayBoardPackageGeneration {
  const admittedEvidence = admittedSessionEvidence(reviewPackage.evidence, sessions, reviewPackage.evidenceCutoff);
  const fingerprint = stableHash(JSON.stringify({ id: reviewPackage.id, generatedAt: reviewPackage.generatedAt, admittedEvidence }));
  return {
    schemaVersion: 1,
    id: `generation-${reviewPackage.id}-${fingerprint}-${appendIndex + 1}`,
    generatedAt: reviewPackage.generatedAt,
    evidenceCutoff: reviewPackage.evidenceCutoff,
    admittedEvidence,
    package: structuredClone(reviewPackage)
  };
}

export function legacyTodayBoardGeneration(reviewPackage: DailyReviewPackage): TodayBoardPackageGeneration {
  const admittedEvidence = reviewPackage.evidence
    .filter((evidence) => evidence.kind === "session")
    .map((evidence) => ({
      identity: sessionIdentity(evidence.platform, evidence.sessionId, evidence.path),
      revision: evidence.transcriptCapture
        ? `sha256:${evidence.transcriptCapture.sha256}:${evidence.transcriptCapture.byteLength}`
        : `legacy-cutoff:${reviewPackage.evidenceCutoff}`
    }))
    .sort((left, right) => left.identity.localeCompare(right.identity));
  return {
    schemaVersion: 1,
    id: `generation-${reviewPackage.id}-legacy`,
    generatedAt: reviewPackage.generatedAt,
    evidenceCutoff: reviewPackage.evidenceCutoff,
    admittedEvidence,
    package: structuredClone(reviewPackage)
  };
}

export function projectTodayBoard(page: TodayBoardPageAsset, sessions: AgentWorkSession[]): TodayBoardProjection {
  const activeGeneration = activeGenerationFor(page);
  const snapshot = buildSessionEvidenceManifest(sessions);
  const uncompiledEvidence = activeGeneration ? newerEvidence(activeGeneration, snapshot, sessions) : snapshot;
  const base = {
    ...(activeGeneration ? { activeGeneration } : {}),
    uncompiledEvidence,
    ...(page.lastCompilationError ? { compilationError: page.lastCompilationError } : {})
  };
  if (page.status === "sealed") return { mode: "sealed", ...base };
  if (!activeGeneration) return { mode: "raw", ...base };
  return { mode: uncompiledEvidence.length > 0 ? "stale" : "compiled", ...base };
}

function activeGenerationFor(page: TodayBoardPageAsset): TodayBoardPackageGeneration | undefined {
  const hasPackageGenerations = Object.prototype.hasOwnProperty.call(page, "packageGenerations");
  const generations = hasPackageGenerations
    ? page.packageGenerations ?? []
    : page.reviewPackage ? [legacyTodayBoardGeneration(page.reviewPackage)] : [];
  if (generations.length === 0) return undefined;
  if (!Object.prototype.hasOwnProperty.call(page, "activePackageGenerationId")) {
    return hasPackageGenerations ? undefined : generations.at(-1);
  }
  return generations.find((generation) => generation.id === page.activePackageGenerationId);
}

function admittedSessionEvidence(
  packageEvidence: DailyReviewEvidence[],
  sessions: AgentWorkSession[],
  evidenceCutoff: string
): TodayBoardEvidenceRevision[] {
  const snapshot = new Map(buildSessionEvidenceManifest(sessions).map((entry) => [entry.identity, entry]));
  return packageEvidence
    .filter((evidence) => evidence.kind === "session")
    .map((evidence) => {
      const identity = sessionIdentity(evidence.platform, evidence.sessionId, evidence.path);
      if (evidence.transcriptCapture) {
        return {
          identity,
          revision: `sha256:${evidence.transcriptCapture.sha256}:${evidence.transcriptCapture.byteLength}`
        };
      }
      return snapshot.get(identity) ?? { identity, revision: `legacy-cutoff:${evidenceCutoff}` };
    })
    .sort((left, right) => left.identity.localeCompare(right.identity));
}

function newerEvidence(
  generation: TodayBoardPackageGeneration,
  snapshot: TodayBoardEvidenceRevision[],
  sessions: AgentWorkSession[]
): TodayBoardEvidenceRevision[] {
  const admitted = new Map(generation.admittedEvidence.map((entry) => [entry.identity, entry]));
  const sessionByIdentity = new Map(sessions.map((session) => [sessionIdentity(session.platform, session.id, session.path), session]));
  return snapshot.filter((entry) => {
    const stored = admitted.get(entry.identity);
    if (!stored) return true;
    if (!stored.revision.startsWith("legacy-cutoff:")) return stored.revision !== entry.revision;
    const session = sessionByIdentity.get(entry.identity);
    return Boolean(session && Date.parse(session.updatedAt) > Date.parse(generation.evidenceCutoff));
  });
}

function sessionIdentity(platform: string, id: string, path: string): string {
  return `${platform}:${id}:${path}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
