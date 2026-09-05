import { z } from "zod";
import {
  EvidenceLocatorSchema,
  ParticipationAccountSchema,
  SessionDispositionSchema,
  STRUCTURED_TODAY_DOSSIER_SCHEMA,
  STRUCTURED_TODAY_INDEX_SCHEMA,
  StructuredTodayProvenanceSchema,
  TodaySessionRefSchema,
  TodayWorklineDossierSchema,
  TodayWorklineIndexSchema,
  canonicalContentHash
} from "./structured-today-contracts";
import {
  AtomicFindingSchema,
  CitedStatementSchema,
  EvidenceMessageLocatorSchema,
  EvidenceSpanSchema
} from "./structured-today-evidence-spans";

const NonEmptyString = z.string().trim().min(1);
const LogicalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const Timestamp = z.iso.datetime({ offset: true });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const ExtensionSchema = z.object({ kind: NonEmptyString, value: z.unknown() }).strict();

export const STRUCTURED_TODAY_INDEX_V2_SCHEMA = "today-workline-index/v2" as const;
export const STRUCTURED_TODAY_DOSSIER_V2_SCHEMA = "today-workline-dossier/v2" as const;

const CitedParticipationSchema = z.object({
  account: ParticipationAccountSchema,
  statement: CitedStatementSchema
}).strict();

export const TodayWorklineV2Schema = z.object({
  worklineId: NonEmptyString,
  title: NonEmptyString,
  summary: CitedStatementSchema,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  currentStop: CitedStatementSchema,
  possibleChange: CitedStatementSchema,
  possibleChangeAdopted: z.literal(false),
  participation: CitedParticipationSchema,
  evidenceReadiness: z.enum(["ready", "partial", "blocked"]),
  sessionIds: z.array(NonEmptyString).min(1),
  evidenceIds: z.array(NonEmptyString).min(1),
  extensions: z.array(ExtensionSchema)
}).strict().superRefine((value, context) => {
  if (value.endedAt && Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", message: "endedAt precedes startedAt.", path: ["endedAt"] });
  }
  addDuplicateIssues(value.sessionIds, context, ["sessionIds"]);
  addDuplicateIssues(value.evidenceIds, context, ["evidenceIds"]);
});

const CoverageSchema = z.object({
  admitted: z.number().int().nonnegative(),
  assigned: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  complete: z.boolean()
}).strict();

const DossierValidationSchema = z.object({
  schema: z.literal("passed"),
  evidence: z.literal("passed"),
  semantic: z.literal("passed"),
  critiqueIssues: z.array(NonEmptyString)
}).strict();

const TodayWorklineIndexV2BaseSchema = z.object({
  schema: z.literal(STRUCTURED_TODAY_INDEX_V2_SCHEMA),
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  workflowRunId: NonEmptyString,
  evidenceManifestId: NonEmptyString,
  sessions: z.array(TodaySessionRefSchema).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1),
  messageLocators: z.array(EvidenceMessageLocatorSchema),
  spans: z.array(EvidenceSpanSchema),
  findings: z.array(AtomicFindingSchema),
  dispositions: z.array(SessionDispositionSchema).min(1),
  worklines: z.array(TodayWorklineV2Schema),
  coverage: CoverageSchema,
  provenance: StructuredTodayProvenanceSchema,
  contentHash: Sha256,
  rawModelText: z.string().optional()
}).strict();

export const TodayWorklineIndexV2Schema = TodayWorklineIndexV2BaseSchema.superRefine((value, context) => {
  addV2ArtifactIssues(value, collectIndexStatements(value), context);
  addParticipationAuthorityIssues(value, context);
  addIndexIssues(value, context);
  addContentHashIssue(value, context);
});

const TodayWorklineDossierV2BaseSchema = z.object({
  schema: z.literal(STRUCTURED_TODAY_DOSSIER_V2_SCHEMA),
  artifactId: NonEmptyString,
  revision: z.number().int().positive(),
  logicalDate: LogicalDate,
  workflowRunId: NonEmptyString,
  sourceIndex: z.object({
    schema: z.literal(STRUCTURED_TODAY_INDEX_V2_SCHEMA),
    artifactId: NonEmptyString,
    revision: z.number().int().positive(),
    contentHash: Sha256
  }).strict(),
  worklineId: NonEmptyString,
  admittedSessionIds: z.array(NonEmptyString).min(1),
  evidence: z.array(EvidenceLocatorSchema).min(1),
  messageLocators: z.array(EvidenceMessageLocatorSchema),
  spans: z.array(EvidenceSpanSchema),
  findings: z.array(AtomicFindingSchema).min(1),
  content: z.object({
    title: NonEmptyString,
    priorContext: CitedStatementSchema,
    whatHappened: CitedStatementSchema,
    possibleChange: CitedStatementSchema,
    possibleChangeAdopted: z.literal(false),
    supportingEvidence: z.array(CitedStatementSchema),
    opposingEvidence: z.array(CitedStatementSchema),
    falsifiableObservation: CitedStatementSchema,
    gaps: z.array(CitedStatementSchema),
    humanQuestion: CitedStatementSchema,
    extensions: z.array(ExtensionSchema)
  }).strict(),
  validation: DossierValidationSchema,
  provenance: StructuredTodayProvenanceSchema,
  contentHash: Sha256,
  rawModelText: z.string().optional()
}).strict();

export const TodayWorklineDossierV2Schema = TodayWorklineDossierV2BaseSchema.superRefine((value, context) => {
  addV2ArtifactIssues(value, collectDossierStatements(value), context);
  addDossierIssues(value, context);
  addContentHashIssue(value, context);
});

export const TodayWorklineIndexArtifactSchema = z.union([
  TodayWorklineIndexSchema,
  TodayWorklineIndexV2Schema
]);

export const TodayWorklineDossierArtifactSchema = z.union([
  TodayWorklineDossierSchema,
  TodayWorklineDossierV2Schema
]);

export type TodayWorklineV2 = z.infer<typeof TodayWorklineV2Schema>;
export type TodayWorklineIndexV2 = z.infer<typeof TodayWorklineIndexV2Schema>;
export type TodayWorklineDossierV2 = z.infer<typeof TodayWorklineDossierV2Schema>;
export type TodayWorklineIndexArtifact = z.infer<typeof TodayWorklineIndexArtifactSchema>;
export type TodayWorklineDossierArtifact = z.infer<typeof TodayWorklineDossierArtifactSchema>;

export function parseTodayWorklineIndexArtifact(value: unknown): TodayWorklineIndexArtifact {
  if (schemaOf(value) === STRUCTURED_TODAY_INDEX_SCHEMA) {
    TodayWorklineIndexSchema.parse(value);
    return value as TodayWorklineIndexArtifact;
  }
  return TodayWorklineIndexV2Schema.parse(value);
}

export function parseTodayWorklineDossierArtifact(value: unknown): TodayWorklineDossierArtifact {
  if (schemaOf(value) === STRUCTURED_TODAY_DOSSIER_SCHEMA) {
    TodayWorklineDossierSchema.parse(value);
    return value as TodayWorklineDossierArtifact;
  }
  return TodayWorklineDossierV2Schema.parse(value);
}

export function validateTodayWorklineIndexV2(value: unknown): string[] {
  return validationIssues(TodayWorklineIndexV2Schema.safeParse(value));
}

export function validateTodayWorklineDossierV2(value: unknown): string[] {
  return validationIssues(TodayWorklineDossierV2Schema.safeParse(value));
}

export function validateTodayWorklineIndexArtifact(value: unknown): string[] {
  return schemaOf(value) === STRUCTURED_TODAY_INDEX_SCHEMA
    ? validationIssues(TodayWorklineIndexSchema.safeParse(value))
    : validateTodayWorklineIndexV2(value);
}

export function validateTodayWorklineDossierArtifact(value: unknown): string[] {
  return schemaOf(value) === STRUCTURED_TODAY_DOSSIER_SCHEMA
    ? validationIssues(TodayWorklineDossierSchema.safeParse(value))
    : validateTodayWorklineDossierV2(value);
}

function addV2ArtifactIssues(
  value: V2EvidenceArtifact,
  statements: z.infer<typeof CitedStatementSchema>[],
  context: z.RefinementCtx
): void {
  const evidenceById = uniqueMap(value.evidence, (item) => item.evidenceId, "evidence", context);
  const locatorById = uniqueMap(value.messageLocators, (item) => item.messageLocatorId, "message locator", context);
  uniqueMap(value.messageLocators, (item) => item.messageKey, "message key", context);
  const spanById = uniqueMap(value.spans, (item) => item.spanId, "span", context);
  const findingById = uniqueMap(value.findings, (item) => item.findingId, "finding", context);
  uniqueMap(statements, (item) => item.statementId, "statement", context);

  for (const locator of value.messageLocators) {
    const evidence = evidenceById.get(locator.evidenceId);
    if (!evidence) {
      issue(context, `Message locator ${locator.messageLocatorId} references unknown evidence ${locator.evidenceId}.`);
      continue;
    }
    if (evidence.sourceKind !== "session" ||
      evidence.provider !== locator.provider ||
      evidence.sessionId !== locator.sessionId) {
      issue(context, `Message locator ${locator.messageLocatorId} does not match its Session evidence tuple.`);
    }
  }

  const usedLocatorIds = new Set<string>();
  for (const span of value.spans) {
    const locator = locatorById.get(span.messageLocatorId);
    if (!locator) {
      issue(context, `Span ${span.spanId} references unknown message locator ${span.messageLocatorId}.`);
      continue;
    }
    usedLocatorIds.add(span.messageLocatorId);
    if (span.evidenceId !== locator.evidenceId || span.messageKey !== locator.messageKey) {
      issue(context, `Span ${span.spanId} does not match its message locator identity.`);
    }
  }

  const usedSpanIds = new Set<string>();
  for (const finding of value.findings) {
    for (const spanId of finding.spanIds) {
      if (!spanById.has(spanId)) issue(context, `Finding ${finding.findingId} references unknown span ${spanId}.`);
      else usedSpanIds.add(spanId);
    }
    if (finding.claimKind === "human-participation" || finding.claimKind === "human-adoption") {
      const hasHumanAuthority = finding.spanIds.some((spanId) => {
        const span = spanById.get(spanId);
        return span ? locatorById.get(span.messageLocatorId)?.authorKind === "human" : false;
      });
      if (!hasHumanAuthority) {
        issue(context, `Finding ${finding.findingId} claimKind ${finding.claimKind} requires a host-classified human-authored span.`);
      }
    }
  }

  const usedFindingIds = new Set<string>();
  for (const statement of statements) {
    const statementFindingSpanIds = new Set<string>();
    const orderedFindingSpanIds: string[] = [];
    for (const findingId of statement.findingIds) {
      const finding = findingById.get(findingId);
      if (!finding) {
        issue(context, `Statement ${statement.statementId} references unknown finding ${findingId}.`);
        continue;
      }
      usedFindingIds.add(findingId);
      finding.spanIds.forEach((spanId) => {
        statementFindingSpanIds.add(spanId);
        orderedFindingSpanIds.push(spanId);
      });
      if (!statementAllowsFindingRelation(statement.relation, finding.relation)) {
        issue(
          context,
          `Statement ${statement.statementId} relation ${statement.relation} cannot reference ${finding.relation} finding ${findingId}.`
        );
      }
    }
    for (const spanId of statement.spanIds) {
      if (!spanById.has(spanId)) issue(context, `Statement ${statement.statementId} references unknown span ${spanId}.`);
      if (!statementFindingSpanIds.has(spanId)) {
        issue(context, `Statement ${statement.statementId} span ${spanId} is not owned by one of its findings.`);
      }
    }
    if (!isOrderedSubset(statement.spanIds, orderedFindingSpanIds)) {
      issue(context, `Statement ${statement.statementId} spanIds do not preserve finding order.`);
    }
    if (statement.relation === "source-span") {
      if (statement.findingIds.length === 0 || statement.spanIds.length < 1 || statement.spanIds.length > 3) {
        issue(context, `Source-span statement ${statement.statementId} requires findings and one to three ordered spans.`);
      }
    }
  }

  for (const locator of value.messageLocators) {
    if (!usedLocatorIds.has(locator.messageLocatorId)) {
      issue(context, `Message locator ${locator.messageLocatorId} is orphaned.`);
    }
  }
  for (const span of value.spans) {
    if (!usedSpanIds.has(span.spanId)) issue(context, `Span ${span.spanId} is orphaned.`);
  }
  for (const finding of value.findings) {
    if (!usedFindingIds.has(finding.findingId)) issue(context, `Finding ${finding.findingId} is orphaned.`);
  }
}

function addIndexIssues(value: z.infer<typeof TodayWorklineIndexV2BaseSchema>, context: z.RefinementCtx): void {
  const sessionIds = new Set(value.sessions.map((item) => item.sessionId));
  const evidenceIds = new Set(value.evidence.map((item) => item.evidenceId));
  const worklineIds = new Set(value.worklines.map((item) => item.worklineId));
  const dispositionCount = new Map<string, number>();
  uniqueMap(value.sessions, (item) => item.sessionId, "Session", context);
  uniqueMap(value.worklines, (item) => item.worklineId, "workline", context);

  for (const workline of value.worklines) {
    workline.sessionIds.forEach((sessionId) => {
      if (!sessionIds.has(sessionId)) issue(context, `Workline ${workline.worklineId} references unknown Session ${sessionId}.`);
      const disposition = value.dispositions.find((item) => item.sessionId === sessionId);
      if (disposition?.kind !== "assigned" || !disposition.worklineIds.includes(workline.worklineId)) {
        issue(context, `Workline ${workline.worklineId} lacks reciprocal assignment for Session ${sessionId}.`);
      }
    });
    workline.evidenceIds.forEach((evidenceId) => {
      if (!evidenceIds.has(evidenceId)) issue(context, `Workline ${workline.worklineId} references unknown evidence ${evidenceId}.`);
    });
  }
  for (const disposition of value.dispositions) {
    dispositionCount.set(disposition.sessionId, (dispositionCount.get(disposition.sessionId) ?? 0) + 1);
    if (!sessionIds.has(disposition.sessionId)) issue(context, `Disposition references unknown Session ${disposition.sessionId}.`);
    if (disposition.kind === "assigned") {
      disposition.worklineIds.forEach((worklineId) => {
        if (!worklineIds.has(worklineId)) issue(context, `Disposition references unknown workline ${worklineId}.`);
      });
    }
  }
  for (const sessionId of sessionIds) {
    if (dispositionCount.get(sessionId) !== 1) issue(context, `Session ${sessionId} does not have exactly one disposition.`);
  }
  const counts = {
    admitted: value.sessions.length,
    assigned: value.dispositions.filter((item) => item.kind === "assigned").length,
    excluded: value.dispositions.filter((item) => item.kind === "excluded").length,
    failed: value.dispositions.filter((item) => item.kind === "failed").length,
    unresolved: value.dispositions.filter((item) => item.kind === "unresolved").length
  };
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (value.coverage[key] !== counts[key]) issue(context, `Coverage count ${key} is inconsistent.`);
  }
}

function addParticipationAuthorityIssues(
  value: z.infer<typeof TodayWorklineIndexV2BaseSchema>,
  context: z.RefinementCtx
): void {
  const spanById = new Map(value.spans.map((span) => [span.spanId, span]));
  const locatorById = new Map(value.messageLocators.map((locator) => [locator.messageLocatorId, locator]));
  for (const workline of value.worklines) {
    const account = workline.participation.account;
    if (account.status !== "described" || (!account.human && !account.joint)) continue;
    const hasUserSpan = workline.participation.statement.spanIds.some((spanId) => {
      const span = spanById.get(spanId);
      return span ? locatorById.get(span.messageLocatorId)?.authorKind === "human" : false;
    });
    if (!hasUserSpan) {
      issue(
        context,
        `Workline ${workline.worklineId} human/joint participation requires a user-authored source span.`,
        ["worklines", value.worklines.indexOf(workline), "participation"]
      );
    }
  }
}

function addDossierIssues(value: z.infer<typeof TodayWorklineDossierV2BaseSchema>, context: z.RefinementCtx): void {
  addDuplicateValues(value.admittedSessionIds, "admittedSessionIds", context);
  const admitted = new Set(value.admittedSessionIds);
  for (const evidence of value.evidence) {
    if (evidence.sessionId && !admitted.has(evidence.sessionId)) {
      issue(context, `Dossier evidence ${evidence.evidenceId} belongs to an unadmitted Session ${evidence.sessionId}.`);
    }
  }
}

function addContentHashIssue(
  value: { contentHash: string } & Record<string, unknown>,
  context: z.RefinementCtx
): void {
  const { contentHash: _contentHash, ...hashable } = value;
  if (canonicalContentHash(hashable) !== value.contentHash) {
    issue(context, "Artifact contentHash does not cover its exact V2 content.", ["contentHash"]);
  }
}

function collectIndexStatements(value: z.infer<typeof TodayWorklineIndexV2BaseSchema>) {
  return value.worklines.flatMap((workline) => [
    workline.summary,
    workline.currentStop,
    workline.possibleChange,
    workline.participation.statement
  ]);
}

function collectDossierStatements(value: z.infer<typeof TodayWorklineDossierV2BaseSchema>) {
  return [
    value.content.priorContext,
    value.content.whatHappened,
    value.content.possibleChange,
    ...value.content.supportingEvidence,
    ...value.content.opposingEvidence,
    value.content.falsifiableObservation,
    ...value.content.gaps,
    value.content.humanQuestion
  ];
}

type V2EvidenceArtifact = {
  evidence: Array<z.infer<typeof EvidenceLocatorSchema>>;
  messageLocators: Array<z.infer<typeof EvidenceMessageLocatorSchema>>;
  spans: Array<z.infer<typeof EvidenceSpanSchema>>;
  findings: Array<z.infer<typeof AtomicFindingSchema>>;
};

function uniqueMap<T>(
  values: T[],
  key: (value: T) => string,
  label: string,
  context: z.RefinementCtx
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) issue(context, `Duplicate ${label} identity ${id}.`);
    else result.set(id, value);
  }
  return result;
}

function addDuplicateIssues(values: string[], context: z.RefinementCtx, path: Array<string | number>): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Duplicate values are not allowed.", path });
  }
}

function addDuplicateValues(values: string[], label: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) issue(context, `${label} contains duplicate values.`);
}

function isOrderedSubset(selected: string[], ordered: string[]): boolean {
  let cursor = 0;
  for (const value of selected) {
    const index = ordered.indexOf(value, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function statementAllowsFindingRelation(
  statement: z.infer<typeof CitedStatementSchema>["relation"],
  finding: z.infer<typeof AtomicFindingSchema>["relation"]
): boolean {
  if (statement === "source-span") return finding === "source-span";
  if (statement === "inference-basis") return finding === "source-span" || finding === "inference-basis";
  return statement === finding;
}

function validationIssues(result: z.ZodSafeParseResult<unknown>): string[] {
  if (result.success) return [];
  return result.error.issues.map((item) => `${item.path.join(".") || "$"}: ${item.message}`);
}

function issue(context: z.RefinementCtx, message: string, path: Array<string | number> = []): void {
  context.addIssue({ code: "custom", message, path });
}

function schemaOf(value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as { schema?: unknown }).schema
    : undefined;
}
