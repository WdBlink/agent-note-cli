import { createHash } from "node:crypto";
import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);
const LogicalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Timestamp = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Provider = z.enum(["codex", "claude", "copilot", "cursor"]);

export const STRUCTURED_TODAY_INDEX_SCHEMA = "today-workline-index/v1" as const;
export const STRUCTURED_TODAY_DOSSIER_SCHEMA = "today-workline-dossier/v1" as const;
export const STRUCTURED_TODAY_WORKFLOW_VERSION = "structured-today-workflow-v9-copilot-authority" as const;

export const TodaySessionLineageSchema = z.object({
  origin: z.enum(["primary", "subagent", "automation", "unknown"]),
  parentSessionId: NonEmptyString.optional(),
  agentPath: NonEmptyString.optional(),
  agentNickname: NonEmptyString.optional(),
  agentRole: NonEmptyString.optional()
}).strict();

export const TraceinkEditorialContractRefSchema = z.object({
  packageId: z.literal("traceink"),
  version: NonEmptyString,
  editorialContractHash: Sha256
}).strict();

export const EditorialContractBindingSchema = z.object({
  ref: TraceinkEditorialContractRefSchema,
  text: z.string().min(1)
}).strict().superRefine((value, context) => {
  if (sha256Text(value.text) !== value.ref.editorialContractHash) {
    context.addIssue({
      code: "custom",
      message: "Editorial contract bytes do not match editorialContractHash.",
      path: ["ref", "editorialContractHash"]
    });
  }
});

export const EvidenceLocatorSchema = z.object({
  evidenceId: NonEmptyString,
  sourceKind: z.enum(["session", "linked-material"]),
  provider: Provider.optional(),
  sessionId: NonEmptyString.optional(),
  sourcePath: NonEmptyString,
  range: NonEmptyString.optional(),
  contentHash: Sha256
}).strict();

export const TodaySessionRefSchema = z.object({
  sessionId: NonEmptyString,
  provider: Provider,
  sourcePath: NonEmptyString,
  title: NonEmptyString,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  evidenceIds: z.array(NonEmptyString).min(1),
  lineage: TodaySessionLineageSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", message: "endedAt precedes startedAt.", path: ["endedAt"] });
  }
  addDuplicateIssues(value.evidenceIds, context, ["evidenceIds"]);
});

export const ParticipationCandidateSchema = z.object({
  human: NonEmptyString.nullish(),
  agent: NonEmptyString.nullish(),
  joint: NonEmptyString.nullish(),
  undeterminedReason: NonEmptyString.nullish()
}).strict();

const DescribedParticipationSchema = z.object({
  status: z.literal("described"),
  human: NonEmptyString.optional(),
  agent: NonEmptyString.optional(),
  joint: NonEmptyString.optional()
}).strict().superRefine((value, context) => {
  if (!value.human && !value.agent && !value.joint) {
    context.addIssue({ code: "custom", message: "Described participation needs at least one account." });
  }
});

const UndeterminedParticipationSchema = z.object({
  status: z.literal("undetermined"),
  reason: NonEmptyString
}).strict();

export const ParticipationAccountSchema = z.discriminatedUnion("status", [
  DescribedParticipationSchema,
  UndeterminedParticipationSchema
]);

const AssignedDispositionSchema = z.object({
  sessionId: NonEmptyString,
  kind: z.literal("assigned"),
  worklineIds: z.array(NonEmptyString).min(1),
  nodeOutputId: NonEmptyString
}).strict();

const NonAssignedDispositionSchema = z.object({
  sessionId: NonEmptyString,
  kind: z.enum(["excluded", "failed", "unresolved"]),
  worklineIds: z.tuple([]),
  reason: NonEmptyString,
  nodeOutputId: NonEmptyString.optional()
}).strict();

export const SessionDispositionSchema = z.discriminatedUnion("kind", [
  AssignedDispositionSchema,
  NonAssignedDispositionSchema
]);

export const TodayWorklineSchema = z.object({
  worklineId: NonEmptyString,
  title: NonEmptyString,
  summary: NonEmptyString,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  currentStop: NonEmptyString,
  possibleChange: NonEmptyString,
  possibleChangeAdopted: z.literal(false),
  participation: ParticipationAccountSchema,
  evidenceReadiness: z.enum(["ready", "partial", "blocked"]),
  sessionIds: z.array(NonEmptyString).min(1),
  evidenceIds: z.array(NonEmptyString).min(1),
  extensions: z.array(z.object({ kind: NonEmptyString, value: z.unknown() }).strict())
}).strict().superRefine((value, context) => {
  if (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", message: "endedAt precedes startedAt.", path: ["endedAt"] });
  }
  addDuplicateIssues(value.sessionIds, context, ["sessionIds"]);
  addDuplicateIssues(value.evidenceIds, context, ["evidenceIds"]);
});

export const StructuredTodayModelInvocationSchema = z.object({
  invocationId: NonEmptyString,
  provider: NonEmptyString,
  model: NonEmptyString,
  functionName: z.enum([
    "DigestSession",
    "SynthesizeWorklineIndex",
    "AnalyzeWorklineDossier",
    "CritiqueWorklineDossier",
    "ComposeWorklineDossier",
    "ArrangeReflectionProposals"
  ]),
  functionVersion: NonEmptyString
}).strict();

export const StructuredTodayProvenanceSchema = z.object({
  workflowVersion: NonEmptyString,
  editorialContract: TraceinkEditorialContractRefSchema,
  modelFunctionVersions: z.record(NonEmptyString, NonEmptyString),
  providerInvocations: z.array(StructuredTodayModelInvocationSchema)
}).strict();

export const TodayWorklineIndexSchema = z.object({
  schema: z.literal(STRUCTURED_TODAY_INDEX_SCHEMA),
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  workflowRunId: NonEmptyString,
  evidenceManifestId: NonEmptyString,
  sessions: z.array(TodaySessionRefSchema).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1),
  dispositions: z.array(SessionDispositionSchema).min(1),
  worklines: z.array(TodayWorklineSchema),
  coverage: z.object({
    admitted: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    complete: z.boolean()
  }).strict(),
  provenance: StructuredTodayProvenanceSchema,
  contentHash: Sha256,
  rawModelText: z.string().optional()
}).strict();

export const SessionDigestCandidateSchema = z.object({
  sessionId: NonEmptyString,
  summary: NonEmptyString,
  currentStop: NonEmptyString,
  participation: ParticipationCandidateSchema,
  evidenceIds: z.array(NonEmptyString).min(1),
  uncertainties: z.array(NonEmptyString)
}).strict();

export const ModelSessionAssignmentSchema = z.object({
  sessionId: NonEmptyString,
  worklineIds: z.array(NonEmptyString).min(1),
  reason: NonEmptyString.nullish()
}).strict();

export const WorklineCandidateSchema = z.object({
  worklineId: NonEmptyString,
  title: NonEmptyString,
  summary: NonEmptyString,
  startedAt: Timestamp,
  endedAt: Timestamp.nullish(),
  currentStop: NonEmptyString,
  possibleChange: NonEmptyString,
  participation: ParticipationCandidateSchema,
  evidenceReadiness: z.enum(["ready", "partial", "blocked"]),
  sessionIds: z.array(NonEmptyString).min(1),
  evidenceIds: z.array(NonEmptyString).min(1),
  extensions: z.array(NonEmptyString)
}).strict();

export const WorklineSynthesisCandidateSchema = z.object({
  worklines: z.array(WorklineCandidateSchema),
  assignments: z.array(ModelSessionAssignmentSchema),
  unresolvedSessionIds: z.array(NonEmptyString)
}).strict();

export const DigestWorkItemSchema = z.object({
  logicalDate: LogicalDate,
  editorialContract: EditorialContractBindingSchema,
  session: TodaySessionRefSchema,
  evidence: z.array(EvidenceLocatorSchema).min(1),
  evidenceText: NonEmptyString,
  preDisposition: z.object({
    kind: z.enum(["excluded", "failed"]),
    reason: NonEmptyString
  }).strict().optional()
}).strict();

export const DigestExecutionResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    nodeOutputId: NonEmptyString,
    digest: SessionDigestCandidateSchema,
    invocation: StructuredTodayModelInvocationSchema
  }).strict(),
  z.object({
    status: z.literal("excluded"),
    sessionId: NonEmptyString,
    reason: NonEmptyString
  }).strict(),
  z.object({
    status: z.literal("failed"),
    sessionId: NonEmptyString,
    reason: NonEmptyString,
    nodeOutputId: NonEmptyString.optional()
  }).strict()
]);

export const StructuredTodayIndexWorkflowInputSchema = z.object({
  logicalDate: LogicalDate,
  workflowRunId: NonEmptyString,
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  evidenceManifestId: NonEmptyString,
  editorialContract: EditorialContractBindingSchema,
  sessions: z.array(DigestWorkItemSchema).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1),
  pauseBeforeSynthesis: z.boolean().optional()
}).strict();

export const StructuredTodayIndexWorkflowOutputSchema = z.object({
  artifact: TodayWorklineIndexSchema,
  publishable: z.boolean(),
  issues: z.array(NonEmptyString)
}).strict();

export const EvidenceClaimCandidateSchema = z.object({
  claim: NonEmptyString,
  evidenceIds: z.array(NonEmptyString).min(1)
}).strict();

export const DossierAnalysisCandidateSchema = z.object({
  priorContext: NonEmptyString,
  whatHappened: NonEmptyString,
  possibleChange: NonEmptyString,
  supportingEvidence: z.array(EvidenceClaimCandidateSchema),
  opposingEvidence: z.array(EvidenceClaimCandidateSchema),
  falsifiableObservation: NonEmptyString,
  gaps: z.array(NonEmptyString)
}).strict();

export const DossierCritiqueCandidateSchema = z.object({
  acceptable: z.boolean(),
  issues: z.array(NonEmptyString),
  missingEvidenceIds: z.array(NonEmptyString)
}).strict();

export const DossierCandidateSchema = DossierAnalysisCandidateSchema.extend({
  title: NonEmptyString,
  humanQuestion: NonEmptyString,
  evidenceIds: z.array(NonEmptyString).min(1),
  extensions: z.array(NonEmptyString)
}).strict();

export const TodayWorklineDossierSchema = z.object({
  schema: z.literal(STRUCTURED_TODAY_DOSSIER_SCHEMA),
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  workflowRunId: NonEmptyString,
  sourceIndex: z.object({
    artifactId: NonEmptyString,
    revision: z.number().int().positive(),
    contentHash: Sha256
  }).strict(),
  worklineId: NonEmptyString,
  admittedSessionIds: z.array(NonEmptyString).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1),
  content: DossierCandidateSchema.extend({
    possibleChangeAdopted: z.literal(false),
    extensions: z.array(z.object({ kind: NonEmptyString, value: z.unknown() }).strict())
  }).strict(),
  validation: z.object({
    schema: z.literal("passed"),
    evidence: z.literal("passed"),
    semantic: z.literal("passed"),
    critiqueIssues: z.array(NonEmptyString)
  }).strict(),
  provenance: StructuredTodayProvenanceSchema,
  contentHash: Sha256,
  rawModelText: z.string().optional()
}).strict();

export const StructuredTodayDossierWorkflowInputSchema = z.object({
  workflowRunId: NonEmptyString,
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  editorialContract: EditorialContractBindingSchema,
  sourceIndex: TodayWorklineIndexSchema,
  worklineId: NonEmptyString,
  linkedEvidence: z.array(EvidenceLocatorSchema),
  evidenceText: NonEmptyString
}).strict();

export const StructuredTodayDossierWorkflowOutputSchema = z.object({
  artifact: TodayWorklineDossierSchema,
  publishable: z.literal(true),
  issues: z.array(NonEmptyString)
}).strict();

export const StructuredTodayDossierReferenceSchema = z.object({
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  contentHash: Sha256
}).strict();

export const StructuredTodayReflectionReferenceSchema = z.object({
  reflectionId: NonEmptyString,
  revision: z.number().int().positive(),
  contentHash: Sha256
}).strict();

export const StructuredTodayReflectionSchema = z.object({
  schema: z.literal("today-workline-reflection/v1"),
  reflectionId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  worklineId: NonEmptyString,
  sourceDossier: StructuredTodayDossierReferenceSchema,
  text: z.string().min(1),
  createdAt: Timestamp,
  savedAt: Timestamp,
  contentHash: Sha256
}).strict().superRefine((value, context) => {
  if (sha256Text(value.text) !== value.contentHash) {
    context.addIssue({ code: "custom", message: "Reflection content hash is invalid.", path: ["contentHash"] });
  }
  if (Date.parse(value.savedAt) < Date.parse(value.createdAt)) {
    context.addIssue({ code: "custom", message: "Reflection savedAt precedes createdAt.", path: ["savedAt"] });
  }
});

export const STRUCTURED_TODAY_PROPOSAL_CATEGORIES = [
  "judgment",
  "tomorrow",
  "ctx",
  "background",
  "today-only"
] as const;

export const StructuredTodayProposalCategorySchema = z.enum(STRUCTURED_TODAY_PROPOSAL_CATEGORIES);

export const StructuredTodayProposalCandidateSchema = z.object({
  category: StructuredTodayProposalCategorySchema,
  proposalText: NonEmptyString,
  sourceQuote: z.string().min(1),
  evidenceIds: z.array(NonEmptyString)
}).strict();

export const StructuredTodayProposalSetCandidateSchema = z.object({
  proposals: z.array(StructuredTodayProposalCandidateSchema).min(5).max(40)
}).strict();

export const StructuredTodayProposalItemSchema = StructuredTodayProposalCandidateSchema.extend({
  proposalId: NonEmptyString
}).strict();

export const StructuredTodayProposalArtifactSchema = z.object({
  schema: z.literal("today-workline-proposals/v1"),
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  worklineId: NonEmptyString,
  sourceDossier: StructuredTodayDossierReferenceSchema,
  sourceReflection: StructuredTodayReflectionReferenceSchema,
  proposals: z.array(StructuredTodayProposalItemSchema).min(5).max(40),
  provenance: StructuredTodayProvenanceSchema,
  contentHash: Sha256
}).strict();

export const StructuredTodayProposalWorkflowInputSchema = z.object({
  workflowRunId: NonEmptyString,
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  editorialContract: EditorialContractBindingSchema,
  dossier: TodayWorklineDossierSchema,
  reflection: StructuredTodayReflectionSchema
}).strict();

export const StructuredTodayProposalWorkflowOutputSchema = z.object({
  artifact: StructuredTodayProposalArtifactSchema
}).strict();

export const StructuredTodayProposalDispositionSchema = z.object({
  schema: z.literal("today-proposal-disposition/v1"),
  dispositionId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  worklineId: NonEmptyString,
  proposalArtifact: z.object({
    artifactId: NonEmptyString,
    revision: z.number().int().positive(),
    contentHash: Sha256
  }).strict(),
  proposalId: NonEmptyString,
  category: StructuredTodayProposalCategorySchema,
  action: z.enum(["accept", "dismiss", "defer", "rewrite"]),
  rewriteText: NonEmptyString.optional(),
  decidedAt: Timestamp
}).strict().superRefine((value, context) => {
  if (value.action === "rewrite" && !value.rewriteText) {
    context.addIssue({ code: "custom", message: "Rewrite disposition needs rewriteText.", path: ["rewriteText"] });
  }
  if (value.action !== "rewrite" && value.rewriteText) {
    context.addIssue({ code: "custom", message: "Only rewrite may carry rewriteText.", path: ["rewriteText"] });
  }
});

export type TraceinkEditorialContractRefV1 = z.infer<typeof TraceinkEditorialContractRefSchema>;
export type EditorialContractBindingV1 = z.infer<typeof EditorialContractBindingSchema>;
export type EvidenceLocatorV1 = z.infer<typeof EvidenceLocatorSchema>;
export type TodaySessionRefV1 = z.infer<typeof TodaySessionRefSchema>;
export type ParticipationCandidate = z.infer<typeof ParticipationCandidateSchema>;
export type ParticipationAccountV1 = z.infer<typeof ParticipationAccountSchema>;
export type SessionDispositionV1 = z.infer<typeof SessionDispositionSchema>;
export type TodayWorklineV1 = z.infer<typeof TodayWorklineSchema>;
export type TodayWorklineIndexV1 = z.infer<typeof TodayWorklineIndexSchema>;
export type SessionDigestCandidate = z.infer<typeof SessionDigestCandidateSchema>;
export type StructuredTodayModelInvocationV1 = z.infer<typeof StructuredTodayModelInvocationSchema>;
export type WorklineSynthesisCandidate = z.infer<typeof WorklineSynthesisCandidateSchema>;
export type DigestWorkItemV1 = z.infer<typeof DigestWorkItemSchema>;
export type DigestExecutionResultV1 = z.infer<typeof DigestExecutionResultSchema>;
export type StructuredTodayIndexWorkflowInput = z.infer<typeof StructuredTodayIndexWorkflowInputSchema>;
export type StructuredTodayIndexWorkflowOutput = z.infer<typeof StructuredTodayIndexWorkflowOutputSchema>;
export type DossierAnalysisCandidate = z.infer<typeof DossierAnalysisCandidateSchema>;
export type DossierCritiqueCandidate = z.infer<typeof DossierCritiqueCandidateSchema>;
export type DossierCandidate = z.infer<typeof DossierCandidateSchema>;
export type TodayWorklineDossierV1 = z.infer<typeof TodayWorklineDossierSchema>;
export type StructuredTodayDossierWorkflowInput = z.infer<typeof StructuredTodayDossierWorkflowInputSchema>;
export type StructuredTodayDossierWorkflowOutput = z.infer<typeof StructuredTodayDossierWorkflowOutputSchema>;
export type StructuredTodayDossierReferenceV1 = z.infer<typeof StructuredTodayDossierReferenceSchema>;
export type StructuredTodayReflectionReferenceV1 = z.infer<typeof StructuredTodayReflectionReferenceSchema>;
export type StructuredTodayReflectionV1 = z.infer<typeof StructuredTodayReflectionSchema>;
export type StructuredTodayProposalCategoryV1 = z.infer<typeof StructuredTodayProposalCategorySchema>;
export type StructuredTodayProposalCandidate = z.infer<typeof StructuredTodayProposalCandidateSchema>;
export type StructuredTodayProposalSetCandidate = z.infer<typeof StructuredTodayProposalSetCandidateSchema>;
export type StructuredTodayProposalItemV1 = z.infer<typeof StructuredTodayProposalItemSchema>;
export type StructuredTodayProposalArtifactV1 = z.infer<typeof StructuredTodayProposalArtifactSchema>;
export type StructuredTodayProposalWorkflowInput = z.infer<typeof StructuredTodayProposalWorkflowInputSchema>;
export type StructuredTodayProposalWorkflowOutput = z.infer<typeof StructuredTodayProposalWorkflowOutputSchema>;
export type StructuredTodayProposalDispositionV1 = z.infer<typeof StructuredTodayProposalDispositionSchema>;

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalContentHash(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

export function participationAccount(candidate: ParticipationCandidate): ParticipationAccountV1 {
  const human = optionalText(candidate.human);
  const agent = optionalText(candidate.agent);
  const joint = optionalText(candidate.joint);
  if (human || agent || joint) {
    return ParticipationAccountSchema.parse({
      status: "described",
      ...(human ? { human } : {}),
      ...(agent ? { agent } : {}),
      ...(joint ? { joint } : {})
    });
  }
  return ParticipationAccountSchema.parse({
    status: "undetermined",
    reason: optionalText(candidate.undeterminedReason) ?? "模型未能从已采纳证据中确定参与方式。"
  });
}

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function addDuplicateIssues(
  values: string[],
  context: z.RefinementCtx,
  path: Array<string | number>
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", message: `Duplicate value: ${value}`, path: [...path, index] });
    }
    seen.add(value);
  });
}
