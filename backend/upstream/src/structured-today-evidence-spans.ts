import { createHash } from "node:crypto";
import { z } from "zod";

export const STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION = "structured-today-evidence-parser/v2" as const;
export const STRUCTURED_TODAY_ADMISSION_POLICY_VERSION = "structured-today-admission-policy/v1" as const;

const NonEmptyString = z.string().trim().min(1);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Provider = z.enum(["codex", "claude", "copilot"]);
const Role = z.enum(["user", "assistant"]);
export const EvidenceAuthorKindSchema = z.enum(["human", "agent", "automation", "host-notification", "unknown"]);
const MessageKey = z.string().regex(/^msg-v2-[a-f0-9]{64}$/u);
const MessageLocatorId = z.string().regex(/^locator-v2-[a-f0-9]{64}$/u);
const SpanId = z.string().regex(/^span-v2-[a-f0-9]{64}$/u);

export const EvidenceRelationKindSchema = z.enum([
  "source-span",
  "inference-basis",
  "workflow-state",
  "coverage",
  "unresolved"
]);
export const EvidenceClaimKindSchema = z.enum(["fact", "human-participation", "human-adoption"]);

export const EvidenceMessageLocatorSchema = z.object({
  messageKey: MessageKey,
  messageLocatorId: MessageLocatorId,
  evidenceId: NonEmptyString,
  provider: Provider,
  sessionId: NonEmptyString,
  role: Role,
  authorKind: EvidenceAuthorKindSchema,
  providerMessageId: NonEmptyString.optional(),
  rawRecord: z.object({
    unit: z.literal("utf8-byte"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    contentHash: Sha256
  }).strict(),
  parserVersion: NonEmptyString,
  admissionPolicyVersion: NonEmptyString,
  normalizedMessageHash: Sha256,
  frozenSourcePrefix: z.object({
    byteLength: z.number().int().nonnegative(),
    contentHash: Sha256
  }).strict()
}).strict().superRefine((value, context) => {
  if (value.rawRecord.end <= value.rawRecord.start) {
    context.addIssue({ code: "custom", message: "rawRecord must be a non-empty half-open range.", path: ["rawRecord", "end"] });
  }
  if (value.rawRecord.end > value.frozenSourcePrefix.byteLength) {
    context.addIssue({ code: "custom", message: "rawRecord exceeds the frozen source prefix.", path: ["rawRecord", "end"] });
  }
});

export const EvidenceSpanSchema = z.object({
  spanId: SpanId,
  evidenceId: NonEmptyString,
  messageKey: MessageKey,
  messageLocatorId: MessageLocatorId,
  textQuote: z.object({
    exact: z.string().min(1),
    prefix: z.string().min(1).optional(),
    suffix: z.string().min(1).optional()
  }).strict(),
  textPosition: z.object({
    unit: z.literal("unicode-code-point"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive()
  }).strict(),
  quoteHash: Sha256
}).strict().superRefine((value, context) => {
  if (value.textPosition.end <= value.textPosition.start) {
    context.addIssue({ code: "custom", message: "textPosition must be a non-empty half-open range.", path: ["textPosition", "end"] });
  }
  if (sha256Text(value.textQuote.exact) !== value.quoteHash) {
    context.addIssue({ code: "custom", message: "quoteHash does not match textQuote.exact.", path: ["quoteHash"] });
  }
});

const SpanIds = z.array(SpanId).max(3).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "spanIds must be unique." });
  }
});

const FindingIds = z.array(NonEmptyString).min(1).max(3).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "findingIds must be unique." });
  }
});

export const AtomicFindingSchema = z.object({
  findingId: NonEmptyString,
  text: z.string().min(1),
  claimKind: EvidenceClaimKindSchema,
  relation: EvidenceRelationKindSchema,
  spanIds: SpanIds
}).strict().superRefine(addEvidenceRelationIssues);

export const CitedStatementSchema = z.object({
  statementId: NonEmptyString,
  text: z.string().min(1),
  relation: EvidenceRelationKindSchema,
  findingIds: FindingIds,
  spanIds: SpanIds
}).strict().superRefine(addEvidenceRelationIssues);

export type EvidenceRelationKindV1 = z.infer<typeof EvidenceRelationKindSchema>;
export type EvidenceClaimKindV1 = z.infer<typeof EvidenceClaimKindSchema>;
export type EvidenceMessageLocatorV1 = z.infer<typeof EvidenceMessageLocatorSchema>;
export type EvidenceSpanV1 = z.infer<typeof EvidenceSpanSchema>;
export type AtomicFindingV1 = z.infer<typeof AtomicFindingSchema>;
export type CitedStatementV1 = z.infer<typeof CitedStatementSchema>;

export interface ParsedEvidenceMessageV1 {
  locator: EvidenceMessageLocatorV1;
  content: string;
  projectionKind: "primary" | "fallback";
}

export const AdmittedProvenanceMessageSchema = z.object({
  locator: EvidenceMessageLocatorSchema,
  content: z.string().min(1),
  contentHash: Sha256,
  completeMessage: z.literal(true)
}).strict().superRefine((value, context) => {
  if (sha256Text(value.content) !== value.contentHash || value.contentHash !== value.locator.normalizedMessageHash) {
    context.addIssue({ code: "custom", message: "Admitted message content does not match its normalized message hash." });
  }
});

export const ProvenanceMessageOmissionSchema = z.object({
  messageKey: MessageKey,
  messageLocatorId: MessageLocatorId,
  reason: z.enum(["single-message-limit", "total-model-budget"]),
  rawRecord: z.object({
    unit: z.literal("utf8-byte"),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive()
  }).strict()
}).strict();

const EvidenceParseIssueSchema = z.object({
  kind: z.enum(["malformed-record", "incomplete-record", "synthetic-omission"]),
  rawRecord: z.object({
    unit: z.literal("utf8-byte"),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative()
  }).strict()
}).strict();

export const StructuredTodayProvenanceSessionSchema = z.object({
  schema: z.literal("structured-today-provenance-session/v1"),
  provider: Provider,
  sessionId: NonEmptyString,
  evidenceId: NonEmptyString,
  parserVersion: NonEmptyString,
  admissionPolicyVersion: NonEmptyString,
  frozenSourcePrefix: z.object({ byteLength: z.number().int().nonnegative(), contentHash: Sha256 }).strict(),
  coverage: z.enum(["complete", "partial"]),
  admittedMessages: z.array(AdmittedProvenanceMessageSchema),
  omissions: z.array(ProvenanceMessageOmissionSchema),
  parseIssues: z.array(EvidenceParseIssueSchema),
  admittedCorpusHash: Sha256
}).strict().superRefine((value, context) => {
  const expectedCoverage = value.omissions.length > 0 || value.parseIssues.length > 0 ? "partial" : "complete";
  if (value.coverage !== expectedCoverage) {
    context.addIssue({ code: "custom", message: "coverage does not match omissions and parse issues.", path: ["coverage"] });
  }
  const expected = sha256Text(JSON.stringify(value.admittedMessages.map((message) => ({
    messageLocatorId: message.locator.messageLocatorId,
    contentHash: message.contentHash,
    completeMessage: message.completeMessage
  }))));
  if (expected !== value.admittedCorpusHash) {
    context.addIssue({ code: "custom", message: "admittedCorpusHash does not match admittedMessages.", path: ["admittedCorpusHash"] });
  }
});

export type AdmittedProvenanceMessageV1 = z.infer<typeof AdmittedProvenanceMessageSchema>;
export type StructuredTodayProvenanceSessionV1 = z.infer<typeof StructuredTodayProvenanceSessionSchema>;

export interface EvidenceJsonlParseIssueV1 {
  kind: "malformed-record" | "incomplete-record" | "synthetic-omission";
  rawRecord: { unit: "utf8-byte"; start: number; end: number };
}

export interface EvidenceJsonlParseResultV1 {
  provider: "codex" | "claude" | "copilot";
  sessionId: string;
  evidenceId: string;
  parserVersion: string;
  admissionPolicyVersion: string;
  frozenSourcePrefix: { byteLength: number; contentHash: string };
  messages: ParsedEvidenceMessageV1[];
  issues: EvidenceJsonlParseIssueV1[];
}

export interface ParseEvidenceJsonlInputV1 {
  source: Uint8Array;
  provider: "codex" | "claude" | "copilot";
  sessionId: string;
  evidenceId: string;
  frozenPrefixByteLength?: number;
  parserVersion?: string;
  admissionPolicyVersion?: string;
  authorKindsByRecordRange?: Record<string, "human" | "automation" | "host-notification">;
  defaultUserAuthorKind?: "human" | "agent" | "automation" | "unknown";
}

export interface EvidenceSourceRecordV1 {
  ordinal: number;
  startByte: number;
  endByte: number;
  bytes: Uint8Array;
}

export interface ParseEvidenceRecordsInputV1 {
  records: readonly EvidenceSourceRecordV1[];
  provider: "codex" | "claude" | "copilot";
  sessionId: string;
  evidenceId: string;
  frozenSourcePrefix: { byteLength: number; contentHash: string };
  parserVersion?: string;
  admissionPolicyVersion?: string;
  authorKindsByRecordRange?: Record<string, "human" | "automation" | "host-notification">;
  defaultUserAuthorKind?: "human" | "agent" | "automation" | "unknown";
}

export type EvidenceSpanResolutionFailureV1 =
  | "unknown-message-key"
  | "ambiguous-message-key"
  | "empty-quote"
  | "quote-not-found"
  | "repeated-quote"
  | "synthetic-omission"
  | "message-integrity-mismatch"
  | "invalid-unicode"
  | "grapheme-boundary";

export type EvidenceSpanResolutionV1 =
  | { status: "resolved"; span: EvidenceSpanV1 }
  | { status: "unresolved"; reason: EvidenceSpanResolutionFailureV1 };

export type EvidenceSpanVerificationV1 =
  | { status: "verified"; utf16Start: number; utf16End: number }
  | {
      status: "unavailable";
      reason: "identity-mismatch" | "message-integrity-mismatch" | "selector-mismatch" | "grapheme-boundary";
    };

export const HostSpanCandidateSchema = z.object({
  messageKey: MessageKey,
  exactQuote: z.string()
}).strict();

export function parseEvidenceJsonl(input: ParseEvidenceJsonlInputV1): EvidenceJsonlParseResultV1 {
  const provider = Provider.parse(input.provider);
  const sessionId = NonEmptyString.parse(input.sessionId);
  const evidenceId = NonEmptyString.parse(input.evidenceId);
  const parserVersion = NonEmptyString.parse(input.parserVersion ?? STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION);
  const admissionPolicyVersion = NonEmptyString.parse(
    input.admissionPolicyVersion ?? STRUCTURED_TODAY_ADMISSION_POLICY_VERSION
  );
  const source = Buffer.from(input.source.buffer, input.source.byteOffset, input.source.byteLength);
  const prefixLength = input.frozenPrefixByteLength ?? source.byteLength;
  if (!Number.isSafeInteger(prefixLength) || prefixLength < 0 || prefixLength > source.byteLength) {
    throw new Error("frozenPrefixByteLength must be a safe byte offset within source.");
  }
  const prefix = source.subarray(0, prefixLength);
  const frozenSourcePrefix = {
    byteLength: prefixLength,
    contentHash: sha256Bytes(prefix)
  };
  const records: EvidenceSourceRecordV1[] = [];
  const scanIssues: EvidenceJsonlParseIssueV1[] = [];
  let recordStart = 0;
  let ordinal = 0;
  for (let cursor = 0; cursor < prefix.length; cursor += 1) {
    if (prefix[cursor] !== 0x0a) continue;
    let recordEnd = cursor;
    if (recordEnd > recordStart && prefix[recordEnd - 1] === 0x0d) recordEnd -= 1;
    if (recordEnd > recordStart) {
      records.push({
        ordinal,
        startByte: recordStart,
        endByte: recordEnd,
        bytes: Uint8Array.from(prefix.subarray(recordStart, recordEnd))
      });
      ordinal += 1;
    }
    recordStart = cursor + 1;
  }
  if (recordStart < prefix.length) {
    scanIssues.push({
      kind: "incomplete-record",
      rawRecord: { unit: "utf8-byte", start: recordStart, end: prefix.length }
    });
  }

  const parsed = parseEvidenceRecords({
    records,
    provider,
    sessionId,
    evidenceId,
    frozenSourcePrefix,
    parserVersion,
    admissionPolicyVersion,
    ...(input.authorKindsByRecordRange ? { authorKindsByRecordRange: input.authorKindsByRecordRange } : {}),
    ...(input.defaultUserAuthorKind ? { defaultUserAuthorKind: input.defaultUserAuthorKind } : {})
  });
  return { ...parsed, issues: [...parsed.issues, ...scanIssues] };
}

export function parseEvidenceRecords(input: ParseEvidenceRecordsInputV1): EvidenceJsonlParseResultV1 {
  const provider = Provider.parse(input.provider);
  const sessionId = NonEmptyString.parse(input.sessionId);
  const evidenceId = NonEmptyString.parse(input.evidenceId);
  const parserVersion = NonEmptyString.parse(input.parserVersion ?? STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION);
  const admissionPolicyVersion = NonEmptyString.parse(
    input.admissionPolicyVersion ?? STRUCTURED_TODAY_ADMISSION_POLICY_VERSION
  );
  const authorKindsByRecordRange = z.record(
    z.string().regex(/^\d+:\d+$/u),
    z.enum(["human", "automation", "host-notification"])
  ).parse(input.authorKindsByRecordRange ?? {});
  const defaultUserAuthorKind = input.defaultUserAuthorKind === undefined
    ? undefined
    : z.enum(["human", "agent", "automation", "unknown"]).parse(input.defaultUserAuthorKind);
  const frozenSourcePrefix = z.object({
    byteLength: z.number().int().nonnegative(),
    contentHash: Sha256
  }).strict().parse(input.frozenSourcePrefix);
  const messages: ParsedEvidenceMessageV1[] = [];
  const issues: EvidenceJsonlParseIssueV1[] = [];
  let previousEnd = -1;
  input.records.forEach((sourceRecord, recordIndex) => {
    if (!Number.isSafeInteger(sourceRecord.ordinal) || sourceRecord.ordinal !== recordIndex ||
      !Number.isSafeInteger(sourceRecord.startByte) || !Number.isSafeInteger(sourceRecord.endByte) ||
      sourceRecord.startByte < 0 || sourceRecord.endByte <= sourceRecord.startByte ||
      sourceRecord.startByte < previousEnd || sourceRecord.endByte > frozenSourcePrefix.byteLength ||
      sourceRecord.bytes.byteLength !== sourceRecord.endByte - sourceRecord.startByte) {
      throw new Error(`Verified record ${recordIndex} has an invalid source-owned range.`);
    }
    previousEnd = sourceRecord.endByte;
    const recordBytes = Buffer.from(sourceRecord.bytes.buffer, sourceRecord.bytes.byteOffset, sourceRecord.bytes.byteLength);
    let parsedRecord: Record<string, unknown>;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(recordBytes);
      const parsed = JSON.parse(decoded) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("record is not an object");
      parsedRecord = parsed as Record<string, unknown>;
    } catch {
      issues.push({
        kind: "malformed-record",
        rawRecord: { unit: "utf8-byte", start: sourceRecord.startByte, end: sourceRecord.endByte }
      });
      return;
    }
    const projection = projectProviderMessage(provider, parsedRecord);
    if (!projection) return;
    if (isSyntheticOmission(projection.providerMessageId, projection.content)) {
      issues.push({
        kind: "synthetic-omission",
        rawRecord: { unit: "utf8-byte", start: sourceRecord.startByte, end: sourceRecord.endByte }
      });
      return;
    }
    if (!isWellFormedUnicode(projection.content)) {
      issues.push({
        kind: "malformed-record",
        rawRecord: { unit: "utf8-byte", start: sourceRecord.startByte, end: sourceRecord.endByte }
      });
      return;
    }
    const rawRecord = {
      unit: "utf8-byte" as const,
      start: sourceRecord.startByte,
      end: sourceRecord.endByte,
      contentHash: sha256Bytes(recordBytes)
    };
    const normalizedMessageHash = sha256Text(projection.content);
    const authorKind = projection.role === "assistant"
      ? "agent" as const
      : authorKindsByRecordRange[`${sourceRecord.startByte}:${sourceRecord.endByte}`] ?? (provider === "copilot" ? projection.authorKind : defaultUserAuthorKind ?? projection.authorKind);
    const messageKey = `msg-v2-${hashTuple("message-key/v2", [
      provider,
      sessionId,
      projection.role,
      projection.projectionKind,
      parserVersion,
      normalizedMessageHash,
      rawRecord.start,
      rawRecord.end,
      rawRecord.contentHash
    ])}`;
    const messageLocatorId = `locator-v2-${hashTuple("message-locator/v2", [
      messageKey,
      evidenceId,
      provider,
      sessionId,
      projection.role,
      authorKind,
      parserVersion,
      admissionPolicyVersion,
      rawRecord.start,
      rawRecord.end,
      rawRecord.contentHash,
      frozenSourcePrefix.byteLength,
      frozenSourcePrefix.contentHash
    ])}`;
    const locator = EvidenceMessageLocatorSchema.parse({
      messageKey,
      messageLocatorId,
      evidenceId,
      provider,
      sessionId,
      role: projection.role,
      authorKind,
      ...(projection.providerMessageId ? { providerMessageId: projection.providerMessageId } : {}),
      rawRecord,
      parserVersion,
      admissionPolicyVersion,
      normalizedMessageHash,
      frozenSourcePrefix
    });
    messages.push({ locator, content: projection.content, projectionKind: projection.projectionKind });
  });
  const admittedMessages = provider === "codex" && messages.some((message) => message.projectionKind === "primary")
    ? messages.filter((message) => message.projectionKind === "primary")
    : messages;
  return {
    provider,
    sessionId,
    evidenceId,
    parserVersion,
    admissionPolicyVersion,
    frozenSourcePrefix,
    messages: admittedMessages,
    issues
  };
}

export function resolveEvidenceSpan(
  candidateInput: z.input<typeof HostSpanCandidateSchema>,
  enumeratedMessages: readonly ParsedEvidenceMessageV1[],
  options: { contextCodePoints?: number } = {}
): EvidenceSpanResolutionV1 {
  const candidate = HostSpanCandidateSchema.parse(candidateInput);
  if (candidate.exactQuote.length === 0) return { status: "unresolved", reason: "empty-quote" };
  if (candidate.exactQuote === "[中间消息因模型输入预算省略]") {
    return { status: "unresolved", reason: "synthetic-omission" };
  }
  const matches = enumeratedMessages.filter((message) => message.locator.messageKey === candidate.messageKey);
  if (matches.length === 0) return { status: "unresolved", reason: "unknown-message-key" };
  if (matches.length !== 1) return { status: "unresolved", reason: "ambiguous-message-key" };
  const selected = matches[0]!;
  const locatorResult = EvidenceMessageLocatorSchema.safeParse(selected.locator);
  if (!locatorResult.success || sha256Text(selected.content) !== selected.locator.normalizedMessageHash) {
    return { status: "unresolved", reason: "message-integrity-mismatch" };
  }
  if (!isWellFormedUnicode(selected.content) || !isWellFormedUnicode(candidate.exactQuote)) {
    return { status: "unresolved", reason: "invalid-unicode" };
  }
  const occurrences = exactOccurrences(selected.content, candidate.exactQuote);
  if (occurrences.length === 0) return { status: "unresolved", reason: "quote-not-found" };
  if (occurrences.length !== 1) return { status: "unresolved", reason: "repeated-quote" };
  const utf16Start = occurrences[0]!;
  const utf16End = utf16Start + candidate.exactQuote.length;
  const graphemes = graphemeSegments(selected.content);
  const boundaries = new Set<number>([0, selected.content.length, ...graphemes.map((item) => item.index)]);
  if (!boundaries.has(utf16Start) || !boundaries.has(utf16End)) {
    return { status: "unresolved", reason: "grapheme-boundary" };
  }
  const start = codePointLength(selected.content.slice(0, utf16Start));
  const end = start + codePointLength(candidate.exactQuote);
  const contextLimit = options.contextCodePoints ?? 32;
  if (!Number.isSafeInteger(contextLimit) || contextLimit < 0 || contextLimit > 256) {
    throw new Error("contextCodePoints must be an integer between 0 and 256.");
  }
  const prefix = graphemeBoundedPrefix(selected.content, utf16Start, graphemes, contextLimit);
  const suffix = graphemeBoundedSuffix(selected.content, utf16End, graphemes, contextLimit);
  const quoteHash = sha256Text(candidate.exactQuote);
  const spanWithoutId = {
    evidenceId: selected.locator.evidenceId,
    messageKey: selected.locator.messageKey,
    messageLocatorId: selected.locator.messageLocatorId,
    textQuote: {
      exact: candidate.exactQuote,
      ...(prefix ? { prefix } : {}),
      ...(suffix ? { suffix } : {})
    },
    textPosition: { unit: "unicode-code-point" as const, start, end },
    quoteHash
  };
  const span = EvidenceSpanSchema.parse({
    spanId: `span-v2-${hashTuple("evidence-span/v2", [
      selected.locator.messageLocatorId,
      spanWithoutId.textQuote.exact,
      spanWithoutId.textQuote.prefix ?? null,
      spanWithoutId.textQuote.suffix ?? null,
      start,
      end,
      quoteHash
    ])}`,
    ...spanWithoutId
  });
  return { status: "resolved", span };
}

/** Re-verifies a stored selector against one already re-parsed frozen message. */
export function verifyEvidenceSpan(
  spanInput: EvidenceSpanV1,
  message: ParsedEvidenceMessageV1
): EvidenceSpanVerificationV1 {
  const spanResult = EvidenceSpanSchema.safeParse(spanInput);
  const locatorResult = EvidenceMessageLocatorSchema.safeParse(message.locator);
  if (!spanResult.success || !locatorResult.success ||
    spanInput.messageKey !== message.locator.messageKey ||
    spanInput.messageLocatorId !== message.locator.messageLocatorId ||
    spanInput.evidenceId !== message.locator.evidenceId) {
    return { status: "unavailable", reason: "identity-mismatch" };
  }
  if (sha256Text(message.content) !== message.locator.normalizedMessageHash || !isWellFormedUnicode(message.content)) {
    return { status: "unavailable", reason: "message-integrity-mismatch" };
  }
  const codePoints = [...message.content];
  const { start, end } = spanInput.textPosition;
  if (end > codePoints.length || codePoints.slice(start, end).join("") !== spanInput.textQuote.exact) {
    return { status: "unavailable", reason: "selector-mismatch" };
  }
  const utf16Start = codePoints.slice(0, start).join("").length;
  const utf16End = codePoints.slice(0, end).join("").length;
  if (spanInput.textQuote.prefix && !message.content.slice(0, utf16Start).endsWith(spanInput.textQuote.prefix)) {
    return { status: "unavailable", reason: "selector-mismatch" };
  }
  if (spanInput.textQuote.suffix && !message.content.slice(utf16End).startsWith(spanInput.textQuote.suffix)) {
    return { status: "unavailable", reason: "selector-mismatch" };
  }
  const boundaries = new Set<number>([
    0,
    message.content.length,
    ...graphemeSegments(message.content).map((item) => item.index)
  ]);
  if (!boundaries.has(utf16Start) || !boundaries.has(utf16End)) {
    return { status: "unavailable", reason: "grapheme-boundary" };
  }
  return { status: "verified", utf16Start, utf16End };
}

function addEvidenceRelationIssues(
  value: { relation: EvidenceRelationKindV1; spanIds: string[] },
  context: z.RefinementCtx
): void {
  if ((value.relation === "source-span" || value.relation === "inference-basis") && value.spanIds.length === 0) {
    context.addIssue({ code: "custom", message: `${value.relation} requires at least one span.`, path: ["spanIds"] });
  }
  if (value.relation !== "source-span" && value.relation !== "inference-basis" && value.spanIds.length > 0) {
    context.addIssue({ code: "custom", message: `${value.relation} cannot promise transcript spans.`, path: ["spanIds"] });
  }
}

function projectProviderMessage(
  provider: "codex" | "claude" | "copilot",
  record: Record<string, unknown>
): {
  role: "user" | "assistant";
  authorKind: z.infer<typeof EvidenceAuthorKindSchema>;
  content: string;
  projectionKind: "primary" | "fallback";
  providerMessageId?: string;
} | undefined {
  if (provider === "copilot") {
    if (record.type !== "user.message" && record.type !== "assistant.message") return undefined;
    const data = asRecord(record.data);
    const role = record.type === "user.message" ? "user" : "assistant";
    const content = projectText(data?.content);
    if (!content) return undefined;
    const providerMessageId = optionalString(record.id);
    const authorKind = role === "assistant" || optionalString(record.agentId) || optionalString(data?.parentToolCallId) ? "agent" : data?.source === "user" ? "human" : "unknown";
    return { role, content, projectionKind: "primary", authorKind,
      ...(providerMessageId ? { providerMessageId } : {}) };
  }
  if (provider === "codex") {
    const payload = asRecord(record.payload);
    if (record.type === "response_item" && payload?.type === "message") {
      const role = providerRole(payload.role);
      const content = projectText(payload.content);
      if (!role || !content) return undefined;
      const providerMessageId = optionalString(payload.id);
      return {
        role,
        authorKind: providerAuthorKind(role, record),
        content,
        projectionKind: "primary",
        ...(providerMessageId ? { providerMessageId } : {})
      };
    }
    if (record.type === "event_msg" && (payload?.type === "user_message" || payload?.type === "agent_message")) {
      const role = payload.type === "user_message" ? "user" : "assistant";
      const content = normalizeText(payload.message);
      if (!content) return undefined;
      const providerMessageId = optionalString(payload.id);
      return {
        role,
        authorKind: providerAuthorKind(role, record),
        content,
        projectionKind: "fallback",
        ...(providerMessageId ? { providerMessageId } : {})
      };
    }
    return undefined;
  }
  const nested = asRecord(record.message);
  const role = providerRole(nested?.role ?? record.type);
  const content = projectText(nested?.content ?? record.content);
  if (!role || !content) return undefined;
  const providerMessageId = optionalString(record.uuid);
  return {
    role,
    authorKind: providerAuthorKind(role, record),
    content,
    projectionKind: "primary",
    ...(providerMessageId ? { providerMessageId } : {})
  };
}

function providerAuthorKind(
  role: "user" | "assistant",
  record: Record<string, unknown>
): z.infer<typeof EvidenceAuthorKindSchema> {
  if (role === "assistant") return "agent";
  if (record.isMeta === true || record.is_meta === true) return "automation";
  return "unknown";
}

function projectText(value: unknown): string | undefined {
  if (typeof value === "string") return normalizeText(value);
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const text = normalizeText(item);
      if (text) parts.push(text);
      continue;
    }
    const record = asRecord(item);
    const type = optionalString(record?.type) ?? "";
    if (type && !/text/iu.test(type)) continue;
    const text = normalizeText(record?.text ?? record?.content);
    if (text) parts.push(text);
  }
  return normalizeText(parts.join("\n\n"));
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\r\n?/gu, "\n").trim();
  return text || undefined;
}

function providerRole(value: unknown): "user" | "assistant" | undefined {
  return value === "user" || value === "assistant" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSyntheticOmission(providerMessageId: string | undefined, content: string): boolean {
  return providerMessageId === "structured-today-omission" && content === "[中间消息因模型输入预算省略]";
}

function exactOccurrences(content: string, quote: string): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - quote.length) {
    const found = content.indexOf(quote, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }
  return offsets;
}

function graphemeSegments(text: string): Array<{ index: number; segment: string }> {
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  return [...segmenter.segment(text)].map((item) => ({ index: item.index, segment: item.segment }));
}

function graphemeBoundedPrefix(
  text: string,
  exactStart: number,
  graphemes: Array<{ index: number; segment: string }>,
  limit: number
): string | undefined {
  if (limit === 0 || exactStart === 0) return undefined;
  const starts = graphemes.map((item) => item.index).filter((index) => index < exactStart);
  let selectedStart = exactStart;
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const candidate = starts[index]!;
    if (codePointLength(text.slice(candidate, exactStart)) > limit) break;
    selectedStart = candidate;
  }
  const prefix = text.slice(selectedStart, exactStart);
  return prefix || undefined;
}

function graphemeBoundedSuffix(
  text: string,
  exactEnd: number,
  graphemes: Array<{ index: number; segment: string }>,
  limit: number
): string | undefined {
  if (limit === 0 || exactEnd === text.length) return undefined;
  const ends = graphemes.map((item) => item.index + item.segment.length).filter((index) => index > exactEnd);
  let selectedEnd = exactEnd;
  for (const candidate of ends) {
    if (codePointLength(text.slice(exactEnd, candidate)) > limit) break;
    selectedEnd = candidate;
  }
  const suffix = text.slice(exactEnd, selectedEnd);
  return suffix || undefined;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function codePointLength(value: string): number {
  return [...value].length;
}

function hashTuple(domain: string, values: Array<string | number | null>): string {
  return sha256Text(JSON.stringify([domain, ...values]));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
