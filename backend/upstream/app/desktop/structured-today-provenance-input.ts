import type { AgentTranscriptCapture } from "../../src/types";
import {
  AdmittedProvenanceMessageSchema,
  ProvenanceMessageOmissionSchema,
  STRUCTURED_TODAY_ADMISSION_POLICY_VERSION,
  STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION,
  StructuredTodayProvenanceSessionSchema,
  parseEvidenceRecords,
  type AdmittedProvenanceMessageV1,
  type EvidenceJsonlParseIssueV1,
  type EvidenceSourceRecordV1,
  type ParsedEvidenceMessageV1,
  type StructuredTodayProvenanceSessionV1
} from "../../src/structured-today-evidence-spans";
import { sha256Text } from "../../src/structured-today-contracts";
import { scanVerifiedTranscriptRecords } from "./transcript-source-reader";

const MAX_SINGLE_MESSAGE_CODE_POINTS = 80_000;
const MAX_ADMITTED_CODE_POINTS = 240_000;

export { StructuredTodayProvenanceSessionSchema } from "../../src/structured-today-evidence-spans";
export type { AdmittedProvenanceMessageV1, StructuredTodayProvenanceSessionV1 } from "../../src/structured-today-evidence-spans";

export async function buildStructuredTodayProvenanceSession(input: {
  sourcePath: string;
  capture: AgentTranscriptCapture;
  provider: "codex" | "claude" | "copilot";
  sessionId: string;
  evidenceId: string;
  authorKindsByRecordRange?: Record<string, "human" | "automation" | "host-notification">;
  defaultUserAuthorKind?: "human" | "agent" | "automation" | "unknown";
}): Promise<StructuredTodayProvenanceSessionV1> {
  const records: EvidenceSourceRecordV1[] = [];
  const scan = await scanVerifiedTranscriptRecords(input.sourcePath, input.capture, (record) => {
    records.push(record);
  });
  const parsed = parseEvidenceRecords({
    records,
    provider: input.provider,
    sessionId: input.sessionId,
    evidenceId: input.evidenceId,
    frozenSourcePrefix: { byteLength: scan.byteLength, contentHash: scan.contentHash },
    parserVersion: STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION,
    admissionPolicyVersion: STRUCTURED_TODAY_ADMISSION_POLICY_VERSION,
    ...(input.authorKindsByRecordRange ? { authorKindsByRecordRange: input.authorKindsByRecordRange } : {}),
    ...(input.defaultUserAuthorKind ? { defaultUserAuthorKind: input.defaultUserAuthorKind } : {})
  });
  const parseIssues: EvidenceJsonlParseIssueV1[] = [
    ...parsed.issues,
    ...(scan.unterminatedTail
      ? [{
          kind: "incomplete-record" as const,
          rawRecord: {
            unit: "utf8-byte" as const,
            start: scan.unterminatedTail.startByte,
            end: scan.unterminatedTail.endByte
          }
        }]
      : [])
  ];
  const admitted = admitMessages(parsed.messages);
  const admittedMessages = admitted.messages.map((message) => AdmittedProvenanceMessageSchema.parse({
    locator: message.locator,
    content: message.content,
    contentHash: message.locator.normalizedMessageHash,
    completeMessage: true
  }));
  const omissions = admitted.omitted.map((message) => ProvenanceMessageOmissionSchema.parse({
    messageKey: message.message.locator.messageKey,
    messageLocatorId: message.message.locator.messageLocatorId,
    reason: message.reason,
    rawRecord: {
      unit: "utf8-byte",
      start: message.message.locator.rawRecord.start,
      end: message.message.locator.rawRecord.end
    }
  }));
  return StructuredTodayProvenanceSessionSchema.parse({
    schema: "structured-today-provenance-session/v1",
    provider: input.provider,
    sessionId: input.sessionId,
    evidenceId: input.evidenceId,
    parserVersion: parsed.parserVersion,
    admissionPolicyVersion: parsed.admissionPolicyVersion,
    frozenSourcePrefix: parsed.frozenSourcePrefix,
    coverage: omissions.length || parseIssues.length ? "partial" : "complete",
    admittedMessages,
    omissions,
    parseIssues,
    admittedCorpusHash: admittedCorpusHash(admittedMessages)
  });
}

function admitMessages(messages: ParsedEvidenceMessageV1[]): {
  messages: ParsedEvidenceMessageV1[];
  omitted: Array<{ message: ParsedEvidenceMessageV1; reason: "single-message-limit" | "total-model-budget" }>;
} {
  const eligible: ParsedEvidenceMessageV1[] = [];
  const omitted: Array<{ message: ParsedEvidenceMessageV1; reason: "single-message-limit" | "total-model-budget" }> = [];
  for (const message of messages) {
    if (codePointLength(message.content) > MAX_SINGLE_MESSAGE_CODE_POINTS) {
      omitted.push({ message, reason: "single-message-limit" });
    } else {
      eligible.push(message);
    }
  }
  const total = eligible.reduce((sum, message) => sum + codePointLength(message.content), 0);
  if (total <= MAX_ADMITTED_CODE_POINTS) return { messages: eligible, omitted };
  const headBudget = Math.floor(MAX_ADMITTED_CODE_POINTS / 3);
  const tailBudget = MAX_ADMITTED_CODE_POINTS - headBudget;
  const selected = new Set<string>();
  takeWithinBudget(eligible, headBudget, selected);
  takeWithinBudget([...eligible].reverse(), tailBudget, selected);
  return {
    messages: eligible.filter((message) => selected.has(message.locator.messageLocatorId)),
    omitted: [
      ...omitted,
      ...eligible
        .filter((message) => !selected.has(message.locator.messageLocatorId))
        .map((message) => ({ message, reason: "total-model-budget" as const }))
    ]
  };
}

function takeWithinBudget(
  messages: ParsedEvidenceMessageV1[],
  budget: number,
  selected: Set<string>
): void {
  let used = 0;
  for (const message of messages) {
    const length = codePointLength(message.content);
    if (used + length > budget) break;
    selected.add(message.locator.messageLocatorId);
    used += length;
  }
}

function admittedCorpusHash(messages: AdmittedProvenanceMessageV1[]): string {
  return sha256Text(JSON.stringify(messages.map((message) => ({
    messageLocatorId: message.locator.messageLocatorId,
    contentHash: message.contentHash,
    completeMessage: message.completeMessage
  }))));
}

function codePointLength(value: string): number {
  return [...value].length;
}
