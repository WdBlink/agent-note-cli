import { z } from "zod";
import {
  EditorialContractBindingSchema,
  EvidenceLocatorSchema,
  TodaySessionRefSchema,
  sha256Text
} from "./structured-today-contracts";
import {
  AtomicFindingSchema,
  EvidenceMessageLocatorSchema,
  EvidenceSpanSchema,
  StructuredTodayProvenanceSessionSchema
} from "./structured-today-evidence-spans";
import { EvidenceClaimKindSchema } from "./structured-today-evidence-spans";

export const STRUCTURED_TODAY_V2_WORKFLOW_VERSION = "structured-today-workflow-v5-message-spans" as const;
export const STRUCTURED_TODAY_INDEX_INPUT_V2_SCHEMA = "structured-today-index-input/v2" as const;

const NonEmptyString = z.string().trim().min(1);
const LogicalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const MessageKey = z.string().regex(/^msg-v2-[a-f0-9]{64}$/u);

export const StructuredTodayV2SessionInputSchema = z.object({
  logicalDate: LogicalDate,
  editorialContract: EditorialContractBindingSchema,
  session: TodaySessionRefSchema,
  evidence: z.array(EvidenceLocatorSchema).min(1),
  provenanceSession: StructuredTodayProvenanceSessionSchema.optional(),
  preDisposition: z.object({
    kind: z.enum(["excluded", "failed"]),
    reason: NonEmptyString
  }).strict().optional()
}).strict().superRefine((value, context) => {
  const provenance = value.provenanceSession;
  if (!provenance) {
    if (!value.preDisposition) {
      context.addIssue({ code: "custom", message: "An admitted Session requires provenance messages.", path: ["provenanceSession"] });
    }
    return;
  }
  if (provenance.admittedMessages.length === 0 && value.preDisposition?.kind !== "failed") {
    context.addIssue({ code: "custom", message: "A provenance Session with zero admitted messages must be failed.", path: ["preDisposition"] });
  }
  if (provenance.admittedMessages.length > 0 && value.preDisposition) {
    context.addIssue({ code: "custom", message: "A Session with admitted provenance messages cannot be pre-disposed.", path: ["preDisposition"] });
  }
  if (provenance.sessionId !== value.session.sessionId || provenance.provider !== value.session.provider ||
    !value.session.evidenceIds.includes(provenance.evidenceId)) {
    context.addIssue({ code: "custom", message: "Provenance Session tuple does not match session metadata.", path: ["provenanceSession"] });
  }
  const evidenceMatches = value.evidence.filter((item) => item.evidenceId === provenance.evidenceId);
  const evidence = evidenceMatches[0];
  if (evidenceMatches.length !== 1 || !evidence || evidence.sourceKind !== "session" ||
    evidence.provider !== provenance.provider || evidence.sessionId !== provenance.sessionId ||
    evidence.sourcePath !== value.session.sourcePath ||
    evidence.range !== `bytes 0-${provenance.frozenSourcePrefix.byteLength}` ||
    evidence.contentHash !== provenance.frozenSourcePrefix.contentHash) {
    context.addIssue({ code: "custom", message: "Provenance Session does not resolve to one exact evidence locator.", path: ["provenanceSession", "evidenceId"] });
  }
});

export const StructuredTodayIndexWorkflowInputV2Schema = z.object({
  schema: z.literal(STRUCTURED_TODAY_INDEX_INPUT_V2_SCHEMA),
  workflowVersion: z.literal(STRUCTURED_TODAY_V2_WORKFLOW_VERSION),
  logicalDate: LogicalDate,
  workflowRunId: NonEmptyString,
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  evidenceManifestId: NonEmptyString,
  editorialContract: EditorialContractBindingSchema,
  parserVersion: NonEmptyString,
  admissionPolicyVersion: NonEmptyString,
  admittedCorpusHash: Sha256,
  sessions: z.array(StructuredTodayV2SessionInputSchema).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1),
  pauseBeforeSynthesis: z.boolean().optional()
}).strict().superRefine((value, context) => {
  const expectedEvidence = value.sessions.flatMap((item) => item.evidence);
  if (JSON.stringify(expectedEvidence) !== JSON.stringify(value.evidence)) {
    context.addIssue({ code: "custom", message: "Top-level evidence must equal the ordered per-Session evidence set.", path: ["evidence"] });
  }
  if (value.sessions.some((item) => item.logicalDate !== value.logicalDate)) {
    context.addIssue({ code: "custom", message: "Every Session input must use the workflow logical date.", path: ["sessions"] });
  }
  const sessionIds = value.sessions.map((item) => item.session.sessionId);
  const evidenceIds = value.evidence.map((item) => item.evidenceId);
  if (new Set(sessionIds).size !== sessionIds.length || new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({ code: "custom", message: "Session and evidence identities must be unique across one workflow input." });
  }
  const provenanceSessions = value.sessions.flatMap((item) => item.provenanceSession ? [item.provenanceSession] : []);
  if (provenanceSessions.some((session) => session.parserVersion !== value.parserVersion ||
    session.admissionPolicyVersion !== value.admissionPolicyVersion)) {
    context.addIssue({ code: "custom", message: "Parser and admission versions must be frozen across one workflow input.", path: ["sessions"] });
  }
  if (structuredTodayAdmittedCorpusHash(provenanceSessions) !== value.admittedCorpusHash) {
    context.addIssue({ code: "custom", message: "admittedCorpusHash does not cover the exact ordered Session corpora.", path: ["admittedCorpusHash"] });
  }
});

export const DirectFindingCandidateSchema = z.object({
  text: z.string().trim().min(1),
  claimKind: EvidenceClaimKindSchema,
  messageKey: MessageKey,
  exactQuote: z.string().min(1)
}).strict();

export const DigestFindingCandidateSetSchema = z.object({
  sessionId: NonEmptyString,
  findings: z.array(DirectFindingCandidateSchema).max(48),
  uncertainties: z.array(NonEmptyString)
}).strict();

export const ResolvedDigestFindingsSchema = z.object({
  sessionId: NonEmptyString,
  messageLocators: z.array(EvidenceMessageLocatorSchema),
  spans: z.array(EvidenceSpanSchema),
  findings: z.array(AtomicFindingSchema),
  unresolvedCandidates: z.array(z.object({
    text: z.string().min(1),
    claimKind: EvidenceClaimKindSchema,
    messageKey: MessageKey,
    exactQuote: z.string(),
    reason: NonEmptyString
  }).strict())
}).strict();

export type StructuredTodayIndexWorkflowInputV2 = z.infer<typeof StructuredTodayIndexWorkflowInputV2Schema>;
export type StructuredTodayV2SessionInput = z.infer<typeof StructuredTodayV2SessionInputSchema>;
export type DirectFindingCandidateV1 = z.infer<typeof DirectFindingCandidateSchema>;
export type DigestFindingCandidateSetV1 = z.infer<typeof DigestFindingCandidateSetSchema>;
export type ResolvedDigestFindingsV1 = z.infer<typeof ResolvedDigestFindingsSchema>;

export function structuredTodayAdmittedCorpusHash(
  sessions: Array<z.infer<typeof StructuredTodayProvenanceSessionSchema>>
): string {
  return sha256Text(JSON.stringify(sessions.map((session) => ({
    sessionId: session.sessionId,
    evidenceId: session.evidenceId,
    parserVersion: session.parserVersion,
    admissionPolicyVersion: session.admissionPolicyVersion,
    admittedCorpusHash: session.admittedCorpusHash
  }))));
}
