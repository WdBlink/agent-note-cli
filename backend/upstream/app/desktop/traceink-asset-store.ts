import { isDeepStrictEqual } from "node:util";
import {
  isTraceinkLogicalDate,
  normalizeTraceinkArtifactReferenceV1,
  normalizeTraceinkArtifactV1,
  normalizeTraceinkProposalDispositionV1,
  normalizeUserReflectionAssetV1,
  sha256TraceinkText,
  traceinkArtifactReference,
  userReflectionAssetReference,
  type TraceinkArtifactReferenceV1,
  type TraceinkArtifactV1,
  type TraceinkDossierArtifactDraftV1,
  type TraceinkDossierArtifactV1,
  type TraceinkIndexArtifactDraftV1,
  type TraceinkIndexArtifactV1,
  type TraceinkProposalDispositionActionV1,
  type TraceinkProposalDispositionV1,
  type TraceinkProposalNavigationItemV1,
  type TraceinkProposalsArtifactDraftV1,
  type TraceinkProposalsArtifactV1,
  type UserReflectionAssetV1
} from "../../src/traceink-review-assets";
import { TRACEINK_PROPOSAL_CATEGORIES } from "../../src/traceink-review-assets";
import {
  TodayWorklineDossierSchema,
  TodayWorklineIndexSchema,
  StructuredTodayProposalArtifactSchema,
  StructuredTodayProposalDispositionSchema,
  StructuredTodayReflectionSchema,
  sha256Text,
  type StructuredTodayProposalArtifactV1,
  type StructuredTodayProposalDispositionV1,
  type StructuredTodayReflectionV1,
  type TodayWorklineDossierV1,
  type TodayWorklineIndexV1
} from "../../src/structured-today-contracts";
import {
  validateStructuredTodayDossier,
  validateStructuredTodayIndex,
  validateStructuredTodayProposalArtifact
} from "../../src/structured-today-artifacts";
import {
  TodayWorklineIndexV2Schema,
  TodayWorklineDossierV2Schema,
  validateTodayWorklineDossierV2,
  validateTodayWorklineIndexV2,
  type TodayWorklineDossierV2,
  type TodayWorklineIndexV2
} from "../../src/structured-today-v2-contracts";

export type TraceinkIndexArtifactReferenceV1 = TraceinkArtifactReferenceV1 & { stage: "index" };

export interface TraceinkAssetStoreDocumentV1 {
  schemaVersion: 1;
  artifacts: TraceinkArtifactV1[];
  reflections: UserReflectionAssetV1[];
  /** Optional only for backward-compatible loading of pre-interaction v1 files. */
  proposalDispositions?: TraceinkProposalDispositionV1[];
  activeIndexByDate: Record<string, TraceinkIndexArtifactReferenceV1>;
  /** Added in place so historical Traceink-only v1 documents remain readable. */
  structuredIndexes?: TodayWorklineIndexV1[];
  /** Unmerged V2 candidates never participate in the active V1 lineage. */
  structuredIndexV2Candidates?: TodayWorklineIndexV2[];
  structuredDossierV2Candidates?: TodayWorklineDossierV2[];
  structuredDossiers?: TodayWorklineDossierV1[];
  activeStructuredIndexByDate?: Record<string, StructuredTodayIndexReferenceV1>;
  structuredReflections?: StructuredTodayReflectionV1[];
  structuredProposals?: StructuredTodayProposalArtifactV1[];
  structuredProposalDispositions?: StructuredTodayProposalDispositionV1[];
  structuredRuns?: StructuredTodayRunRecordV1[];
}

export interface StructuredTodayIndexReferenceV1 {
  artifactId: string;
  revision: number;
  contentHash: string;
}

export interface StructuredTodayRunRecordV1 {
  runId: string;
  kind: "index" | "dossier" | "proposals";
  logicalDate: string;
  worklineId?: string;
  status: "running" | "ready" | "failed" | "cancelled";
  stage: string;
  completed: number;
  total: number;
  startedAt: string;
  updatedAt: string;
  message?: string;
}

export type TraceinkAssetStoreDocument = TraceinkAssetStoreDocumentV1;

/**
 * The only Today lineage that may authorize an interaction for one workline.
 * Historical revisions remain immutable in the store, but they are not part of
 * this current chain and therefore cannot authorize writes or evidence reads.
 */
export interface CurrentTraceinkWorklineLineageV1 {
  activeIndex: TraceinkIndexArtifactReferenceV1;
  dossier?: TraceinkDossierArtifactV1;
  reflection?: UserReflectionAssetV1;
  proposals?: TraceinkProposalsArtifactV1;
}

export function createEmptyTraceinkAssetStore(): TraceinkAssetStoreDocumentV1 {
  return { schemaVersion: 1, artifacts: [], reflections: [], proposalDispositions: [], activeIndexByDate: {} };
}

export const createEmptyTraceinkAssetStoreDocument = createEmptyTraceinkAssetStore;

/**
 * Normalizes one standalone local asset document. Invalid provenance and exact
 * revision references are not admitted. Valid unrelated revisions survive.
 */
export function normalizeTraceinkAssetStore(value: unknown): TraceinkAssetStoreDocumentV1 {
  const raw = asRecord(value);
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.artifacts)) {
    return createEmptyTraceinkAssetStore();
  }

  const artifacts = stableArtifactLineages(
    uniqueArtifacts(raw.artifacts.map(normalizeTraceinkArtifactV1).filter(isPresent))
  );
  const artifactByReference = new Map(artifacts.map((artifact) => [referenceKey(traceinkArtifactReference(artifact)), artifact]));
  const reflections = stableReflectionLineages(uniqueReflections(
    (Array.isArray(raw.reflections) ? raw.reflections : [])
      .map(normalizeUserReflectionAssetV1)
      .filter(isPresent)
      .filter((reflection) => reflectionDossierResolves(reflection, artifactByReference))
  ));
  const reflectionByReference = new Map(reflections.map((reflection) => [reflectionReferenceKey({
    reflectionId: reflection.id,
    revision: reflection.revision,
    contentHash: reflection.contentHash
  }), reflection]));
  const resolvedArtifacts = artifacts.flatMap((artifact): TraceinkArtifactV1[] => {
    if (!artifact.sourceReflection) return [artifact];
    const reflection = reflectionByReference.get(reflectionReferenceKey(artifact.sourceReflection));
    if (
      !reflection ||
      reflection.logicalDate !== artifact.logicalDate ||
      reflection.worklineId !== artifact.worklineId
    ) return [];
    return [blockInvalidProposalSourceQuotes(artifact, reflection)];
  });
  const resolvedArtifactByReference = new Map(
    resolvedArtifacts.map((artifact) => [referenceKey(traceinkArtifactReference(artifact)), artifact])
  );
  const proposalDispositions = stableProposalDispositionLineages(uniqueProposalDispositions(
    (Array.isArray(raw.proposalDispositions) ? raw.proposalDispositions : [])
      .map(normalizeTraceinkProposalDispositionV1)
      .filter(isPresent)
      .filter((disposition) => proposalDispositionResolves(disposition, resolvedArtifactByReference))
  ));
  const activeIndexByDate = normalizeActiveIndexes(raw.activeIndexByDate, resolvedArtifactByReference);

  const hasStructuredFields = raw.structuredIndexes !== undefined ||
    raw.structuredIndexV2Candidates !== undefined ||
    raw.structuredDossierV2Candidates !== undefined ||
    raw.structuredDossiers !== undefined ||
    raw.activeStructuredIndexByDate !== undefined ||
    raw.structuredReflections !== undefined ||
    raw.structuredProposals !== undefined ||
    raw.structuredProposalDispositions !== undefined ||
    raw.structuredRuns !== undefined;
  const structuredIndexes = normalizeStructuredIndexes(raw.structuredIndexes);
  const structuredIndexV2Candidates = normalizeStructuredIndexV2Candidates(raw.structuredIndexV2Candidates);
  const structuredIndexV2CandidateByReference = new Map(structuredIndexV2Candidates.map((artifact) => [
    structuredTodayReferenceKey(structuredTodayIndexReference(artifact)),
    artifact
  ]));
  const structuredDossierV2Candidates = normalizeStructuredDossierV2Candidates(
    raw.structuredDossierV2Candidates,
    structuredIndexV2CandidateByReference
  );
  const structuredIndexByReference = new Map(
    structuredIndexes.map((artifact) => [structuredTodayReferenceKey(structuredTodayIndexReference(artifact)), artifact])
  );
  const structuredDossiers = normalizeStructuredDossiers(raw.structuredDossiers, structuredIndexByReference);
  const structuredDossierByReference = new Map(structuredDossiers.map((artifact) => [
    structuredArtifactReferenceKey(artifact),
    artifact
  ]));
  const structuredReflections = normalizeStructuredReflections(
    raw.structuredReflections,
    structuredDossierByReference
  );
  const structuredReflectionByReference = new Map(structuredReflections.map((reflection) => [
    structuredReflectionReferenceKey(reflection),
    reflection
  ]));
  const structuredProposals = normalizeStructuredProposals(
    raw.structuredProposals,
    structuredDossierByReference,
    structuredReflectionByReference
  );
  const structuredProposalByReference = new Map(structuredProposals.map((artifact) => [
    structuredArtifactReferenceKey(artifact),
    artifact
  ]));
  const structuredProposalDispositions = normalizeStructuredProposalDispositions(
    raw.structuredProposalDispositions,
    structuredProposalByReference
  );
  const structuredRuns = normalizeStructuredRuns(raw.structuredRuns);
  const activeStructuredIndexByDate = normalizeActiveStructuredIndexes(
    raw.activeStructuredIndexByDate,
    structuredIndexByReference
  );

  return {
    schemaVersion: 1,
    artifacts: resolvedArtifacts,
    reflections,
    proposalDispositions,
    activeIndexByDate,
    ...(hasStructuredFields
      ? {
          structuredIndexes,
          structuredIndexV2Candidates,
          structuredDossierV2Candidates,
          structuredDossiers,
          activeStructuredIndexByDate,
          structuredReflections,
          structuredProposals,
          structuredProposalDispositions,
          structuredRuns
        }
      : {})
  };
}

export const normalizeTraceinkAssetStoreDocument = normalizeTraceinkAssetStore;

export function loadTraceinkAssetStore(serialized: string): TraceinkAssetStoreDocumentV1 {
  try {
    return normalizeTraceinkAssetStore(JSON.parse(serialized) as unknown);
  } catch {
    return createEmptyTraceinkAssetStore();
  }
}

export const loadTraceinkAssetStoreDocument = loadTraceinkAssetStore;

/**
 * Appends the immutable index revision and moves only that date's active
 * pointer. The input document is never mutated, including when validation
 * fails before the append can be materialized.
 */
export function appendTraceinkIndexRevision(
  document: TraceinkAssetStoreDocumentV1,
  draft: TraceinkIndexArtifactDraftV1,
  expectedActiveIndex?: TraceinkIndexArtifactReferenceV1 | null
): TraceinkAssetStoreDocumentV1 {
  if (!isCanonicalStoreEnvelope(document)) throw new Error("Traceink asset store document is invalid.");
  const current = normalizeTraceinkAssetStore(document);
  if (!isDeepStrictEqual(current, document)) {
    throw new Error("Traceink asset store document failed integrity validation.");
  }
  if (!isTraceinkLogicalDate(draft.logicalDate) || draft.schemaVersion !== 1 || draft.stage !== "index") {
    throw new Error("Traceink index draft identity is invalid.");
  }
  if (hasOwn(draft, "id") || hasOwn(draft, "revision") || hasOwn(draft, "outputHash")) {
    throw new Error("Traceink index identity, revision, and output hash are store-owned.");
  }
  if (hasOwn(draft, "worklineId") || hasOwn(draft, "sourceReflection")) {
    throw new Error("Traceink index drafts cannot reference a workline or reflection.");
  }

  const active = activeIndexReferenceForDate(current, draft.logicalDate);
  if (expectedActiveIndex !== undefined && !sameOptionalIndexReference(active, expectedActiveIndex)) {
    throw new Error("Traceink active index changed before this revision could be appended.");
  }
  const artifactId = active?.artifactId ?? traceinkIndexArtifactId(draft.logicalDate);
  const previousRevisions = current.artifacts
    .filter((artifact) => artifact.id === artifactId && artifact.stage === "index")
    .map((artifact) => artifact.revision);
  const revision = (previousRevisions.length > 0 ? Math.max(...previousRevisions) : 0) + 1;
  const materialized = normalizeTraceinkArtifactV1({
    ...draft,
    id: artifactId,
    stage: "index",
    revision,
    outputHash: sha256TraceinkText(draft.rawMarkdown)
  });
  if (!materialized || materialized.stage !== "index" || materialized.worklineId || materialized.sourceReflection) {
    throw new Error("Traceink index draft failed integrity validation.");
  }
  const {
    worklineId: _worklineId,
    sourceReflection: _sourceReflection,
    ...indexFields
  } = materialized;
  const artifact: TraceinkIndexArtifactV1 = {
    ...indexFields,
    stage: "index"
  };
  const reference: TraceinkIndexArtifactReferenceV1 = {
    ...traceinkArtifactReference(artifact),
    stage: "index"
  };
  return {
    schemaVersion: 1,
    artifacts: [...current.artifacts, artifact],
    reflections: current.reflections,
    proposalDispositions: current.proposalDispositions ?? [],
    activeIndexByDate: {
      ...current.activeIndexByDate,
      [artifact.logicalDate]: reference
    }
  };
}

export function appendTraceinkDossierRevision(
  document: TraceinkAssetStoreDocumentV1,
  draft: TraceinkDossierArtifactDraftV1,
  expectedActiveIndex: TraceinkIndexArtifactReferenceV1
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const active = activeIndexReferenceForDate(current, draft.logicalDate);
  if (!active || !sameIndexReference(active, expectedActiveIndex)) {
    throw new Error("Traceink active index changed before this dossier could be appended.");
  }
  if (draft.schemaVersion !== 1 || draft.stage !== "dossier" || !draft.worklineId || hasOwn(draft, "sourceReflection")) {
    throw new Error("Traceink dossier draft identity is invalid.");
  }
  if (hasOwn(draft, "id") || hasOwn(draft, "revision") || hasOwn(draft, "outputHash")) {
    throw new Error("Traceink dossier identity, revision, and output hash are store-owned.");
  }
  const artifactId = traceinkDossierArtifactId(active, draft.worklineId);
  const revision = 1 + Math.max(0, ...current.artifacts
    .filter((artifact) => artifact.id === artifactId && artifact.stage === "dossier")
    .map((artifact) => artifact.revision));
  const artifact = normalizeTraceinkArtifactV1({
    ...draft,
    id: artifactId,
    revision,
    outputHash: sha256TraceinkText(draft.rawMarkdown)
  });
  if (!artifact || artifact.stage !== "dossier" || artifact.sourceReflection) {
    throw new Error("Traceink dossier draft failed integrity validation.");
  }
  return { ...current, artifacts: [...current.artifacts, artifact] };
}

export function latestTraceinkDossier(
  document: TraceinkAssetStoreDocumentV1,
  index: TraceinkIndexArtifactReferenceV1,
  worklineId: string
): TraceinkDossierArtifactV1 | undefined {
  const id = traceinkDossierArtifactId(index, worklineId);
  const candidates = document.artifacts
    .filter((artifact) => artifact.id === id && artifact.stage === "dossier" && artifact.worklineId === worklineId)
    .sort((left, right) => right.revision - left.revision);
  const artifact = candidates[0] ? normalizeTraceinkArtifactV1(candidates[0]) : undefined;
  if (artifact?.stage !== "dossier" || !artifact.worklineId || artifact.sourceReflection) return undefined;
  const { sourceReflection: _sourceReflection, ...fields } = artifact;
  return { ...fields, stage: "dossier", worklineId: artifact.worklineId };
}

export function appendTraceinkReflectionRevision(
  document: TraceinkAssetStoreDocumentV1,
  dossierReference: TraceinkArtifactReferenceV1 & { stage: "dossier" },
  text: string,
  savedAt: string
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const dossier = findTraceinkArtifact(current, dossierReference);
  if (!dossier || dossier.stage !== "dossier" || !dossier.worklineId || typeof text !== "string" || !text.trim()) {
    throw new Error("Traceink reflection must belong to an exact dossier and contain the user's text.");
  }
  const lineage = currentTraceinkWorklineLineage(current, dossier.logicalDate, dossier.worklineId);
  if (!lineage?.dossier || !sameArtifactReference(
    traceinkArtifactReference(lineage.dossier),
    dossierReference
  )) {
    throw new Error("Traceink dossier changed before the reflection could be saved.");
  }
  if (!Number.isFinite(Date.parse(savedAt))) throw new Error("Traceink reflection save time is invalid.");
  const id = `traceink-reflection-${sha256TraceinkText(`${dossier.id}\0${dossier.revision}\0${dossier.outputHash}`).slice(0, 24)}`;
  const previous = current.reflections.filter((reflection) => reflection.id === id);
  const revision = 1 + Math.max(0, ...previous.map((reflection) => reflection.revision));
  const createdAt = previous.sort((left, right) => left.revision - right.revision)[0]?.createdAt ?? savedAt;
  const reflection = normalizeUserReflectionAssetV1({
    schemaVersion: 1,
    id,
    logicalDate: dossier.logicalDate,
    worklineId: dossier.worklineId,
    dossier: { ...dossierReference, stage: "dossier" },
    revision,
    text,
    createdAt,
    savedAt,
    contentHash: sha256TraceinkText(text)
  });
  if (!reflection) throw new Error("Traceink reflection failed integrity validation.");
  return { ...current, reflections: [...current.reflections, reflection] };
}

export function latestTraceinkReflection(
  document: TraceinkAssetStoreDocumentV1,
  dossier: TraceinkDossierArtifactV1
): UserReflectionAssetV1 | undefined {
  return document.reflections
    .filter((reflection) => reflection.worklineId === dossier.worklineId &&
      reflection.dossier.artifactId === dossier.id &&
      reflection.dossier.revision === dossier.revision &&
      reflection.dossier.outputHash === dossier.outputHash)
    .sort((left, right) => right.revision - left.revision)[0];
}

export function currentTraceinkWorklineLineage(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string,
  worklineId: string
): CurrentTraceinkWorklineLineageV1 | undefined {
  if (!isTraceinkLogicalDate(logicalDate) || typeof worklineId !== "string" || !worklineId.trim()) return undefined;
  const activeIndex = activeIndexReferenceForDate(document, logicalDate);
  if (!activeIndex) return undefined;
  const dossier = latestTraceinkDossier(document, activeIndex, worklineId);
  if (!dossier) return { activeIndex };
  const reflection = latestTraceinkReflection(document, dossier);
  if (!reflection) return { activeIndex, dossier };
  const proposals = latestTraceinkProposals(document, reflection);
  return {
    activeIndex,
    dossier,
    reflection,
    ...(proposals ? { proposals } : {})
  };
}

export function appendTraceinkProposalsRevision(
  document: TraceinkAssetStoreDocumentV1,
  draft: TraceinkProposalsArtifactDraftV1,
  expectedReflection: ReturnType<typeof userReflectionAssetReference>,
  expectedProposals?: (TraceinkArtifactReferenceV1 & { stage: "proposals" }) | null
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const reflection = reflectionForReference(current, expectedReflection);
  if (!reflection) throw new Error("Traceink saved reflection changed before proposals could be appended.");
  const lineage = currentTraceinkWorklineLineage(current, reflection.logicalDate, reflection.worklineId);
  if (!lineage?.dossier || !lineage.reflection ||
    !sameArtifactReference(traceinkArtifactReference(lineage.dossier), reflection.dossier) ||
    !sameReflectionReference(
      userReflectionAssetReference(lineage.reflection),
      expectedReflection
    )) throw new Error("Traceink saved reflection changed before proposals could be appended.");
  const activeProposals = lineage.proposals;
  if (
    expectedProposals !== undefined &&
    !sameOptionalArtifactReference(
      activeProposals ? traceinkArtifactReference(activeProposals) : undefined,
      expectedProposals
    )
  ) throw new Error("Traceink proposals changed before this revision could be appended.");
  if (
    draft.schemaVersion !== 1 ||
    draft.stage !== "proposals" ||
    draft.logicalDate !== reflection.logicalDate ||
    draft.worklineId !== reflection.worklineId ||
    !sameReflectionReference(draft.sourceReflection, expectedReflection) ||
    hasOwn(draft, "id") ||
    hasOwn(draft, "revision") ||
    hasOwn(draft, "outputHash")
  ) throw new Error("Traceink proposal draft identity is invalid.");
  if (!draft.rawMarkdown.includes(reflection.text)) {
    throw new Error("Traceink proposal draft must preserve the user's reflection verbatim.");
  }
  assertCompleteProposalNavigation(draft.navigation, draft.rawMarkdown, reflection.text);

  const artifactId = traceinkProposalsArtifactId(expectedReflection);
  const revision = 1 + Math.max(0, ...current.artifacts
    .filter((artifact) => artifact.id === artifactId && artifact.stage === "proposals")
    .map((artifact) => artifact.revision));
  const normalized = normalizeTraceinkArtifactV1({
    ...draft,
    id: artifactId,
    revision,
    outputHash: sha256TraceinkText(draft.rawMarkdown)
  });
  const artifact = asProposalsArtifact(normalized);
  if (!artifact) throw new Error("Traceink proposal draft failed integrity validation.");
  return { ...current, artifacts: [...current.artifacts, artifact] };
}

export function latestTraceinkProposals(
  document: TraceinkAssetStoreDocumentV1,
  reflection: UserReflectionAssetV1
): TraceinkProposalsArtifactV1 | undefined {
  const id = traceinkProposalsArtifactId(userReflectionAssetReference(reflection));
  const artifact = document.artifacts
    .filter((candidate) => candidate.id === id && candidate.stage === "proposals")
    .sort((left, right) => right.revision - left.revision)[0];
  const proposals = asProposalsArtifact(normalizeTraceinkArtifactV1(artifact));
  return proposals &&
    proposals.rawMarkdown.includes(reflection.text) &&
    sameReflectionReference(proposals.sourceReflection, userReflectionAssetReference(reflection))
    ? proposals
    : undefined;
}

export function findTraceinkReflection(
  document: TraceinkAssetStoreDocumentV1,
  reference: ReturnType<typeof userReflectionAssetReference>
): UserReflectionAssetV1 | undefined {
  const reflection = reflectionForReference(document, reference);
  return reflection ? structuredClone(reflection) : undefined;
}

export function appendTraceinkProposalDisposition(
  document: TraceinkAssetStoreDocumentV1,
  proposalReference: TraceinkArtifactReferenceV1 & { stage: "proposals" },
  proposalId: string,
  input: {
    action: TraceinkProposalDispositionActionV1;
    rewriteText?: string;
    decidedAt: string;
  }
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const artifact = asProposalsArtifact(findTraceinkArtifact(current, proposalReference));
  if (!artifact) throw new Error("Traceink proposal artifact changed before disposition could be recorded.");
  const lineage = currentTraceinkWorklineLineage(current, artifact.logicalDate, artifact.worklineId);
  if (!lineage?.proposals || !sameArtifactReference(
    traceinkArtifactReference(lineage.proposals),
    proposalReference
  )) {
    throw new Error("Traceink proposal artifact changed before disposition could be recorded.");
  }
  const proposal = artifact.navigation.find((item) => item.id === proposalId);
  if (!proposal) throw new Error("Traceink proposal item does not belong to this proposal artifact.");
  if (!Number.isFinite(Date.parse(input.decidedAt))) throw new Error("Traceink proposal disposition time is invalid.");
  if (input.action === "rewrite") {
    if (typeof input.rewriteText !== "string" || !input.rewriteText.trim()) {
      throw new Error("Traceink proposal rewrite text is required.");
    }
  } else if (input.rewriteText !== undefined) {
    throw new Error("Traceink proposal rewrite text is only valid for a rewrite disposition.");
  }
  const id = traceinkProposalDispositionId(proposalReference, proposalId);
  const revision = 1 + Math.max(0, ...(current.proposalDispositions ?? [])
    .filter((item) => item.id === id)
    .map((item) => item.revision));
  const disposition = normalizeTraceinkProposalDispositionV1({
    schemaVersion: 1,
    id,
    logicalDate: artifact.logicalDate,
    worklineId: artifact.worklineId,
    proposalArtifact: proposalReference,
    proposalId,
    category: proposal.category,
    revision,
    action: input.action,
    ...(input.rewriteText !== undefined ? { rewriteText: input.rewriteText } : {}),
    decidedAt: input.decidedAt
  });
  if (!disposition) throw new Error("Traceink proposal disposition failed integrity validation.");
  return {
    ...current,
    proposalDispositions: [...(current.proposalDispositions ?? []), disposition]
  };
}

export function latestTraceinkProposalDispositions(
  document: TraceinkAssetStoreDocumentV1,
  artifact: TraceinkProposalsArtifactV1
): TraceinkProposalDispositionV1[] {
  const reference = traceinkArtifactReference(artifact);
  const latest = new Map<string, TraceinkProposalDispositionV1>();
  for (const item of document.proposalDispositions ?? []) {
    if (referenceKey(item.proposalArtifact) !== referenceKey(reference)) continue;
    const previous = latest.get(item.proposalId);
    if (!previous || item.revision > previous.revision) latest.set(item.proposalId, item);
  }
  return artifact.navigation.flatMap((proposal) => {
    const disposition = latest.get(proposal.id);
    return disposition ? [structuredClone(disposition)] : [];
  });
}

export function activeIndexReferenceForDate(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string
): TraceinkIndexArtifactReferenceV1 | undefined {
  if (!isTraceinkLogicalDate(logicalDate)) return undefined;
  const reference = normalizeTraceinkArtifactReferenceV1(document.activeIndexByDate[logicalDate]);
  if (!reference || reference.stage !== "index") return undefined;
  const artifact = validatedArtifactForReference(document, reference);
  if (!artifact || artifact.logicalDate !== logicalDate || artifact.stage !== "index") return undefined;
  return { ...reference, stage: "index" };
}

export function structuredTodayIndexArtifactId(logicalDate: string): string {
  if (!isTraceinkLogicalDate(logicalDate)) throw new Error("Structured Today index date is invalid.");
  return `structured-today-index-${logicalDate}`;
}

export function structuredTodayDossierArtifactId(
  index: StructuredTodayIndexReferenceV1,
  worklineId: string
): string {
  const normalized = normalizeStructuredTodayIndexReference(index);
  if (!normalized || !worklineId.trim()) throw new Error("Structured Today dossier source is invalid.");
  return `structured-today-dossier-${sha256Text(
    `${normalized.artifactId}\0${normalized.revision}\0${normalized.contentHash}\0${worklineId}`
  ).slice(0, 32)}`;
}

export function structuredTodayIndexReference(
  artifact: { artifactId: string; revision: number; contentHash: string }
): StructuredTodayIndexReferenceV1 {
  return {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash
  };
}

export function activeStructuredTodayIndexReferenceForDate(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string
): StructuredTodayIndexReferenceV1 | undefined {
  if (!isTraceinkLogicalDate(logicalDate)) return undefined;
  const reference = normalizeStructuredTodayIndexReference(document.activeStructuredIndexByDate?.[logicalDate]);
  if (!reference) return undefined;
  const artifact = findStructuredTodayIndex(document, reference);
  return artifact?.logicalDate === logicalDate ? reference : undefined;
}

export function findStructuredTodayIndex(
  document: TraceinkAssetStoreDocumentV1,
  reference: StructuredTodayIndexReferenceV1
): TodayWorklineIndexV1 | undefined {
  const normalized = normalizeStructuredTodayIndexReference(reference);
  if (!normalized) return undefined;
  const candidates = (document.structuredIndexes ?? []).filter((artifact) =>
    artifact.artifactId === normalized.artifactId &&
    artifact.revision === normalized.revision &&
    artifact.contentHash === normalized.contentHash
  );
  if (candidates.length !== 1) return undefined;
  const parsed = TodayWorklineIndexSchema.safeParse(candidates[0]);
  return parsed.success && validateStructuredTodayIndex(parsed.data).length === 0 ? parsed.data : undefined;
}

export function appendStructuredTodayIndexRevision(
  document: TraceinkAssetStoreDocumentV1,
  artifact: TodayWorklineIndexV1,
  expectedActive: StructuredTodayIndexReferenceV1 | null
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const parsed = TodayWorklineIndexSchema.safeParse(artifact);
  if (!parsed.success || validateStructuredTodayIndex(parsed.data).length > 0) {
    throw new Error("Structured Today index failed integrity validation.");
  }
  const active = activeStructuredTodayIndexReferenceForDate(current, artifact.logicalDate) ?? null;
  if (!sameOptionalStructuredReference(active, expectedActive)) {
    throw new Error("Structured Today active index changed before this revision could be appended.");
  }
  const expectedArtifactId = structuredTodayIndexArtifactId(artifact.logicalDate);
  const nextRevision = nextStructuredTodayIndexRevision(current, artifact.logicalDate);
  if (artifact.artifactId !== expectedArtifactId || artifact.revision !== nextRevision) {
    throw new Error("Structured Today index identity or revision is not repository-owned.");
  }
  const reference = structuredTodayIndexReference(parsed.data);
  return {
    ...current,
    structuredIndexes: [...(current.structuredIndexes ?? []), parsed.data],
    structuredDossiers: current.structuredDossiers ?? [],
    activeStructuredIndexByDate: {
      ...(current.activeStructuredIndexByDate ?? {}),
      [artifact.logicalDate]: reference
    }
  };
}

export function nextStructuredTodayIndexRevision(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string
): number {
  const artifactId = structuredTodayIndexArtifactId(logicalDate);
  return 1 + Math.max(
    0,
    ...(document.structuredIndexes ?? [])
      .filter((artifact) => artifact.artifactId === artifactId)
      .map((artifact) => artifact.revision),
    ...(document.structuredIndexV2Candidates ?? [])
      .filter((artifact) => artifact.artifactId === artifactId)
      .map((artifact) => artifact.revision)
  );
}

export function appendStructuredTodayIndexV2Candidate(
  document: TraceinkAssetStoreDocumentV1,
  artifact: TodayWorklineIndexV2
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const parsed = TodayWorklineIndexV2Schema.safeParse(artifact);
  if (!parsed.success || validateTodayWorklineIndexV2(parsed.data).length > 0) {
    throw new Error("Structured Today V2 index candidate failed integrity validation.");
  }
  const expectedArtifactId = structuredTodayIndexArtifactId(artifact.logicalDate);
  const expectedRevision = nextStructuredTodayIndexV2CandidateRevision(current, artifact.logicalDate);
  if (artifact.artifactId !== expectedArtifactId || artifact.revision !== expectedRevision) {
    throw new Error("Structured Today V2 candidate identity or revision is not repository-owned.");
  }
  return {
    ...current,
    structuredIndexV2Candidates: [...(current.structuredIndexV2Candidates ?? []), parsed.data]
  };
}

export function nextStructuredTodayIndexV2CandidateRevision(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string
): number {
  const artifactId = structuredTodayIndexArtifactId(logicalDate);
  return 1 + Math.max(
    0,
    ...(document.structuredIndexes ?? [])
      .filter((candidate) => candidate.artifactId === artifactId)
      .map((candidate) => candidate.revision),
    ...(document.structuredIndexV2Candidates ?? [])
      .filter((candidate) => candidate.artifactId === artifactId)
      .map((candidate) => candidate.revision)
  );
}

export function latestStructuredTodayIndexV2Candidate(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string
): TodayWorklineIndexV2 | undefined {
  if (!isTraceinkLogicalDate(logicalDate)) return undefined;
  return (document.structuredIndexV2Candidates ?? [])
    .filter((artifact) => artifact.logicalDate === logicalDate)
    .sort((left, right) => right.revision - left.revision)[0];
}

export function findStructuredTodayIndexV2Candidate(
  document: TraceinkAssetStoreDocumentV1,
  reference: { artifactId: string; revision: number; contentHash: string }
): TodayWorklineIndexV2 | undefined {
  const matches = (document.structuredIndexV2Candidates ?? []).filter((artifact) =>
    artifact.artifactId === reference.artifactId &&
    artifact.revision === reference.revision &&
    artifact.contentHash === reference.contentHash
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function appendStructuredTodayDossierV2Candidate(
  document: TraceinkAssetStoreDocumentV1,
  artifact: TodayWorklineDossierV2
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const parsed = TodayWorklineDossierV2Schema.safeParse(artifact);
  if (!parsed.success || validateTodayWorklineDossierV2(parsed.data).length > 0) {
    throw new Error("Structured Today V2 dossier candidate failed integrity validation.");
  }
  const sourceIndex = (current.structuredIndexV2Candidates ?? []).find((candidate) =>
    candidate.artifactId === artifact.sourceIndex.artifactId &&
    candidate.revision === artifact.sourceIndex.revision &&
    candidate.contentHash === artifact.sourceIndex.contentHash
  );
  if (!sourceIndex || !sourceIndex.worklines.some((workline) => workline.worklineId === artifact.worklineId)) {
    throw new Error("Structured Today V2 dossier candidate does not belong to a stored index candidate.");
  }
  const expectedId = structuredTodayDossierArtifactId(artifact.sourceIndex, artifact.worklineId);
  const expectedRevision = nextStructuredTodayDossierV2CandidateRevision(current, artifact.sourceIndex, artifact.worklineId);
  if (artifact.artifactId !== expectedId || artifact.revision !== expectedRevision) {
    throw new Error("Structured Today V2 dossier candidate identity or revision is not repository-owned.");
  }
  return {
    ...current,
    structuredDossierV2Candidates: [...(current.structuredDossierV2Candidates ?? []), parsed.data]
  };
}

export function nextStructuredTodayDossierV2CandidateRevision(
  document: TraceinkAssetStoreDocumentV1,
  sourceIndex: { artifactId: string; revision: number; contentHash: string },
  worklineId: string
): number {
  const artifactId = structuredTodayDossierArtifactId(sourceIndex, worklineId);
  return 1 + Math.max(
    0,
    ...(document.structuredDossierV2Candidates ?? [])
      .filter((candidate) => candidate.artifactId === artifactId)
      .map((candidate) => candidate.revision)
  );
}

export function latestStructuredTodayDossierV2Candidate(
  document: TraceinkAssetStoreDocumentV1,
  sourceIndex: { artifactId: string; revision: number; contentHash: string },
  worklineId: string
): TodayWorklineDossierV2 | undefined {
  const artifactId = structuredTodayDossierArtifactId(sourceIndex, worklineId);
  return (document.structuredDossierV2Candidates ?? [])
    .filter((artifact) => artifact.artifactId === artifactId && artifact.worklineId === worklineId)
    .sort((left, right) => right.revision - left.revision)[0];
}

export function findStructuredTodayDossierV2Candidate(
  document: TraceinkAssetStoreDocumentV1,
  reference: { artifactId: string; revision: number; contentHash: string }
): TodayWorklineDossierV2 | undefined {
  const matches = (document.structuredDossierV2Candidates ?? []).filter((artifact) =>
    artifact.artifactId === reference.artifactId &&
    artifact.revision === reference.revision &&
    artifact.contentHash === reference.contentHash
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function appendStructuredTodayDossierRevision(
  document: TraceinkAssetStoreDocumentV1,
  artifact: TodayWorklineDossierV1,
  expectedActiveIndex: StructuredTodayIndexReferenceV1
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const active = activeStructuredTodayIndexReferenceForDate(current, artifact.logicalDate);
  if (!active || !sameStructuredReference(active, expectedActiveIndex)) {
    throw new Error("Structured Today active index changed before this dossier could be appended.");
  }
  const parsed = TodayWorklineDossierSchema.safeParse(artifact);
  if (!parsed.success || validateStructuredTodayDossier(parsed.data).length > 0) {
    throw new Error("Structured Today dossier failed integrity validation.");
  }
  if (!sameStructuredReference(parsed.data.sourceIndex, expectedActiveIndex)) {
    throw new Error("Structured Today dossier points to a different index revision.");
  }
  const sourceIndex = findStructuredTodayIndex(current, expectedActiveIndex);
  if (!sourceIndex?.worklines.some((workline) => workline.worklineId === artifact.worklineId)) {
    throw new Error("Structured Today dossier workline is not in the active index.");
  }
  const expectedArtifactId = structuredTodayDossierArtifactId(expectedActiveIndex, artifact.worklineId);
  const nextRevision = nextStructuredTodayDossierRevision(current, expectedActiveIndex, artifact.worklineId);
  if (artifact.artifactId !== expectedArtifactId || artifact.revision !== nextRevision) {
    throw new Error("Structured Today dossier identity or revision is not repository-owned.");
  }
  return {
    ...current,
    structuredIndexes: current.structuredIndexes ?? [],
    structuredDossiers: [...(current.structuredDossiers ?? []), parsed.data],
    activeStructuredIndexByDate: current.activeStructuredIndexByDate ?? {}
  };
}

export function nextStructuredTodayDossierRevision(
  document: TraceinkAssetStoreDocumentV1,
  index: StructuredTodayIndexReferenceV1,
  worklineId: string
): number {
  const artifactId = structuredTodayDossierArtifactId(index, worklineId);
  return 1 + Math.max(0, ...(document.structuredDossiers ?? [])
    .filter((artifact) => artifact.artifactId === artifactId)
    .map((artifact) => artifact.revision));
}

export function latestStructuredTodayDossier(
  document: TraceinkAssetStoreDocumentV1,
  index: StructuredTodayIndexReferenceV1,
  worklineId: string
): TodayWorklineDossierV1 | undefined {
  const artifactId = structuredTodayDossierArtifactId(index, worklineId);
  const candidates = (document.structuredDossiers ?? [])
    .filter((artifact) => artifact.artifactId === artifactId && artifact.worklineId === worklineId)
    .sort((left, right) => right.revision - left.revision);
  const parsed = TodayWorklineDossierSchema.safeParse(candidates[0]);
  if (!parsed.success || validateStructuredTodayDossier(parsed.data).length > 0) return undefined;
  return sameStructuredReference(parsed.data.sourceIndex, index) ? parsed.data : undefined;
}

export function structuredTodayDossierReference(artifact: TodayWorklineDossierV1) {
  return { artifactId: artifact.artifactId, revision: artifact.revision, contentHash: artifact.contentHash };
}

export function structuredTodayReflectionReference(reflection: StructuredTodayReflectionV1) {
  return {
    reflectionId: reflection.reflectionId,
    revision: reflection.revision,
    contentHash: reflection.contentHash
  };
}

export function appendStructuredTodayReflectionRevision(
  document: TraceinkAssetStoreDocumentV1,
  dossier: TodayWorklineDossierV1,
  text: string,
  savedAt: string
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const active = activeStructuredTodayIndexReferenceForDate(current, dossier.logicalDate);
  const currentDossier = active
    ? latestStructuredTodayDossier(current, active, dossier.worklineId)
    : undefined;
  if (!currentDossier || structuredArtifactReferenceKey(currentDossier) !== structuredArtifactReferenceKey(dossier)) {
    throw new Error("Structured Today dossier changed before reflection save.");
  }
  if (typeof text !== "string" || !text.trim() || Number.isNaN(Date.parse(savedAt))) {
    throw new Error("Structured Today reflection must preserve non-empty user text and a valid save time.");
  }
  const reflectionId = `structured-today-reflection-${sha256Text(
    structuredArtifactReferenceKey(dossier)
  ).slice(0, 24)}`;
  const previous = (current.structuredReflections ?? [])
    .filter((reflection) => reflection.reflectionId === reflectionId)
    .sort((left, right) => left.revision - right.revision);
  const contentHash = sha256Text(text);
  const latest = previous.at(-1);
  if (latest?.contentHash === contentHash && latest.text === text) {
    return current;
  }
  const reflection = StructuredTodayReflectionSchema.parse({
    schema: "today-workline-reflection/v1",
    reflectionId,
    revision: (previous.at(-1)?.revision ?? 0) + 1,
    logicalDate: dossier.logicalDate,
    worklineId: dossier.worklineId,
    sourceDossier: structuredTodayDossierReference(dossier),
    text,
    createdAt: previous[0]?.createdAt ?? savedAt,
    savedAt,
    contentHash
  });
  return {
    ...current,
    structuredReflections: [...(current.structuredReflections ?? []), reflection]
  };
}

export function latestStructuredTodayReflection(
  document: TraceinkAssetStoreDocumentV1,
  dossier: TodayWorklineDossierV1
): StructuredTodayReflectionV1 | undefined {
  const referenceKey = structuredArtifactReferenceKey(dossier);
  return (document.structuredReflections ?? [])
    .filter((reflection) => structuredReferenceKey(reflection.sourceDossier) === referenceKey)
    .sort((left, right) => right.revision - left.revision)[0];
}

export function structuredTodayProposalArtifactId(reflection: StructuredTodayReflectionV1): string {
  return `structured-today-proposals-${sha256Text(
    structuredReflectionReferenceKey(reflection)
  ).slice(0, 24)}`;
}

export function nextStructuredTodayProposalRevision(
  document: TraceinkAssetStoreDocumentV1,
  reflection: StructuredTodayReflectionV1
): number {
  const artifactId = structuredTodayProposalArtifactId(reflection);
  return 1 + Math.max(0, ...(document.structuredProposals ?? [])
    .filter((artifact) => artifact.artifactId === artifactId)
    .map((artifact) => artifact.revision));
}

export function appendStructuredTodayProposalRevision(
  document: TraceinkAssetStoreDocumentV1,
  artifact: StructuredTodayProposalArtifactV1,
  reflection: StructuredTodayReflectionV1
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const dossier = (current.structuredDossiers ?? []).find((candidate) =>
    structuredReferenceKey(artifact.sourceDossier) === structuredArtifactReferenceKey(candidate)
  );
  const currentReflection = dossier ? latestStructuredTodayReflection(current, dossier) : undefined;
  if (
    !dossier ||
    !currentReflection ||
    structuredReflectionReferenceKey(currentReflection) !== structuredReflectionReferenceKey(reflection) ||
    structuredReflectionReferenceKey(currentReflection) !== structuredReferenceKey(artifact.sourceReflection)
  ) {
    throw new Error("你的回顾在整理期间已经更新；旧版本的整理结果没有保存，请重新整理最新版本。");
  }
  const parsed = StructuredTodayProposalArtifactSchema.safeParse(artifact);
  if (!parsed.success || validateStructuredTodayProposalArtifact(parsed.data, currentReflection).length > 0) {
    throw new Error("Structured Today proposals failed integrity validation.");
  }
  const expectedId = structuredTodayProposalArtifactId(reflection);
  const expectedRevision = nextStructuredTodayProposalRevision(current, reflection);
  if (artifact.artifactId !== expectedId || artifact.revision !== expectedRevision) {
    throw new Error("Structured Today proposal identity or revision is not repository-owned.");
  }
  return {
    ...current,
    structuredProposals: [...(current.structuredProposals ?? []), parsed.data]
  };
}

export function latestStructuredTodayProposals(
  document: TraceinkAssetStoreDocumentV1,
  reflection: StructuredTodayReflectionV1
): StructuredTodayProposalArtifactV1 | undefined {
  const reference = structuredReflectionReferenceKey(reflection);
  return (document.structuredProposals ?? [])
    .filter((artifact) => structuredReferenceKey(artifact.sourceReflection) === reference)
    .sort((left, right) => right.revision - left.revision)[0];
}

export function appendStructuredTodayProposalDisposition(
  document: TraceinkAssetStoreDocumentV1,
  proposalArtifact: StructuredTodayProposalArtifactV1,
  proposalId: string,
  input: { action: "accept" | "dismiss" | "defer" | "rewrite"; rewriteText?: string; decidedAt: string }
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const stored = (current.structuredProposals ?? []).find((artifact) =>
    structuredArtifactReferenceKey(artifact) === structuredArtifactReferenceKey(proposalArtifact)
  );
  const proposal = stored?.proposals.find((candidate) => candidate.proposalId === proposalId);
  if (!stored || !proposal) throw new Error("Structured Today proposal is not current.");
  const dispositionId = `structured-today-disposition-${sha256Text(
    `${structuredArtifactReferenceKey(stored)}\0${proposalId}`
  ).slice(0, 24)}`;
  const previous = (current.structuredProposalDispositions ?? [])
    .filter((disposition) => disposition.dispositionId === dispositionId);
  const disposition = StructuredTodayProposalDispositionSchema.parse({
    schema: "today-proposal-disposition/v1",
    dispositionId,
    revision: 1 + Math.max(0, ...previous.map((item) => item.revision)),
    logicalDate: stored.logicalDate,
    worklineId: stored.worklineId,
    proposalArtifact: {
      artifactId: stored.artifactId,
      revision: stored.revision,
      contentHash: stored.contentHash
    },
    proposalId,
    category: proposal.category,
    action: input.action,
    ...(input.action === "rewrite" ? { rewriteText: input.rewriteText } : {}),
    decidedAt: input.decidedAt
  });
  return {
    ...current,
    structuredProposalDispositions: [...(current.structuredProposalDispositions ?? []), disposition]
  };
}

export function latestStructuredTodayProposalDispositions(
  document: TraceinkAssetStoreDocumentV1,
  proposalArtifact: StructuredTodayProposalArtifactV1
): StructuredTodayProposalDispositionV1[] {
  const reference = structuredArtifactReferenceKey(proposalArtifact);
  const latest = new Map<string, StructuredTodayProposalDispositionV1>();
  for (const disposition of document.structuredProposalDispositions ?? []) {
    if (structuredReferenceKey(disposition.proposalArtifact) !== reference) continue;
    const previous = latest.get(disposition.proposalId);
    if (!previous || disposition.revision > previous.revision) latest.set(disposition.proposalId, disposition);
  }
  return proposalArtifact.proposals.flatMap((proposal) => {
    const disposition = latest.get(proposal.proposalId);
    return disposition ? [disposition] : [];
  });
}

export function upsertStructuredTodayRun(
  document: TraceinkAssetStoreDocumentV1,
  record: StructuredTodayRunRecordV1
): TraceinkAssetStoreDocumentV1 {
  const current = canonicalStore(document);
  const normalized = normalizeStructuredRun(record);
  if (!normalized) throw new Error("Structured Today run record is invalid.");
  const existing = current.structuredRuns ?? [];
  const previous = existing.find((item) => item.runId === normalized.runId);
  if (previous && previous.kind !== normalized.kind) {
    throw new Error("Structured Today run identity cannot cross workflow kinds.");
  }
  return {
    ...current,
    structuredRuns: [...existing.filter((item) => item.runId !== normalized.runId), normalized]
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .slice(-200)
  };
}

export function findTraceinkArtifact(
  document: TraceinkAssetStoreDocumentV1,
  reference: TraceinkArtifactReferenceV1
): TraceinkArtifactV1 | undefined {
  const normalizedReference = normalizeTraceinkArtifactReferenceV1(reference);
  if (!normalizedReference) return undefined;
  return validatedArtifactForReference(document, normalizedReference);
}

export function traceinkIndexArtifactId(logicalDate: string): string {
  if (!isTraceinkLogicalDate(logicalDate)) throw new Error("Traceink index logical date is invalid.");
  return `traceink-index-${logicalDate}`;
}

export function traceinkDossierArtifactId(index: TraceinkIndexArtifactReferenceV1, worklineId: string): string {
  const normalized = normalizeTraceinkArtifactReferenceV1(index);
  if (!normalized || normalized.stage !== "index" || !worklineId.trim()) {
    throw new Error("Traceink dossier source identity is invalid.");
  }
  return `traceink-dossier-${sha256TraceinkText(`${normalized.artifactId}\0${normalized.revision}\0${normalized.outputHash}\0${worklineId}`).slice(0, 32)}`;
}

export function traceinkProposalsArtifactId(
  reflection: ReturnType<typeof userReflectionAssetReference>
): string {
  return `traceink-proposals-${sha256TraceinkText(`${reflection.reflectionId}\0${reflection.revision}\0${reflection.contentHash}`).slice(0, 32)}`;
}

function canonicalStore(document: TraceinkAssetStoreDocumentV1): TraceinkAssetStoreDocumentV1 {
  if (!isCanonicalStoreEnvelope(document)) throw new Error("Traceink asset store document is invalid.");
  const current = normalizeTraceinkAssetStore(document);
  if (!isDeepStrictEqual(current, document)) throw new Error("Traceink asset store document failed integrity validation.");
  return current;
}

function sameIndexReference(left: TraceinkIndexArtifactReferenceV1, right: TraceinkIndexArtifactReferenceV1): boolean {
  const normalized = normalizeTraceinkArtifactReferenceV1(right);
  return Boolean(normalized && normalized.stage === "index" && referenceKey(left) === referenceKey(normalized));
}

function normalizeActiveIndexes(
  value: unknown,
  artifactByReference: ReadonlyMap<string, TraceinkArtifactV1>
): Record<string, TraceinkIndexArtifactReferenceV1> {
  const raw = asRecord(value);
  if (!raw) return {};
  const active: Record<string, TraceinkIndexArtifactReferenceV1> = {};
  for (const [logicalDate, valueForDate] of Object.entries(raw)) {
    if (!isTraceinkLogicalDate(logicalDate)) continue;
    const reference = normalizeTraceinkArtifactReferenceV1(valueForDate);
    if (!reference || reference.stage !== "index") continue;
    const artifact = artifactByReference.get(referenceKey(reference));
    if (!artifact || artifact.stage !== "index" || artifact.logicalDate !== logicalDate) continue;
    active[logicalDate] = { ...reference, stage: "index" };
  }
  return active;
}

function normalizeStructuredIndexes(value: unknown): TodayWorklineIndexV1[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, TodayWorklineIndexV1>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = TodayWorklineIndexSchema.safeParse(candidate);
    if (!parsed.success || validateStructuredTodayIndex(parsed.data).length > 0) continue;
    const key = JSON.stringify([parsed.data.artifactId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, artifact]) => artifact)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision);
}

function normalizeStructuredIndexV2Candidates(value: unknown): TodayWorklineIndexV2[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, TodayWorklineIndexV2>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = TodayWorklineIndexV2Schema.safeParse(candidate);
    if (!parsed.success || validateTodayWorklineIndexV2(parsed.data).length > 0) continue;
    const key = JSON.stringify([parsed.data.artifactId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, artifact]) => artifact)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision);
}

function normalizeStructuredDossierV2Candidates(
  value: unknown,
  indexByReference: ReadonlyMap<string, TodayWorklineIndexV2>
): TodayWorklineDossierV2[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, TodayWorklineDossierV2>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = TodayWorklineDossierV2Schema.safeParse(candidate);
    if (!parsed.success || validateTodayWorklineDossierV2(parsed.data).length > 0) continue;
    const source = indexByReference.get(structuredTodayReferenceKey(parsed.data.sourceIndex));
    if (!source || !source.worklines.some((workline) => workline.worklineId === parsed.data.worklineId)) continue;
    const key = JSON.stringify([parsed.data.artifactId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, artifact]) => artifact)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision);
}

function normalizeStructuredDossiers(
  value: unknown,
  indexByReference: ReadonlyMap<string, TodayWorklineIndexV1>
): TodayWorklineDossierV1[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, TodayWorklineDossierV1>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = TodayWorklineDossierSchema.safeParse(candidate);
    if (!parsed.success || validateStructuredTodayDossier(parsed.data).length > 0) continue;
    const source = indexByReference.get(structuredTodayReferenceKey(parsed.data.sourceIndex));
    if (!source || !source.worklines.some((workline) => workline.worklineId === parsed.data.worklineId)) continue;
    const key = JSON.stringify([parsed.data.artifactId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, artifact]) => artifact)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision);
}

function normalizeStructuredReflections(
  value: unknown,
  dossierByReference: ReadonlyMap<string, TodayWorklineDossierV1>
): StructuredTodayReflectionV1[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, StructuredTodayReflectionV1>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = StructuredTodayReflectionSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const dossier = dossierByReference.get(structuredReferenceKey(parsed.data.sourceDossier));
    if (!dossier || dossier.logicalDate !== parsed.data.logicalDate || dossier.worklineId !== parsed.data.worklineId) continue;
    const key = JSON.stringify([parsed.data.reflectionId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, reflection]) => reflection)
    .sort((left, right) => left.reflectionId.localeCompare(right.reflectionId) || left.revision - right.revision);
}

function normalizeStructuredProposals(
  value: unknown,
  dossierByReference: ReadonlyMap<string, TodayWorklineDossierV1>,
  reflectionByReference: ReadonlyMap<string, StructuredTodayReflectionV1>
): StructuredTodayProposalArtifactV1[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, StructuredTodayProposalArtifactV1>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = StructuredTodayProposalArtifactSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const dossier = dossierByReference.get(structuredReferenceKey(parsed.data.sourceDossier));
    const reflection = reflectionByReference.get(structuredReferenceKey(parsed.data.sourceReflection));
    if (
      !dossier ||
      !reflection ||
      dossier.logicalDate !== parsed.data.logicalDate ||
      dossier.worklineId !== parsed.data.worklineId ||
      reflection.logicalDate !== parsed.data.logicalDate ||
      reflection.worklineId !== parsed.data.worklineId ||
      validateStructuredTodayProposalArtifact(parsed.data, reflection).length > 0
    ) continue;
    const key = JSON.stringify([parsed.data.artifactId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, artifact]) => artifact)
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId) || left.revision - right.revision);
}

function normalizeStructuredProposalDispositions(
  value: unknown,
  proposalByReference: ReadonlyMap<string, StructuredTodayProposalArtifactV1>
): StructuredTodayProposalDispositionV1[] {
  if (!Array.isArray(value)) return [];
  const byRevision = new Map<string, StructuredTodayProposalDispositionV1>();
  const conflicts = new Set<string>();
  for (const candidate of value) {
    const parsed = StructuredTodayProposalDispositionSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const artifact = proposalByReference.get(structuredReferenceKey(parsed.data.proposalArtifact));
    const proposal = artifact?.proposals.find((item) => item.proposalId === parsed.data.proposalId);
    if (
      !artifact ||
      !proposal ||
      artifact.logicalDate !== parsed.data.logicalDate ||
      artifact.worklineId !== parsed.data.worklineId ||
      proposal.category !== parsed.data.category
    ) continue;
    const key = JSON.stringify([parsed.data.dispositionId, parsed.data.revision]);
    const previous = byRevision.get(key);
    if (!previous) byRevision.set(key, parsed.data);
    else if (!isDeepStrictEqual(previous, parsed.data)) conflicts.add(key);
  }
  return [...byRevision.entries()]
    .filter(([key]) => !conflicts.has(key))
    .map(([, disposition]) => disposition)
    .sort((left, right) => left.dispositionId.localeCompare(right.dispositionId) || left.revision - right.revision);
}

function normalizeStructuredRuns(value: unknown): StructuredTodayRunRecordV1[] {
  if (!Array.isArray(value)) return [];
  const latest = new Map<string, StructuredTodayRunRecordV1>();
  for (const candidate of value) {
    const normalized = normalizeStructuredRun(candidate);
    if (!normalized) continue;
    const previous = latest.get(normalized.runId);
    if (!previous || normalized.updatedAt >= previous.updatedAt) latest.set(normalized.runId, normalized);
  }
  return [...latest.values()]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .slice(-200);
}

function normalizeStructuredRun(value: unknown): StructuredTodayRunRecordV1 | undefined {
  const raw = asRecord(value);
  const runId = typeof raw?.runId === "string" ? raw.runId.trim() : "";
  const kind = raw?.kind === "index" || raw?.kind === "dossier" || raw?.kind === "proposals" ? raw.kind : undefined;
  const logicalDate = typeof raw?.logicalDate === "string" && isTraceinkLogicalDate(raw.logicalDate)
    ? raw.logicalDate
    : undefined;
  const status = raw?.status === "running" || raw?.status === "ready" || raw?.status === "failed" || raw?.status === "cancelled"
    ? raw.status
    : undefined;
  const stage = typeof raw?.stage === "string" ? raw.stage.trim() : "";
  const completed = typeof raw?.completed === "number" ? raw.completed : Number.NaN;
  const total = typeof raw?.total === "number" ? raw.total : Number.NaN;
  const startedAt = typeof raw?.startedAt === "string" && !Number.isNaN(Date.parse(raw.startedAt))
    ? new Date(raw.startedAt).toISOString()
    : undefined;
  const updatedAt = typeof raw?.updatedAt === "string" && !Number.isNaN(Date.parse(raw.updatedAt))
    ? new Date(raw.updatedAt).toISOString()
    : undefined;
  const worklineId = typeof raw?.worklineId === "string" && raw.worklineId.trim() ? raw.worklineId.trim() : undefined;
  const message = typeof raw?.message === "string" && raw.message.trim() ? raw.message.replace(/\s+/g, " ").trim().slice(0, 500) : undefined;
  if (
    !runId ||
    !kind ||
    !logicalDate ||
    !status ||
    !stage ||
    !Number.isSafeInteger(completed) ||
    !Number.isSafeInteger(total) ||
    completed < 0 ||
    total < 0 ||
    completed > total ||
    !startedAt ||
    !updatedAt ||
    (kind !== "index" && !worklineId)
  ) return undefined;
  return {
    runId,
    kind,
    logicalDate,
    ...(worklineId ? { worklineId } : {}),
    status,
    stage,
    completed,
    total,
    startedAt,
    updatedAt,
    ...(message ? { message } : {})
  };
}

function normalizeActiveStructuredIndexes(
  value: unknown,
  indexByReference: ReadonlyMap<string, TodayWorklineIndexV1>
): Record<string, StructuredTodayIndexReferenceV1> {
  const raw = asRecord(value);
  if (!raw) return {};
  const active: Record<string, StructuredTodayIndexReferenceV1> = {};
  for (const [logicalDate, candidate] of Object.entries(raw)) {
    if (!isTraceinkLogicalDate(logicalDate)) continue;
    const reference = normalizeStructuredTodayIndexReference(candidate);
    if (!reference) continue;
    const artifact = indexByReference.get(structuredTodayReferenceKey(reference));
    if (artifact?.logicalDate === logicalDate) active[logicalDate] = reference;
  }
  return active;
}

function normalizeStructuredTodayIndexReference(value: unknown): StructuredTodayIndexReferenceV1 | undefined {
  const raw = asRecord(value);
  const artifactId = typeof raw?.artifactId === "string" ? raw.artifactId.trim() : "";
  const revision = typeof raw?.revision === "number" ? raw.revision : 0;
  const contentHash = typeof raw?.contentHash === "string" ? raw.contentHash : "";
  if (!artifactId || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(contentHash)) {
    return undefined;
  }
  return { artifactId, revision, contentHash };
}

function sameStructuredReference(
  left: StructuredTodayIndexReferenceV1,
  right: StructuredTodayIndexReferenceV1
): boolean {
  const normalizedLeft = normalizeStructuredTodayIndexReference(left);
  const normalizedRight = normalizeStructuredTodayIndexReference(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    structuredTodayReferenceKey(normalizedLeft) === structuredTodayReferenceKey(normalizedRight)
  );
}

function sameOptionalStructuredReference(
  current: StructuredTodayIndexReferenceV1 | null,
  expected: StructuredTodayIndexReferenceV1 | null
): boolean {
  if (!current || !expected) return current === null && expected === null;
  return sameStructuredReference(current, expected);
}

function structuredTodayReferenceKey(reference: StructuredTodayIndexReferenceV1): string {
  return JSON.stringify([reference.artifactId, reference.revision, reference.contentHash]);
}

function structuredArtifactReferenceKey(artifact: {
  artifactId: string;
  revision: number;
  contentHash: string;
}): string {
  return structuredReferenceKey(artifact);
}

function structuredReflectionReferenceKey(reflection: {
  reflectionId: string;
  revision: number;
  contentHash: string;
}): string {
  return JSON.stringify([reflection.reflectionId, reflection.revision, reflection.contentHash]);
}

function structuredReferenceKey(reference: {
  artifactId?: string;
  reflectionId?: string;
  revision: number;
  contentHash: string;
}): string {
  return "reflectionId" in reference
    ? JSON.stringify([reference.reflectionId, reference.revision, reference.contentHash])
    : JSON.stringify([reference.artifactId, reference.revision, reference.contentHash]);
}

function uniqueArtifacts(artifacts: TraceinkArtifactV1[]): TraceinkArtifactV1[] {
  const result: TraceinkArtifactV1[] = [];
  const byIdentity = new Map<string, TraceinkArtifactV1>();
  const conflicts = new Set<string>();
  for (const artifact of artifacts) {
    const key = artifactRevisionKey(artifact);
    const previous = byIdentity.get(key);
    if (!previous) {
      byIdentity.set(key, artifact);
      result.push(artifact);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(artifact)) conflicts.add(key);
  }
  return conflicts.size === 0 ? result : result.filter((artifact) => !conflicts.has(artifactRevisionKey(artifact)));
}

function uniqueReflections(reflections: UserReflectionAssetV1[]): UserReflectionAssetV1[] {
  const result: UserReflectionAssetV1[] = [];
  const byIdentity = new Map<string, UserReflectionAssetV1>();
  const conflicts = new Set<string>();
  for (const reflection of reflections) {
    const key = reflectionRevisionKey(reflection);
    const previous = byIdentity.get(key);
    if (!previous) {
      byIdentity.set(key, reflection);
      result.push(reflection);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(reflection)) conflicts.add(key);
  }
  return conflicts.size === 0
    ? result
    : result.filter((reflection) => !conflicts.has(reflectionRevisionKey(reflection)));
}

function uniqueProposalDispositions(
  dispositions: TraceinkProposalDispositionV1[]
): TraceinkProposalDispositionV1[] {
  const result: TraceinkProposalDispositionV1[] = [];
  const byIdentity = new Map<string, TraceinkProposalDispositionV1>();
  const conflicts = new Set<string>();
  for (const disposition of dispositions) {
    const key = proposalDispositionRevisionKey(disposition);
    const previous = byIdentity.get(key);
    if (!previous) {
      byIdentity.set(key, disposition);
      result.push(disposition);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(disposition)) conflicts.add(key);
  }
  return conflicts.size === 0
    ? result
    : result.filter((item) => !conflicts.has(proposalDispositionRevisionKey(item)));
}

function stableArtifactLineages(artifacts: TraceinkArtifactV1[]): TraceinkArtifactV1[] {
  const lineageById = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const artifact of artifacts) {
    const lineage = JSON.stringify([
      artifact.stage,
      artifact.logicalDate,
      artifact.worklineId ?? null,
      artifact.sourceReflection ?? null
    ]);
    const previous = lineageById.get(artifact.id);
    if (previous === undefined) lineageById.set(artifact.id, lineage);
    else if (previous !== lineage) conflicts.add(artifact.id);
  }
  return conflicts.size === 0 ? artifacts : artifacts.filter((artifact) => !conflicts.has(artifact.id));
}

function stableReflectionLineages(reflections: UserReflectionAssetV1[]): UserReflectionAssetV1[] {
  const lineageById = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const reflection of reflections) {
    const lineage = JSON.stringify([
      reflection.logicalDate,
      reflection.worklineId,
      reflection.dossier
    ]);
    const previous = lineageById.get(reflection.id);
    if (previous === undefined) lineageById.set(reflection.id, lineage);
    else if (previous !== lineage) conflicts.add(reflection.id);
  }
  return conflicts.size === 0
    ? reflections
    : reflections.filter((reflection) => !conflicts.has(reflection.id));
}

function stableProposalDispositionLineages(
  dispositions: TraceinkProposalDispositionV1[]
): TraceinkProposalDispositionV1[] {
  const lineageById = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const disposition of dispositions) {
    const lineage = JSON.stringify([
      disposition.logicalDate,
      disposition.worklineId,
      disposition.proposalArtifact,
      disposition.proposalId,
      disposition.category
    ]);
    const previous = lineageById.get(disposition.id);
    if (previous === undefined) lineageById.set(disposition.id, lineage);
    else if (previous !== lineage) conflicts.add(disposition.id);
  }
  return conflicts.size === 0
    ? dispositions
    : dispositions.filter((item) => !conflicts.has(item.id));
}

function reflectionDossierResolves(
  reflection: UserReflectionAssetV1,
  artifactByReference: ReadonlyMap<string, TraceinkArtifactV1>
): boolean {
  const dossier = artifactByReference.get(referenceKey(reflection.dossier));
  return Boolean(
    dossier &&
    dossier.stage === "dossier" &&
    dossier.logicalDate === reflection.logicalDate &&
    dossier.worklineId === reflection.worklineId
  );
}

function proposalDispositionResolves(
  disposition: TraceinkProposalDispositionV1,
  artifactByReference: ReadonlyMap<string, TraceinkArtifactV1>
): boolean {
  const artifact = asProposalsArtifact(artifactByReference.get(referenceKey(disposition.proposalArtifact)));
  const proposal = artifact?.navigation.find((item) => item.id === disposition.proposalId);
  return Boolean(
    artifact &&
    proposal &&
    disposition.id === traceinkProposalDispositionId(disposition.proposalArtifact, disposition.proposalId) &&
    artifact.logicalDate === disposition.logicalDate &&
    artifact.worklineId === disposition.worklineId &&
    proposal.category === disposition.category
  );
}

function blockInvalidProposalSourceQuotes(
  artifact: TraceinkArtifactV1,
  reflection: UserReflectionAssetV1
): TraceinkArtifactV1 {
  let blockedSourceQuotes = 0;
  let blockedProposalTexts = 0;
  const navigation = artifact.navigation.filter((item) => {
    if (!isProposalNavigationItem(item)) return true;
    const sourceResolves = item.sourceQuote.length > 0 && reflection.text.includes(item.sourceQuote);
    const proposalResolves = item.proposalText.length > 0 && artifact.rawMarkdown.includes(item.proposalText);
    if (!sourceResolves) blockedSourceQuotes += 1;
    if (!proposalResolves) blockedProposalTexts += 1;
    return sourceResolves && proposalResolves;
  });
  const diagnostics: string[] = [];
  if (blockedSourceQuotes > 0) {
    diagnostics.push(`Traceink storage diagnostic: blocked ${blockedSourceQuotes} proposal source quote(s) that do not resolve to the saved reflection.`);
  }
  if (blockedProposalTexts > 0) {
    diagnostics.push(`Traceink storage diagnostic: blocked ${blockedProposalTexts} proposal text sidecar(s) that do not resolve to rawMarkdown.`);
  }
  if (!artifact.rawMarkdown.includes(reflection.text)) {
    diagnostics.push("Traceink storage diagnostic: proposal rawMarkdown does not reproduce the saved reflection verbatim.");
  }
  if (diagnostics.length === 0) return artifact;
  return {
    ...artifact,
    navigation,
    warnings: [...artifact.warnings, ...diagnostics.filter((diagnostic) => !artifact.warnings.includes(diagnostic))]
  };
}

function isProposalNavigationItem(
  item: TraceinkArtifactV1["navigation"][number]
): item is TraceinkProposalNavigationItemV1 {
  return "category" in item && "proposalText" in item && "sourceQuote" in item;
}

function asProposalsArtifact(artifact: TraceinkArtifactV1 | undefined): TraceinkProposalsArtifactV1 | undefined {
  if (
    !artifact ||
    artifact.stage !== "proposals" ||
    !artifact.worklineId ||
    !artifact.sourceReflection ||
    artifact.navigation.some((item) => !isProposalNavigationItem(item)) ||
    TRACEINK_PROPOSAL_CATEGORIES.some((category) =>
      !artifact.navigation.some((item) => isProposalNavigationItem(item) && item.category === category)
    )
  ) return undefined;
  return {
    ...artifact,
    stage: "proposals",
    worklineId: artifact.worklineId,
    sourceReflection: artifact.sourceReflection,
    navigation: artifact.navigation as TraceinkProposalNavigationItemV1[]
  };
}

function assertCompleteProposalNavigation(
  navigation: TraceinkProposalsArtifactDraftV1["navigation"],
  rawMarkdown: string,
  reflectionText: string
): void {
  const categories = new Set<string>();
  const ids = new Set<string>();
  for (const item of navigation) {
    if (
      !isProposalNavigationItem(item) ||
      ids.has(item.id) ||
      !item.proposalText.trim() ||
      !rawMarkdown.includes(item.proposalText) ||
      !item.sourceQuote.trim() ||
      !reflectionText.includes(item.sourceQuote)
    ) throw new Error("Traceink proposal navigation does not resolve to rawMarkdown and the saved reflection.");
    ids.add(item.id);
    categories.add(item.category);
  }
  if (TRACEINK_PROPOSAL_CATEGORIES.some((category) => !categories.has(category))) {
    throw new Error("Traceink proposal navigation must include all five categories.");
  }
}

function reflectionForReference(
  document: TraceinkAssetStoreDocumentV1,
  reference: ReturnType<typeof userReflectionAssetReference>
): UserReflectionAssetV1 | undefined {
  return document.reflections.find((reflection) => sameReflectionReference(
    userReflectionAssetReference(reflection),
    reference
  ));
}

function sameReflectionReference(
  left: ReturnType<typeof userReflectionAssetReference>,
  right: ReturnType<typeof userReflectionAssetReference>
): boolean {
  return reflectionReferenceKey(left) === reflectionReferenceKey(right);
}

export function sameTraceinkArtifactReference(
  left: TraceinkArtifactReferenceV1,
  right: TraceinkArtifactReferenceV1
): boolean {
  return sameArtifactReference(left, right);
}

export function sameTraceinkReflectionReference(
  left: ReturnType<typeof userReflectionAssetReference>,
  right: ReturnType<typeof userReflectionAssetReference>
): boolean {
  return sameReflectionReference(left, right);
}

function sameArtifactReference(
  left: TraceinkArtifactReferenceV1,
  right: TraceinkArtifactReferenceV1
): boolean {
  return referenceKey(left) === referenceKey(right);
}

function traceinkProposalDispositionId(
  artifact: TraceinkArtifactReferenceV1,
  proposalId: string
): string {
  return `traceink-proposal-disposition-${sha256TraceinkText(`${referenceKey(artifact)}\0${proposalId}`).slice(0, 32)}`;
}

function referenceMatchesArtifact(reference: TraceinkArtifactReferenceV1, artifact: TraceinkArtifactV1): boolean {
  return artifact.id === reference.artifactId &&
    artifact.stage === reference.stage &&
    artifact.revision === reference.revision &&
    artifact.outputHash === reference.outputHash;
}

function validatedArtifactForReference(
  document: TraceinkAssetStoreDocumentV1,
  reference: TraceinkArtifactReferenceV1
): TraceinkArtifactV1 | undefined {
  const candidate = document.artifacts.find((artifact) => referenceMatchesArtifact(reference, artifact));
  const normalized = normalizeTraceinkArtifactV1(candidate);
  return normalized && referenceMatchesArtifact(reference, normalized) ? normalized : undefined;
}

function sameOptionalIndexReference(
  current: TraceinkIndexArtifactReferenceV1 | undefined,
  expected: TraceinkIndexArtifactReferenceV1 | null
): boolean {
  if (!current || !expected) return !current && expected === null;
  const normalizedExpected = normalizeTraceinkArtifactReferenceV1(expected);
  return Boolean(
    normalizedExpected &&
    normalizedExpected.stage === "index" &&
    referenceKey(current) === referenceKey(normalizedExpected)
  );
}

function sameOptionalArtifactReference(
  current: TraceinkArtifactReferenceV1 | undefined,
  expected: TraceinkArtifactReferenceV1 | null
): boolean {
  if (!current || !expected) return !current && expected === null;
  const normalizedExpected = normalizeTraceinkArtifactReferenceV1(expected);
  return Boolean(normalizedExpected && referenceKey(current) === referenceKey(normalizedExpected));
}

function referenceKey(reference: TraceinkArtifactReferenceV1): string {
  return JSON.stringify([reference.artifactId, reference.stage, reference.revision, reference.outputHash]);
}

function reflectionReferenceKey(reference: {
  reflectionId: string;
  revision: number;
  contentHash: string;
}): string {
  return JSON.stringify([reference.reflectionId, reference.revision, reference.contentHash]);
}

function artifactRevisionKey(artifact: TraceinkArtifactV1): string {
  return JSON.stringify([artifact.id, artifact.stage, artifact.revision]);
}

function reflectionRevisionKey(reflection: UserReflectionAssetV1): string {
  return JSON.stringify([reflection.id, reflection.revision]);
}

function proposalDispositionRevisionKey(disposition: TraceinkProposalDispositionV1): string {
  return JSON.stringify([disposition.id, disposition.revision]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isCanonicalStoreEnvelope(value: unknown): value is TraceinkAssetStoreDocumentV1 {
  const raw = asRecord(value);
  return Boolean(
    raw &&
    raw.schemaVersion === 1 &&
    Array.isArray(raw.artifacts) &&
    Array.isArray(raw.reflections) &&
    (raw.proposalDispositions === undefined || Array.isArray(raw.proposalDispositions)) &&
    asRecord(raw.activeIndexByDate) &&
    (raw.structuredIndexes === undefined || Array.isArray(raw.structuredIndexes)) &&
    (raw.structuredIndexV2Candidates === undefined || Array.isArray(raw.structuredIndexV2Candidates)) &&
    (raw.structuredDossierV2Candidates === undefined || Array.isArray(raw.structuredDossierV2Candidates)) &&
    (raw.structuredDossiers === undefined || Array.isArray(raw.structuredDossiers)) &&
    (raw.activeStructuredIndexByDate === undefined || asRecord(raw.activeStructuredIndexByDate)) &&
    (raw.structuredReflections === undefined || Array.isArray(raw.structuredReflections)) &&
    (raw.structuredProposals === undefined || Array.isArray(raw.structuredProposals)) &&
    (raw.structuredProposalDispositions === undefined || Array.isArray(raw.structuredProposalDispositions)) &&
    (raw.structuredRuns === undefined || Array.isArray(raw.structuredRuns))
  );
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
