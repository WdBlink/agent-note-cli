import type { AgentWorkSession, AgentWorkSnapshot } from "../../src/types";
import {
  EditorialContractBindingSchema,
  StructuredTodayIndexWorkflowInputSchema,
  sha256Text,
  type EditorialContractBindingV1,
  type StructuredTodayIndexWorkflowInput
} from "../../src/structured-today-contracts";
import { readBoundedTranscriptSource } from "./transcript-source-reader";
import { parseSessionTranscript } from "./transcript-reader";
import {
  STRUCTURED_TODAY_ADMISSION_POLICY_VERSION,
  STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION
} from "../../src/structured-today-evidence-spans";
import {
  STRUCTURED_TODAY_INDEX_INPUT_V2_SCHEMA,
  STRUCTURED_TODAY_V2_WORKFLOW_VERSION,
  StructuredTodayIndexWorkflowInputV2Schema,
  structuredTodayAdmittedCorpusHash,
  type StructuredTodayIndexWorkflowInputV2
} from "../../src/structured-today-v2-workflow";
import { buildStructuredTodayProvenanceSession } from "./structured-today-provenance-input";
import { sessionUserAuthorKind } from "./session-authority";
import { familyChildEvidenceId } from "../../src/session-family";

const MAX_MODEL_EVIDENCE_CHARACTERS = 240_000;

export interface StructuredTodayIndexInputOptions {
  logicalDate: string;
  snapshot: AgentWorkSnapshot;
  editorialContract: EditorialContractBindingV1;
  artifactId: string;
  revision: number;
  workflowRunId: string;
  readTranscript?: typeof readBoundedTranscriptSource;
}

export interface StructuredTodayIndexInputV2Options extends StructuredTodayIndexInputOptions {
  buildProvenanceSession?: typeof buildStructuredTodayProvenanceSession;
}

export async function buildStructuredTodayIndexInput(
  options: StructuredTodayIndexInputOptions
): Promise<StructuredTodayIndexWorkflowInput> {
  if (options.snapshot.date !== options.logicalDate) {
    throw new Error("Structured Today snapshot date does not match the requested date.");
  }
  const editorialContract = EditorialContractBindingSchema.parse(options.editorialContract);
  const readTranscript = options.readTranscript ?? readBoundedTranscriptSource;
  const supported = options.snapshot.sessions.filter(isSupportedSession);
  if (supported.length === 0) throw new Error("今天没有可进入结构化工作脉络的 Codex 或 Claude Session。");
  const families = structuredTodaySessionFamilies(supported);
  if (families.length === 0) throw new Error("今天只发现了无法归属到主会话的子 Agent 记录；请刷新 Session 家族后重试。");
  const sessions = await mapWithConcurrency(families, 3, async (family) => {
    const session = family.root;
    const capture = session.transcriptCapture;
    const sourcePath = capture?.canonicalPath ?? session.path;
    const evidenceId = `session:${session.platform}:${session.id}`;
    const metadataHash = sha256Text(JSON.stringify({
      provider: session.platform,
      sessionId: session.id,
      sourcePath,
      startedAt: session.startedAt ?? null,
      updatedAt: session.updatedAt,
      title: session.title,
      summary: session.summary,
      status: session.status
    }));
    const rootEvidence = {
      evidenceId,
      sourceKind: "session" as const,
      provider: session.platform,
      sessionId: session.id,
      sourcePath,
      range: capture ? `bytes 0-${capture.byteLength}` : "metadata-only",
      contentHash: capture?.sha256 ?? metadataHash
    };
    const evidence = [
      rootEvidence,
      ...family.members.filter((member) => member.id !== session.id).map((member) => {
        const memberCapture = member.transcriptCapture;
        return {
          evidenceId: familyChildEvidenceId(member),
          sourceKind: "linked-material" as const,
          provider: member.platform,
          sourcePath: memberCapture?.canonicalPath ?? member.path,
          range: memberCapture ? `bytes 0-${memberCapture.byteLength}` : "metadata-only",
          contentHash: memberCapture?.sha256 ?? sha256Text(JSON.stringify(sessionMetadata(member)))
        };
      })
    ];
    const base = {
      logicalDate: options.logicalDate,
      editorialContract,
      session: {
        sessionId: session.id,
        provider: session.platform,
        sourcePath,
        title: session.title.trim() || `${providerLabel(session.platform)} Session`,
        startedAt: validTimestamp(session.startedAt) ?? validTimestamp(session.updatedAt) ?? options.snapshot.generatedAt,
        endedAt: validTimestamp(session.updatedAt) ?? options.snapshot.generatedAt,
        evidenceIds: evidence.map((item) => item.evidenceId),
        ...(session.lineage ? { lineage: session.lineage } : {})
      },
      evidence
    };
    if (!capture || capture.canonicalPath !== session.path) {
      return {
        ...base,
        evidenceText: JSON.stringify({
          coverage: "unavailable",
          reason: "Scanner did not provide one exact complete transcript capture.",
          metadata: sessionMetadata(session)
        }),
        preDisposition: {
          kind: "failed" as const,
          reason: "Session 缺少可验证的完整 transcript capture。"
        }
      };
    }
    try {
      const familyEvidence = await mapWithConcurrency(family.members, 3, async (member) => {
        const memberCapture = member.transcriptCapture;
        if (!memberCapture || memberCapture.canonicalPath !== member.path) {
          return {
            relation: member.id === session.id ? "primary" : "child-agent",
            metadata: sessionMetadata(member),
            coverage: "unavailable",
            warning: "Scanner did not provide one exact complete transcript capture.",
            omittedToolEvents: 0,
            messages: []
          };
        }
        try {
          const source = await readTranscript(memberCapture.canonicalPath, {
            origin: "traceink-asset",
            transcriptCapture: memberCapture
          });
          const parsed = parseSessionTranscript({
            content: source.content,
            platform: member.platform,
            sessionId: member.id,
            title: member.title,
            path: memberCapture.canonicalPath,
            truncated: source.truncated,
            userAuthorKind: sessionUserAuthorKind(member)
          });
          return {
            relation: member.id === session.id ? "primary" : "child-agent",
            metadata: sessionMetadata(member),
            coverage: parsed.truncated || parsed.warning ? "partial" : "complete",
            warning: parsed.warning ?? null,
            omittedToolEvents: parsed.omittedToolEvents,
            messages: parsed.messages
          };
        } catch (error) {
          if (member.id === session.id) throw error;
          return {
            relation: "child-agent",
            metadata: sessionMetadata(member),
            coverage: "failed",
            warning: boundedError(error),
            omittedToolEvents: 0,
            messages: []
          };
        }
      });
      return {
        ...base,
        evidenceText: boundedEvidenceJson({
          coverage: familyEvidence.some((member) => member.coverage !== "complete") ? "partial" : "complete",
          omittedToolEvents: familyEvidence.reduce((total, member) => total + member.omittedToolEvents, 0),
          warning: familyEvidence.some((member) => member.coverage === "failed" || member.coverage === "unavailable")
            ? "Some child-Agent execution evidence was unavailable; the primary Session remains admitted."
            : null,
          metadata: sessionMetadata(session),
          family: {
            primarySessionId: session.id,
            childSessionIds: family.members.filter((member) => member.id !== session.id).map((member) => member.id)
          },
          members: familyEvidence.map(({ messages: _messages, ...member }) => member),
          messages: familyEvidence.flatMap((member) => member.messages.map((message) => ({
            ...message,
            familySessionId: member.metadata.sessionId,
            familyRelation: member.relation
          })))
        })
      };
    } catch (error) {
      return {
        ...base,
        evidenceText: JSON.stringify({
          coverage: "failed",
          reason: boundedError(error),
          metadata: sessionMetadata(session)
        }),
        preDisposition: {
          kind: "failed" as const,
          reason: `Session transcript 无法按冻结范围读取：${boundedError(error)}`
        }
      };
    }
  });
  const evidence = sessions.flatMap((item) => item.evidence);
  const evidenceManifestId = `manifest-${sha256Text(JSON.stringify({
    logicalDate: options.logicalDate,
    cutoff: options.snapshot.generatedAt,
    evidence
  })).slice(0, 32)}`;
  return StructuredTodayIndexWorkflowInputSchema.parse({
    logicalDate: options.logicalDate,
    workflowRunId: options.workflowRunId,
    artifactId: options.artifactId,
    revision: options.revision,
    evidenceManifestId,
    editorialContract,
    sessions,
    evidence
  });
}

export async function buildStructuredTodayIndexInputV2(
  options: StructuredTodayIndexInputV2Options
): Promise<StructuredTodayIndexWorkflowInputV2> {
  if (options.snapshot.date !== options.logicalDate) {
    throw new Error("Structured Today V2 snapshot date does not match the requested date.");
  }
  const editorialContract = EditorialContractBindingSchema.parse(options.editorialContract);
  const buildProvenance = options.buildProvenanceSession ?? buildStructuredTodayProvenanceSession;
  const supported = structuredTodaySessionFamilies(options.snapshot.sessions.filter(isSupportedSession)).map((family) => family.root);
  if (supported.length === 0) throw new Error("今天没有可进入结构化工作脉络的 Codex 或 Claude Session。");
  const sessions = await mapWithConcurrency(supported, 3, async (session) => {
    const capture = session.transcriptCapture;
    const sourcePath = capture?.canonicalPath ?? session.path;
    const evidenceId = `session:${session.platform}:${session.id}`;
    const metadataHash = sha256Text(JSON.stringify({
      provider: session.platform,
      sessionId: session.id,
      sourcePath,
      startedAt: session.startedAt ?? null,
      updatedAt: session.updatedAt,
      title: session.title,
      summary: session.summary,
      status: session.status
    }));
    const evidence = {
      evidenceId,
      sourceKind: "session" as const,
      provider: session.platform,
      sessionId: session.id,
      sourcePath,
      range: capture ? `bytes 0-${capture.byteLength}` : "metadata-only",
      contentHash: capture?.sha256 ?? metadataHash
    };
    const base = {
      logicalDate: options.logicalDate,
      editorialContract,
      session: {
        sessionId: session.id,
        provider: session.platform,
        sourcePath,
        title: session.title.trim() || `${providerLabel(session.platform)} Session`,
        startedAt: validTimestamp(session.startedAt) ?? validTimestamp(session.updatedAt) ?? options.snapshot.generatedAt,
        endedAt: validTimestamp(session.updatedAt) ?? options.snapshot.generatedAt,
        evidenceIds: [evidenceId],
        ...(session.lineage ? { lineage: session.lineage } : {})
      },
      evidence: [evidence]
    };
    if (!capture || capture.canonicalPath !== session.path) {
      return {
        ...base,
        preDisposition: {
          kind: "failed" as const,
          reason: "Session 缺少可验证的完整 transcript capture。"
        }
      };
    }
    try {
      const provenanceSession = await buildProvenance({
        sourcePath,
        capture,
        provider: session.platform,
        sessionId: session.id,
        evidenceId,
        defaultUserAuthorKind: sessionUserAuthorKind(session)
      });
      return provenanceSession.admittedMessages.length > 0
        ? { ...base, provenanceSession }
        : {
            ...base,
            provenanceSession,
            preDisposition: {
              kind: "failed" as const,
              reason: "Session 冻结前缀中没有可进入模型的完整用户或助手消息。"
            }
          };
    } catch (error) {
      return {
        ...base,
        preDisposition: {
          kind: "failed" as const,
          reason: `Session transcript 无法建立消息级 provenance：${boundedError(error)}`
        }
      };
    }
  });
  const evidence = sessions.flatMap((item) => item.evidence);
  const provenanceSessions = sessions.flatMap((item) =>
    "provenanceSession" in item && item.provenanceSession ? [item.provenanceSession] : []
  );
  const admittedCorpusHash = structuredTodayAdmittedCorpusHash(provenanceSessions);
  const evidenceManifestId = `manifest-v2-${sha256Text(JSON.stringify({
    logicalDate: options.logicalDate,
    cutoff: options.snapshot.generatedAt,
    parserVersion: STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION,
    admissionPolicyVersion: STRUCTURED_TODAY_ADMISSION_POLICY_VERSION,
    admittedCorpusHash,
    evidence
  })).slice(0, 32)}`;
  return StructuredTodayIndexWorkflowInputV2Schema.parse({
    schema: STRUCTURED_TODAY_INDEX_INPUT_V2_SCHEMA,
    workflowVersion: STRUCTURED_TODAY_V2_WORKFLOW_VERSION,
    logicalDate: options.logicalDate,
    workflowRunId: options.workflowRunId,
    artifactId: options.artifactId,
    revision: options.revision,
    evidenceManifestId,
    editorialContract,
    parserVersion: STRUCTURED_TODAY_EVIDENCE_PARSER_VERSION,
    admissionPolicyVersion: STRUCTURED_TODAY_ADMISSION_POLICY_VERSION,
    admittedCorpusHash,
    sessions,
    evidence
  });
}

export function boundedEvidenceJson<T extends {
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; timestamp?: string }>;
}>(value: T): string {
  const exact = JSON.stringify(value);
  if (exact.length <= MAX_MODEL_EVIDENCE_CHARACTERS) return exact;
  const omission = { id: "structured-today-omission", role: "assistant" as const, content: "[中间消息因模型输入预算省略]" };
  const partial = {
    ...value,
    coverage: "partial",
    warning: "Model input budget retained the earliest and latest conversation messages; middle messages were omitted.",
    messages: [omission]
  };
  const budget = MAX_MODEL_EVIDENCE_CHARACTERS - JSON.stringify(partial).length;
  if (budget < 0) throw new Error("Session metadata exceeds the model evidence budget.");
  const costs = value.messages.map((message) => JSON.stringify(message).length + 1);
  let headEnd = 0;
  let used = 0;
  while (headEnd < costs.length && used + costs[headEnd]! <= Math.floor(budget / 3)) {
    used += costs[headEnd++]!;
  }
  let tailStart = costs.length;
  while (tailStart > headEnd && used + costs[tailStart - 1]! <= budget) {
    used += costs[--tailStart]!;
  }
  const bounded = JSON.stringify({
    ...partial,
    messages: [...value.messages.slice(0, headEnd), omission, ...value.messages.slice(tailStart)]
  });
  if (bounded.length > MAX_MODEL_EVIDENCE_CHARACTERS) throw new Error("Model evidence exceeds its serialized budget.");
  return bounded;
}

export interface StructuredTodaySessionFamily {
  root: AgentWorkSession & { platform: "codex" | "claude" | "copilot" };
  members: Array<AgentWorkSession & { platform: "codex" | "claude" | "copilot" }>;
}

export function structuredTodaySessionFamilies(
  inputSessions: AgentWorkSession[]
): StructuredTodaySessionFamily[] {
  const sessions = inputSessions.filter(isSupportedSession);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = sessions.filter((session) => session.lineage?.origin !== "subagent");
  const familyByRoot = new Map(roots.map((root) => [root.id, { root, members: [root] }]));
  for (const child of sessions.filter((session) => session.lineage?.origin === "subagent")) {
    let parentId = child.lineage?.parentSessionId;
    const seen = new Set([child.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.lineage?.origin !== "subagent") {
        familyByRoot.get(parent.id)?.members.push(child);
        parentId = undefined;
        break;
      }
      parentId = parent.lineage.parentSessionId;
    }
  }
  return roots.map((root) => familyByRoot.get(root.id)!).map((family) => ({
    ...family,
    members: family.members.sort((left, right) =>
      (left.startedAt ?? left.updatedAt).localeCompare(right.startedAt ?? right.updatedAt) || left.id.localeCompare(right.id)
    )
  }));
}


function sessionMetadata(session: AgentWorkSession) {
  return {
    provider: session.platform,
    sessionId: session.id,
    title: session.title,
    startedAt: session.startedAt ?? null,
    updatedAt: session.updatedAt,
    status: session.status,
    workingDirectory: session.worktreePath ?? session.projectPath ?? session.repositoryPath ?? null,
    branch: session.branch ?? null,
    lineage: session.lineage ?? { origin: "unknown" as const }
  };
}

function isSupportedSession(
  session: AgentWorkSession
): session is AgentWorkSession & { platform: "codex" | "claude" | "copilot" } {
  return session.platform === "codex" || session.platform === "claude" || session.platform === "copilot";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item !== undefined) results[index] = await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return results;
}

function validTimestamp(value: string | undefined): string | undefined {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function providerLabel(provider: "codex" | "claude" | "copilot"): string {
  return provider === "codex" ? "Codex" : provider === "copilot" ? "GitHub Copilot" : "Claude Code";
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "未知读取错误";
}
