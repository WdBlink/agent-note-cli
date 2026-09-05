import { z } from "zod";
import {
  DigestExecutionResultSchema,
  DossierAnalysisCandidateSchema,
  DossierCandidateSchema,
  DossierCritiqueCandidateSchema,
  EvidenceLocatorSchema,
  STRUCTURED_TODAY_DOSSIER_SCHEMA,
  STRUCTURED_TODAY_INDEX_SCHEMA,
  STRUCTURED_TODAY_WORKFLOW_VERSION,
  StructuredTodayDossierWorkflowOutputSchema,
  StructuredTodayIndexWorkflowOutputSchema,
  StructuredTodayModelInvocationSchema,
  StructuredTodayProposalArtifactSchema,
  STRUCTURED_TODAY_PROPOSAL_CATEGORIES,
  TodayWorklineDossierSchema,
  TodayWorklineIndexSchema,
  WorklineSynthesisCandidateSchema,
  canonicalContentHash,
  participationAccount,
  sha256Text,
  type DigestExecutionResultV1,
  type SessionDispositionV1,
  type StructuredTodayDossierWorkflowInput,
  type StructuredTodayDossierWorkflowOutput,
  type StructuredTodayIndexWorkflowInput,
  type StructuredTodayIndexWorkflowOutput,
  type StructuredTodayModelInvocationV1,
  type StructuredTodayProposalArtifactV1,
  type StructuredTodayProposalSetCandidate,
  type StructuredTodayReflectionV1,
  type TodayWorklineIndexV1,
  type TodayWorklineV1,
  type WorklineSynthesisCandidate
} from "./structured-today-contracts";

export const StructuredTodaySynthesisEnvelopeSchema = z.object({
  digestResults: z.array(DigestExecutionResultSchema),
  synthesis: WorklineSynthesisCandidateSchema,
  invocation: StructuredTodayModelInvocationSchema.optional()
}).strict();

export const StructuredTodayGatheredDossierEvidenceSchema = z.object({
  workline: z.unknown(),
  admittedSessionIds: z.array(z.string().trim().min(1)).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1)
}).strict();

export const StructuredTodayComposeEnvelopeSchema = z.object({
  analysis: DossierAnalysisCandidateSchema,
  analysisInvocation: StructuredTodayModelInvocationSchema,
  critique: DossierCritiqueCandidateSchema,
  critiqueInvocation: StructuredTodayModelInvocationSchema,
  dossier: DossierCandidateSchema,
  composeInvocation: StructuredTodayModelInvocationSchema
}).strict();

export type StructuredTodaySynthesisEnvelope = z.infer<typeof StructuredTodaySynthesisEnvelopeSchema>;
export type StructuredTodayGatheredDossierEvidence = z.infer<typeof StructuredTodayGatheredDossierEvidenceSchema>;
export type StructuredTodayComposeEnvelope = z.infer<typeof StructuredTodayComposeEnvelopeSchema>;

export function buildStructuredTodayIndex(
  initial: StructuredTodayIndexWorkflowInput,
  envelope: StructuredTodaySynthesisEnvelope,
  runtimeRunId: string
): StructuredTodayIndexWorkflowOutput {
  const worklines = envelope.synthesis.worklines.map(toWorkline);
  const worklineIds = new Set(worklines.map((item) => item.worklineId));
  const dispositions = buildDispositions(
    initial,
    envelope.digestResults,
    envelope.synthesis,
    worklineIds
  );
  const coverage = coverageFrom(dispositions, initial.sessions.length);
  const invocations = [
    ...envelope.digestResults.flatMap((item) => item.status === "success" ? [item.invocation] : []),
    ...(envelope.invocation ? [envelope.invocation] : [])
  ];
  const artifactWithoutHash = {
    schema: STRUCTURED_TODAY_INDEX_SCHEMA,
    artifactId: initial.artifactId,
    revision: initial.revision,
    logicalDate: initial.logicalDate,
    workflowRunId: initial.workflowRunId || runtimeRunId,
    evidenceManifestId: initial.evidenceManifestId,
    sessions: initial.sessions.map((item) => item.session),
    evidence: initial.evidence,
    dispositions,
    worklines,
    coverage,
    provenance: provenance(initial.editorialContract.ref, invocations)
  };
  let artifact = TodayWorklineIndexSchema.parse({
    ...artifactWithoutHash,
    contentHash: canonicalContentHash(artifactWithoutHash)
  });
  const issues = validateStructuredTodayIndex(artifact);
  if (issues.length > 0 && artifact.coverage.complete) {
    const invalidated = { ...artifactWithoutHash, coverage: { ...coverage, complete: false } };
    artifact = TodayWorklineIndexSchema.parse({
      ...invalidated,
      contentHash: canonicalContentHash(invalidated)
    });
  }
  return StructuredTodayIndexWorkflowOutputSchema.parse({
    artifact,
    publishable: issues.length === 0 && artifact.coverage.complete,
    issues
  });
}

export function validateStructuredTodayIndex(index: TodayWorklineIndexV1): string[] {
  const issues: string[] = [];
  const sessionIds = new Set(index.sessions.map((item) => item.sessionId));
  const evidenceIds = new Set(index.evidence.map((item) => item.evidenceId));
  const worklines = new Map(index.worklines.map((item) => [item.worklineId, item]));
  const dispositionCounts = new Map<string, number>();

  for (const disposition of index.dispositions) {
    dispositionCounts.set(disposition.sessionId, (dispositionCounts.get(disposition.sessionId) ?? 0) + 1);
    if (!sessionIds.has(disposition.sessionId)) issues.push(`Disposition references unknown Session ${disposition.sessionId}.`);
    if (disposition.kind === "assigned") {
      for (const worklineId of disposition.worklineIds) {
        const workline = worklines.get(worklineId);
        if (!workline) issues.push(`Session ${disposition.sessionId} references unknown workline ${worklineId}.`);
        else if (!workline.sessionIds.includes(disposition.sessionId)) {
          issues.push(`Workline ${worklineId} does not include assigned Session ${disposition.sessionId}.`);
        }
      }
    }
  }
  for (const sessionId of sessionIds) {
    if (dispositionCounts.get(sessionId) !== 1) issues.push(`Session ${sessionId} does not have exactly one disposition.`);
  }
  for (const workline of index.worklines) {
    for (const sessionId of workline.sessionIds) {
      if (!sessionIds.has(sessionId)) issues.push(`Workline ${workline.worklineId} invented Session ${sessionId}.`);
      const disposition = index.dispositions.find((item) => item.sessionId === sessionId);
      if (disposition?.kind !== "assigned" || !disposition.worklineIds.includes(workline.worklineId)) {
        issues.push(`Workline ${workline.worklineId} lacks reciprocal assignment for Session ${sessionId}.`);
      }
    }
    for (const evidenceId of workline.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) issues.push(`Workline ${workline.worklineId} invented evidence ${evidenceId}.`);
    }
  }
  const assigned = index.dispositions.filter((item) => item.kind === "assigned").length;
  if (assigned > 0 && index.worklines.length === 0) issues.push("Supported Session evidence produced no workline.");
  const expectedCounts = coverageFrom(index.dispositions, index.sessions.length);
  for (const key of ["admitted", "assigned", "excluded", "failed", "unresolved"] as const) {
    if (index.coverage[key] !== expectedCounts[key]) issues.push(`Coverage count ${key} is inconsistent.`);
  }
  const { contentHash: _contentHash, ...hashable } = index;
  if (canonicalContentHash(hashable) !== index.contentHash) issues.push("Index content hash is invalid.");
  return unique(issues);
}

export function buildStructuredTodayDossier(
  initial: StructuredTodayDossierWorkflowInput,
  gathered: StructuredTodayGatheredDossierEvidence,
  envelope: StructuredTodayComposeEnvelope,
  runtimeRunId: string
): StructuredTodayDossierWorkflowOutput {
  const invocations = [
    envelope.analysisInvocation,
    envelope.critiqueInvocation,
    envelope.composeInvocation
  ];
  const content = {
    ...envelope.dossier,
    possibleChangeAdopted: false as const,
    extensions: envelope.dossier.extensions.map((value) => ({ kind: "model-note", value }))
  };
  const artifactWithoutHash = {
    schema: STRUCTURED_TODAY_DOSSIER_SCHEMA,
    artifactId: initial.artifactId,
    revision: initial.revision,
    logicalDate: initial.sourceIndex.logicalDate,
    workflowRunId: initial.workflowRunId || runtimeRunId,
    sourceIndex: {
      artifactId: initial.sourceIndex.artifactId,
      revision: initial.sourceIndex.revision,
      contentHash: initial.sourceIndex.contentHash
    },
    worklineId: initial.worklineId,
    admittedSessionIds: gathered.admittedSessionIds,
    evidence: gathered.evidence,
    content,
    validation: {
      schema: "passed" as const,
      evidence: "passed" as const,
      semantic: "passed" as const,
      critiqueIssues: envelope.critique.issues
    },
    provenance: provenance(initial.editorialContract.ref, invocations)
  };
  const artifact = TodayWorklineDossierSchema.parse({
    ...artifactWithoutHash,
    contentHash: canonicalContentHash(artifactWithoutHash)
  });
  const issues = validateStructuredTodayDossier(artifact);
  if (issues.length > 0) throw new Error(`Structured dossier validation failed: ${issues.join(" ")}`);
  return StructuredTodayDossierWorkflowOutputSchema.parse({ artifact, publishable: true, issues: [] });
}

export function validateStructuredTodayDossier(
  dossier: z.infer<typeof TodayWorklineDossierSchema>
): string[] {
  const issues: string[] = [];
  const evidenceIds = new Set(dossier.evidence.map((item) => item.evidenceId));
  if (dossier.content.humanQuestion.trim().length === 0) issues.push("Dossier human question is empty.");
  for (const group of [dossier.content.supportingEvidence, dossier.content.opposingEvidence]) {
    for (const claim of group) {
      for (const evidenceId of claim.evidenceIds) {
        if (!evidenceIds.has(evidenceId)) issues.push(`Dossier claim invented evidence ${evidenceId}.`);
      }
    }
  }
  for (const evidenceId of dossier.content.evidenceIds) {
    if (!evidenceIds.has(evidenceId)) issues.push(`Dossier summary invented evidence ${evidenceId}.`);
  }
  const admitted = new Set(dossier.admittedSessionIds);
  for (const evidence of dossier.evidence) {
    if (evidence.sessionId && !admitted.has(evidence.sessionId)) {
      issues.push(`Dossier admitted evidence from unselected Session ${evidence.sessionId}.`);
    }
  }
  const { contentHash: _contentHash, ...hashable } = dossier;
  if (canonicalContentHash(hashable) !== dossier.contentHash) issues.push("Dossier content hash is invalid.");
  return unique(issues);
}

export function buildStructuredTodayProposalArtifact(input: {
  artifactId: string;
  revision: number;
  logicalDate: string;
  worklineId: string;
  dossier: z.infer<typeof TodayWorklineDossierSchema>;
  reflection: StructuredTodayReflectionV1;
  candidate: StructuredTodayProposalSetCandidate;
  invocation: StructuredTodayModelInvocationV1;
}): StructuredTodayProposalArtifactV1 {
  const categories = new Set(input.candidate.proposals.map((proposal) => proposal.category));
  for (const category of STRUCTURED_TODAY_PROPOSAL_CATEGORIES) {
    if (!categories.has(category)) throw new Error(`Structured proposals omitted category ${category}.`);
  }
  const allowedEvidence = new Set(input.dossier.evidence.map((evidence) => evidence.evidenceId));
  const proposals = input.candidate.proposals.map((proposal, index) => {
    if (!input.reflection.text.includes(proposal.sourceQuote)) {
      throw new Error("Structured proposal sourceQuote does not resolve to the saved reflection.");
    }
    const invented = proposal.evidenceIds.find((evidenceId) => !allowedEvidence.has(evidenceId));
    if (invented) throw new Error(`Structured proposal invented evidence ${invented}.`);
    return {
      ...proposal,
      proposalId: `structured-proposal-${sha256Text(JSON.stringify({
        reflection: input.reflection.contentHash,
        category: proposal.category,
        proposalText: proposal.proposalText,
        sourceQuote: proposal.sourceQuote,
        index
      })).slice(0, 24)}`
    };
  });
  const withoutHash = {
    schema: "today-workline-proposals/v1" as const,
    artifactId: input.artifactId,
    revision: input.revision,
    logicalDate: input.logicalDate,
    worklineId: input.worklineId,
    sourceDossier: {
      artifactId: input.dossier.artifactId,
      revision: input.dossier.revision,
      contentHash: input.dossier.contentHash
    },
    sourceReflection: {
      reflectionId: input.reflection.reflectionId,
      revision: input.reflection.revision,
      contentHash: input.reflection.contentHash
    },
    proposals,
    provenance: provenance(input.dossier.provenance.editorialContract, [input.invocation])
  };
  return StructuredTodayProposalArtifactSchema.parse({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash)
  });
}

export function validateStructuredTodayProposalArtifact(
  artifact: StructuredTodayProposalArtifactV1,
  reflection?: StructuredTodayReflectionV1
): string[] {
  const issues: string[] = [];
  const categories = new Set(artifact.proposals.map((proposal) => proposal.category));
  for (const category of STRUCTURED_TODAY_PROPOSAL_CATEGORIES) {
    if (!categories.has(category)) issues.push(`Proposal category ${category} is missing.`);
  }
  if (new Set(artifact.proposals.map((proposal) => proposal.proposalId)).size !== artifact.proposals.length) {
    issues.push("Proposal IDs are not unique.");
  }
  if (reflection) {
    for (const proposal of artifact.proposals) {
      if (!reflection.text.includes(proposal.sourceQuote)) {
        issues.push(`Proposal ${proposal.proposalId} sourceQuote does not resolve.`);
      }
    }
  }
  const { contentHash: _contentHash, ...hashable } = artifact;
  if (canonicalContentHash(hashable) !== artifact.contentHash) issues.push("Proposal artifact content hash is invalid.");
  return unique(issues);
}

function buildDispositions(
  initial: StructuredTodayIndexWorkflowInput,
  digests: DigestExecutionResultV1[],
  synthesis: WorklineSynthesisCandidate,
  worklineIds: Set<string>
): SessionDispositionV1[] {
  const digestBySession = new Map<string, DigestExecutionResultV1>();
  for (const digest of digests) {
    const sessionId = digest.status === "success" ? digest.digest.sessionId : digest.sessionId;
    if (!digestBySession.has(sessionId)) digestBySession.set(sessionId, digest);
  }
  const assignments = new Map<string, string[]>();
  for (const assignment of synthesis.assignments) {
    const valid = assignment.worklineIds.filter((id) => worklineIds.has(id));
    if (!assignments.has(assignment.sessionId)) assignments.set(assignment.sessionId, valid);
  }
  const unresolved = new Set(synthesis.unresolvedSessionIds);

  return initial.sessions.map((item): SessionDispositionV1 => {
    const digest = digestBySession.get(item.session.sessionId);
    if (!digest) {
      return {
        sessionId: item.session.sessionId,
        kind: "unresolved",
        worklineIds: [],
        reason: "Session digest produced no terminal result."
      };
    }
    if (digest.status === "excluded") {
      return { sessionId: digest.sessionId, kind: "excluded", worklineIds: [], reason: digest.reason };
    }
    if (digest.status === "failed") {
      return {
        sessionId: digest.sessionId,
        kind: "failed",
        worklineIds: [],
        reason: digest.reason,
        ...(digest.nodeOutputId ? { nodeOutputId: digest.nodeOutputId } : {})
      };
    }
    const assigned = assignments.get(digest.digest.sessionId) ?? [];
    if (assigned.length > 0) {
      return {
        sessionId: digest.digest.sessionId,
        kind: "assigned",
        worklineIds: assigned,
        nodeOutputId: digest.nodeOutputId
      };
    }
    return {
      sessionId: digest.digest.sessionId,
      kind: "unresolved",
      worklineIds: [],
      reason: unresolved.has(digest.digest.sessionId)
        ? "Workline synthesis explicitly left this Session unresolved."
        : "Workline synthesis omitted this successful Session."
    };
  });
}

function toWorkline(candidate: WorklineSynthesisCandidate["worklines"][number]): TodayWorklineV1 {
  return {
    worklineId: candidate.worklineId,
    title: candidate.title,
    summary: candidate.summary,
    startedAt: candidate.startedAt,
    ...(candidate.endedAt ? { endedAt: candidate.endedAt } : {}),
    currentStop: candidate.currentStop,
    possibleChange: candidate.possibleChange,
    possibleChangeAdopted: false,
    participation: participationAccount(candidate.participation),
    evidenceReadiness: candidate.evidenceReadiness,
    sessionIds: candidate.sessionIds,
    evidenceIds: candidate.evidenceIds,
    extensions: candidate.extensions.map((value) => ({ kind: "model-note", value }))
  };
}

function coverageFrom(dispositions: SessionDispositionV1[], admitted: number) {
  const count = (kind: SessionDispositionV1["kind"]) => dispositions.filter((item) => item.kind === kind).length;
  const failed = count("failed");
  const unresolved = count("unresolved");
  return {
    admitted,
    assigned: count("assigned"),
    excluded: count("excluded"),
    failed,
    unresolved,
    complete: failed === 0 && unresolved === 0
  };
}

function provenance(
  editorialContract: StructuredTodayIndexWorkflowInput["editorialContract"]["ref"],
  invocations: StructuredTodayModelInvocationV1[]
) {
  return {
    workflowVersion: STRUCTURED_TODAY_WORKFLOW_VERSION,
    editorialContract,
    modelFunctionVersions: Object.fromEntries(
      invocations.map((item) => [item.functionName, item.functionVersion])
    ),
    providerInvocations: invocations
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
