import type { BaseCheckpointSaver } from "@langchain/langgraph";
import {
  Command,
  END,
  ReducedValue,
  Send,
  START,
  StateGraph,
  StateSchema,
  interrupt
} from "@langchain/langgraph";
import { z } from "zod";
import {
  DigestExecutionResultSchema,
  DigestWorkItemSchema,
  DossierAnalysisCandidateSchema,
  DossierCritiqueCandidateSchema,
  StructuredTodayDossierWorkflowInputSchema,
  StructuredTodayDossierWorkflowOutputSchema,
  StructuredTodayIndexWorkflowInputSchema,
  StructuredTodayIndexWorkflowOutputSchema,
  StructuredTodayModelInvocationSchema,
  StructuredTodayProposalWorkflowInputSchema,
  StructuredTodayProposalWorkflowOutputSchema,
  StructuredTodayProposalSetCandidateSchema,
  type DigestExecutionResultV1,
  type SessionDigestCandidate,
  type StructuredTodayDossierWorkflowInput,
  type StructuredTodayDossierWorkflowOutput,
  type StructuredTodayIndexWorkflowInput,
  type StructuredTodayIndexWorkflowOutput,
  type StructuredTodayProposalWorkflowInput,
  type StructuredTodayProposalWorkflowOutput,
  type WorklineSynthesisCandidate
} from "./structured-today-contracts";
import type { StructuredTodayModelFunctions } from "./structured-today-model-functions";
import { NodeSqliteSaver } from "./langgraph-node-sqlite-checkpointer";
import {
  buildStructuredTodayDossier,
  buildStructuredTodayIndex,
  buildStructuredTodayProposalArtifact,
  StructuredTodayComposeEnvelopeSchema,
  StructuredTodayGatheredDossierEvidenceSchema,
  StructuredTodaySynthesisEnvelopeSchema
} from "./structured-today-artifacts";

export type StructuredTodayWorkflowProgressV1 =
  | {
      stage: "digest";
      status: "running" | "ready" | "failed" | "excluded";
      sessionId: string;
    }
  | {
      stage: "index-synthesis" | "dossier-analysis" | "dossier-critique" | "dossier-compose" | "proposal-arrange";
      status: "running" | "ready" | "failed";
      worklineId?: string;
    };

const DigestResultsValue = new ReducedValue(
  z.array(DigestExecutionResultSchema).default(() => []),
  {
    inputSchema: DigestExecutionResultSchema,
    reducer: (current, next) => [...current, next]
  }
);

const IndexState = new StateSchema({
  input: StructuredTodayIndexWorkflowInputSchema,
  currentDigestSessionId: z.string().trim().min(1).optional(),
  digestResults: DigestResultsValue,
  synthesisEnvelope: StructuredTodaySynthesisEnvelopeSchema.optional(),
  output: StructuredTodayIndexWorkflowOutputSchema.optional()
});

const AnalysisEnvelopeSchema = z.object({
  analysis: DossierAnalysisCandidateSchema,
  invocation: StructuredTodayModelInvocationSchema
}).strict();

const CritiqueEnvelopeSchema = z.object({
  analysis: DossierAnalysisCandidateSchema,
  analysisInvocation: StructuredTodayModelInvocationSchema,
  critique: DossierCritiqueCandidateSchema,
  critiqueInvocation: StructuredTodayModelInvocationSchema
}).strict();

const DossierState = new StateSchema({
  input: StructuredTodayDossierWorkflowInputSchema,
  gathered: StructuredTodayGatheredDossierEvidenceSchema.optional(),
  analysisEnvelope: AnalysisEnvelopeSchema.optional(),
  critiqueEnvelope: CritiqueEnvelopeSchema.optional(),
  composeEnvelope: StructuredTodayComposeEnvelopeSchema.optional(),
  output: StructuredTodayDossierWorkflowOutputSchema.optional()
});

const ProposalState = new StateSchema({
  input: StructuredTodayProposalWorkflowInputSchema,
  candidate: StructuredTodayProposalSetCandidateSchema.optional(),
  invocation: StructuredTodayModelInvocationSchema.optional(),
  output: StructuredTodayProposalWorkflowOutputSchema.optional()
});

export interface StructuredTodayLangGraphDependencies {
  models: StructuredTodayModelFunctions;
  digestConcurrency?: number;
  onProgress?: (progress: StructuredTodayWorkflowProgressV1) => void | Promise<void>;
}

export interface StructuredTodayLangGraphRuntime {
  checkpointer: NodeSqliteSaver;
  indexGraph: ReturnType<typeof createStructuredTodayLangGraphIndex>;
  dossierGraph: ReturnType<typeof createStructuredTodayLangGraphDossier>;
  proposalGraph: ReturnType<typeof createStructuredTodayLangGraphProposals>;
  close(): void;
}

export function createStructuredTodayLangGraphIndex(input: {
  dependencies: StructuredTodayLangGraphDependencies;
  checkpointer?: BaseCheckpointSaver;
}) {
  const dependencies = input.dependencies;
  const localItems = new Map<string, z.infer<typeof DigestWorkItemSchema>>();
  const itemStore = workflowItemStore(input.checkpointer);

  const dispatch = async () => ({});
  const routeSessions = (state: typeof IndexState.State) => state.input.sessions.map((item) => new Send(
    "digest-session",
    { currentDigestSessionId: item.session.sessionId }
  ));
  const digestSession: typeof IndexState.Node = async (state, config) => {
    const sessionId = state.currentDigestSessionId;
    if (!sessionId) throw new Error("LangGraph digest node did not receive a Session reference.");
    const threadId = typeof config.configurable?.thread_id === "string" ? config.configurable.thread_id : "";
    const stored = localItems.get(sessionId) ?? (threadId ? await itemStore?.getWorkflowItem(threadId, sessionId) : undefined);
    const item = DigestWorkItemSchema.parse(stored);
    const result = await executeDigest(item, dependencies);
    return { digestResults: result };
  };
  const synthesize: typeof IndexState.Node = async (state) => {
    if (state.input.pauseBeforeSynthesis) {
      interrupt<{ reason: "structured-today-spike-checkpoint" }, { continue: true }>({
        reason: "structured-today-spike-checkpoint"
      });
    }
    const successful = state.digestResults.filter(isSuccessfulDigest);
    if (successful.length === 0) {
      return {
        synthesisEnvelope: {
          digestResults: state.digestResults,
          synthesis: { worklines: [], assignments: [], unresolvedSessionIds: [] }
        }
      };
    }
    await emitProgress(dependencies, { stage: "index-synthesis", status: "running" });
    try {
      const result = await dependencies.models.synthesizeWorklineIndex({
        logicalDate: state.input.logicalDate,
        editorialContract: state.input.editorialContract,
        evidenceManifestJson: JSON.stringify({
          evidenceManifestId: state.input.evidenceManifestId,
          sessions: state.input.sessions.map((item) => item.session),
          evidence: state.input.evidence
        }),
        sessionDigestsJson: JSON.stringify(successful.map((item) => item.digest)),
        allowedSessionIds: nonEmptySessionIds(successful.map((item) => item.digest.sessionId)),
        allowedEvidenceIds: nonEmptyEvidenceIds(state.input.evidence.map((item) => item.evidenceId))
      });
      await emitProgress(dependencies, { stage: "index-synthesis", status: "ready" });
      const synthesis = enforceWorklineParticipationAuthority(
        result.output,
        successful.map((item) => item.digest)
      );
      return {
        synthesisEnvelope: {
          digestResults: state.digestResults,
          synthesis,
          invocation: result.invocation
        }
      };
    } catch (error) {
      await emitProgress(dependencies, { stage: "index-synthesis", status: "failed" });
      throw error;
    }
  };
  const validate: typeof IndexState.Node = async (state) => {
    if (!state.synthesisEnvelope) throw new Error("LangGraph index synthesis produced no envelope.");
    return {
      output: buildStructuredTodayIndex(
        state.input,
        state.synthesisEnvelope,
        state.input.workflowRunId
      )
    };
  };

  const graph = new StateGraph(IndexState)
    .addNode("dispatch-sessions", dispatch)
    .addNode("digest-session", digestSession)
    .addNode("synthesize-index", synthesize)
    .addNode("validate-index", validate)
    .addEdge(START, "dispatch-sessions")
    .addConditionalEdges("dispatch-sessions", routeSessions, ["digest-session"])
    .addEdge("digest-session", "synthesize-index")
    .addEdge("synthesize-index", "validate-index")
    .addEdge("validate-index", END)
    .compile({
      ...(input.checkpointer ? { checkpointer: input.checkpointer } : {}),
      name: "structured-today-index-v1",
      description: "Typed LangGraph fallback for bounded Today Session fan-out and workline synthesis."
    });
  return Object.assign(graph, {
    async registerWorkflowInput(workflowInput: StructuredTodayIndexWorkflowInput, threadId: string): Promise<void> {
      for (const item of workflowInput.sessions) {
        localItems.set(item.session.sessionId, item);
        // SQLite stores the complete frozen input once; recovery resolves this Session from it.
      }
    }
  });
}

interface WorkflowItemStore {
  putWorkflowItem(threadId: string, itemId: string, value: unknown): Promise<void>;
  getWorkflowItem(threadId: string, itemId: string): Promise<unknown | undefined>;
}

function workflowItemStore(checkpointer: BaseCheckpointSaver | undefined): WorkflowItemStore | undefined {
  if (!checkpointer) return undefined;
  const candidate = checkpointer as BaseCheckpointSaver & Partial<WorkflowItemStore>;
  return typeof candidate.putWorkflowItem === "function" && typeof candidate.getWorkflowItem === "function"
    ? candidate as BaseCheckpointSaver & WorkflowItemStore
    : undefined;
}

export function createStructuredTodayLangGraphDossier(input: {
  dependencies: StructuredTodayLangGraphDependencies;
  checkpointer?: BaseCheckpointSaver;
}) {
  const dependencies = input.dependencies;
  const gather: typeof DossierState.Node = async (state) => {
    const workline = state.input.sourceIndex.worklines.find((item) => item.worklineId === state.input.worklineId);
    if (!workline) throw new Error("Selected workline does not belong to the source index.");
    const sessionIds = new Set(workline.sessionIds);
    const requiredEvidence = new Set(workline.evidenceIds);
    const evidence = [...state.input.sourceIndex.evidence, ...state.input.linkedEvidence].filter((item) => {
      if (!requiredEvidence.has(item.evidenceId)) return false;
      return !item.sessionId || sessionIds.has(item.sessionId);
    });
    const present = new Set(evidence.map((item) => item.evidenceId));
    const missing = workline.evidenceIds.filter((id) => !present.has(id));
    if (missing.length > 0) throw new Error(`Selected workline evidence is unavailable: ${missing.join(", ")}`);
    return { gathered: { workline, admittedSessionIds: workline.sessionIds, evidence } };
  };
  const analyze: typeof DossierState.Node = async (state) => {
    if (!state.gathered) throw new Error("Dossier gather node produced no evidence.");
    await emitProgress(dependencies, {
      stage: "dossier-analysis",
      status: "running",
      worklineId: state.input.worklineId
    });
    const result = await dependencies.models.analyzeWorklineDossier({
      editorialContract: state.input.editorialContract,
      worklineJson: JSON.stringify(state.gathered.workline),
      admittedEvidenceJson: JSON.stringify(state.gathered.evidence),
      allowedEvidenceIds: nonEmptyEvidenceIds(state.gathered.evidence.map((item) => item.evidenceId))
    });
    await emitProgress(dependencies, {
      stage: "dossier-analysis",
      status: "ready",
      worklineId: state.input.worklineId
    });
    return { analysisEnvelope: { analysis: result.output, invocation: result.invocation } };
  };
  const critique: typeof DossierState.Node = async (state) => {
    if (!state.gathered || !state.analysisEnvelope) throw new Error("Dossier analysis state is incomplete.");
    await emitProgress(dependencies, {
      stage: "dossier-critique",
      status: "running",
      worklineId: state.input.worklineId
    });
    const result = await dependencies.models.critiqueWorklineDossier({
      editorialContract: state.input.editorialContract,
      analysisJson: JSON.stringify(state.analysisEnvelope.analysis),
      admittedEvidenceJson: JSON.stringify(state.gathered.evidence)
    });
    await emitProgress(dependencies, {
      stage: "dossier-critique",
      status: "ready",
      worklineId: state.input.worklineId
    });
    return {
      critiqueEnvelope: {
        analysis: state.analysisEnvelope.analysis,
        analysisInvocation: state.analysisEnvelope.invocation,
        critique: result.output,
        critiqueInvocation: result.invocation
      }
    };
  };
  const compose: typeof DossierState.Node = async (state) => {
    if (!state.gathered || !state.critiqueEnvelope) throw new Error("Dossier critique state is incomplete.");
    await emitProgress(dependencies, {
      stage: "dossier-compose",
      status: "running",
      worklineId: state.input.worklineId
    });
    const result = await dependencies.models.composeWorklineDossier({
      editorialContract: state.input.editorialContract,
      worklineJson: JSON.stringify(state.gathered.workline),
      analysisJson: JSON.stringify(state.critiqueEnvelope.analysis),
      critiqueJson: JSON.stringify(state.critiqueEnvelope.critique),
      allowedEvidenceIds: nonEmptyEvidenceIds(state.gathered.evidence.map((item) => item.evidenceId))
    });
    await emitProgress(dependencies, {
      stage: "dossier-compose",
      status: "ready",
      worklineId: state.input.worklineId
    });
    return {
      composeEnvelope: {
        ...state.critiqueEnvelope,
        dossier: result.output,
        composeInvocation: result.invocation
      }
    };
  };
  const validate: typeof DossierState.Node = async (state) => {
    if (!state.gathered || !state.composeEnvelope) throw new Error("Dossier composition state is incomplete.");
    return {
      output: buildStructuredTodayDossier(
        state.input,
        state.gathered,
        state.composeEnvelope,
        state.input.workflowRunId
      )
    };
  };

  return new StateGraph(DossierState)
    .addNode("gather-evidence", gather)
    .addNode("analyze-dossier", analyze)
    .addNode("critique-dossier", critique)
    .addNode("compose-dossier", compose)
    .addNode("validate-dossier", validate)
    .addEdge(START, "gather-evidence")
    .addEdge("gather-evidence", "analyze-dossier")
    .addEdge("analyze-dossier", "critique-dossier")
    .addEdge("critique-dossier", "compose-dossier")
    .addEdge("compose-dossier", "validate-dossier")
    .addEdge("validate-dossier", END)
    .compile({
      ...(input.checkpointer ? { checkpointer: input.checkpointer } : {}),
      name: "structured-today-dossier-v1",
      description: "Typed LangGraph fallback for one selected workline dossier."
    });
}

function nonEmptyEvidenceIds(value: string[]): [string, ...string[]] {
  const [first, ...rest] = value;
  if (!first) throw new Error("Structured dossier requires at least one admitted evidence ID.");
  return [first, ...rest];
}

function nonEmptySessionIds(value: string[]): [string, ...string[]] {
  const [first, ...rest] = value;
  if (!first) throw new Error("Structured index synthesis requires at least one successful Session ID.");
  return [first, ...rest];
}

export function createStructuredTodayLangGraphProposals(input: {
  dependencies: StructuredTodayLangGraphDependencies;
  checkpointer?: BaseCheckpointSaver;
}) {
  const arrange: typeof ProposalState.Node = async (state) => {
    await emitProgress(input.dependencies, {
      stage: "proposal-arrange",
      status: "running",
      worklineId: state.input.dossier.worklineId
    });
    try {
      const result = await input.dependencies.models.arrangeReflectionProposals({
        editorialContract: state.input.editorialContract,
        dossierJson: JSON.stringify(state.input.dossier),
        reflectionText: state.input.reflection.text
      });
      await emitProgress(input.dependencies, {
        stage: "proposal-arrange",
        status: "ready",
        worklineId: state.input.dossier.worklineId
      });
      return { candidate: result.output, invocation: result.invocation };
    } catch (error) {
      await emitProgress(input.dependencies, {
        stage: "proposal-arrange",
        status: "failed",
        worklineId: state.input.dossier.worklineId
      });
      throw error;
    }
  };
  const validate: typeof ProposalState.Node = async (state) => {
    if (!state.candidate || !state.invocation) throw new Error("Structured proposal node produced no candidate.");
    return {
      output: {
        artifact: buildStructuredTodayProposalArtifact({
          artifactId: state.input.artifactId,
          revision: state.input.revision,
          logicalDate: state.input.dossier.logicalDate,
          worklineId: state.input.dossier.worklineId,
          dossier: state.input.dossier,
          reflection: state.input.reflection,
          candidate: state.candidate,
          invocation: state.invocation
        })
      }
    };
  };
  return new StateGraph(ProposalState)
    .addNode("arrange-reflection-proposals", arrange)
    .addNode("validate-reflection-proposals", validate)
    .addEdge(START, "arrange-reflection-proposals")
    .addEdge("arrange-reflection-proposals", "validate-reflection-proposals")
    .addEdge("validate-reflection-proposals", END)
    .compile({
      ...(input.checkpointer ? { checkpointer: input.checkpointer } : {}),
      name: "structured-today-proposals-v1",
      description: "Arrange one exact saved reflection into five non-authoritative proposal categories."
    });
}

export function createStructuredTodayLangGraphRuntime(input: {
  storageUrl: string;
  dependencies: StructuredTodayLangGraphDependencies;
}): StructuredTodayLangGraphRuntime {
  const checkpointer = NodeSqliteSaver.fromConnectionString(input.storageUrl);
  return {
    checkpointer,
    indexGraph: createStructuredTodayLangGraphIndex({
      dependencies: input.dependencies,
      checkpointer
    }),
    dossierGraph: createStructuredTodayLangGraphDossier({
      dependencies: input.dependencies,
      checkpointer
    }),
    proposalGraph: createStructuredTodayLangGraphProposals({
      dependencies: input.dependencies,
      checkpointer
    }),
    close: () => checkpointer.close()
  };
}

export async function invokeStructuredTodayLangGraphIndex(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphIndex>;
  workflowInput: StructuredTodayIndexWorkflowInput;
  threadId: string;
  digestConcurrency: number;
}): Promise<StructuredTodayIndexWorkflowOutput | { interrupted: true }> {
  await input.graph.registerWorkflowInput(input.workflowInput, input.threadId);
  const result = await input.graph.invoke(
    { input: input.workflowInput },
    {
      configurable: { thread_id: input.threadId },
      maxConcurrency: positiveConcurrency(input.digestConcurrency)
    }
  );
  if ("__interrupt__" in result) return { interrupted: true };
  if (!result.output) throw new Error("LangGraph index run completed without a structured output.");
  return result.output;
}

export async function resumeStructuredTodayLangGraphIndex(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphIndex>;
  threadId: string;
  digestConcurrency: number;
}): Promise<StructuredTodayIndexWorkflowOutput> {
  const result = await input.graph.invoke(
    new Command({ resume: { continue: true } }),
    {
      configurable: { thread_id: input.threadId },
      maxConcurrency: positiveConcurrency(input.digestConcurrency)
    }
  );
  if (!result.output) throw new Error("LangGraph resumed run completed without a structured output.");
  return result.output;
}

export async function retryStructuredTodayLangGraphIndex(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphIndex>;
  threadId: string;
  digestConcurrency: number;
}): Promise<StructuredTodayIndexWorkflowOutput> {
  const result = await input.graph.invoke(
    null as never,
    {
      configurable: { thread_id: input.threadId },
      maxConcurrency: positiveConcurrency(input.digestConcurrency)
    }
  );
  if (!result.output) throw new Error("LangGraph retried run completed without a structured output.");
  return result.output;
}

export async function invokeStructuredTodayLangGraphDossier(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphDossier>;
  workflowInput: StructuredTodayDossierWorkflowInput;
  threadId: string;
}): Promise<StructuredTodayDossierWorkflowOutput> {
  const result = await input.graph.invoke(
    { input: input.workflowInput },
    { configurable: { thread_id: input.threadId } }
  );
  if (!result.output) throw new Error("LangGraph dossier run completed without a structured output.");
  return result.output;
}

export async function retryStructuredTodayLangGraphDossier(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphDossier>;
  threadId: string;
}): Promise<StructuredTodayDossierWorkflowOutput> {
  const result = await input.graph.invoke(
    null as never,
    { configurable: { thread_id: input.threadId } }
  );
  if (!result.output) throw new Error("LangGraph retried dossier completed without a structured output.");
  return result.output;
}

export async function invokeStructuredTodayLangGraphProposals(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphProposals>;
  workflowInput: StructuredTodayProposalWorkflowInput;
  threadId: string;
}): Promise<StructuredTodayProposalWorkflowOutput> {
  const result = await input.graph.invoke(
    { input: input.workflowInput },
    { configurable: { thread_id: input.threadId } }
  );
  if (!result.output) throw new Error("LangGraph proposal run completed without a structured output.");
  return result.output;
}

export async function retryStructuredTodayLangGraphProposals(input: {
  graph: ReturnType<typeof createStructuredTodayLangGraphProposals>;
  threadId: string;
}): Promise<StructuredTodayProposalWorkflowOutput> {
  const result = await input.graph.invoke(
    null as never,
    { configurable: { thread_id: input.threadId } }
  );
  if (!result.output) throw new Error("LangGraph retried proposals completed without a structured output.");
  return result.output;
}

async function executeDigest(
  item: z.infer<typeof DigestWorkItemSchema>,
  dependencies: StructuredTodayLangGraphDependencies
): Promise<DigestExecutionResultV1> {
  if (item.preDisposition) {
    await emitProgress(dependencies, {
      stage: "digest",
      status: item.preDisposition.kind,
      sessionId: item.session.sessionId
    });
    return item.preDisposition.kind === "excluded"
      ? {
          status: "excluded",
          sessionId: item.session.sessionId,
          reason: item.preDisposition.reason
        }
      : {
          status: "failed",
          sessionId: item.session.sessionId,
          reason: item.preDisposition.reason
        };
  }
  await emitProgress(dependencies, { stage: "digest", status: "running", sessionId: item.session.sessionId });
  try {
    const result = await dependencies.models.digestSession({
      logicalDate: item.logicalDate,
      editorialContract: item.editorialContract,
      expectedSessionId: item.session.sessionId,
      allowedEvidenceIds: nonEmptyEvidenceIds(item.evidence.map((evidence) => evidence.evidenceId)),
      sessionEvidenceJson: JSON.stringify({
        session: item.session,
        evidence: item.evidence,
        evidenceText: item.evidenceText
      })
    });
    if (result.output.sessionId !== item.session.sessionId) {
      throw new Error(`Digest changed Session ID from ${item.session.sessionId} to ${result.output.sessionId}.`);
    }
    const allowedEvidence = new Set(item.evidence.map((evidence) => evidence.evidenceId));
    const invented = result.output.evidenceIds.find((id) => !allowedEvidence.has(id));
    if (invented) throw new Error(`Digest invented evidence ID ${invented}.`);
    await emitProgress(dependencies, { stage: "digest", status: "ready", sessionId: item.session.sessionId });
    const digest = enforceDigestParticipationAuthority(result.output, item.session.lineage?.origin);
    return {
      status: "success",
      nodeOutputId: result.invocation.invocationId,
      digest,
      invocation: result.invocation
    };
  } catch (error) {
    await emitProgress(dependencies, { stage: "digest", status: "failed", sessionId: item.session.sessionId });
    return {
      status: "failed",
      sessionId: item.session.sessionId,
      reason: boundedError(error)
    };
  }
}

function enforceDigestParticipationAuthority(
  digest: SessionDigestCandidate,
  origin: "primary" | "subagent" | "automation" | "unknown" | undefined
) {
  if (origin === "primary") return digest;
  if (!digest) return digest;
  const participation = digest.participation;
  if (!participation.human && !participation.joint) return digest;
  return {
    ...digest,
    participation: {
      human: null,
      joint: null,
      agent: participation.agent ?? null,
      undeterminedReason: participation.agent
        ? null
        : "该记录不具备真人参与权威；子 Agent、自动化或来源不明的消息不能归因给用户。"
    }
  };
}

function enforceWorklineParticipationAuthority(
  candidate: WorklineSynthesisCandidate,
  digests: SessionDigestCandidate[]
): WorklineSynthesisCandidate {
  const humanAuthority = new Set(digests
    .filter((digest) => digest.participation.human || digest.participation.joint)
    .map((digest) => digest.sessionId));
  return {
    ...candidate,
    worklines: candidate.worklines.map((workline) => {
      if (workline.sessionIds.some((sessionId) => humanAuthority.has(sessionId))) return workline;
      if (!workline.participation.human && !workline.participation.joint) return workline;
      return {
        ...workline,
        participation: {
          human: null,
          joint: null,
          agent: workline.participation.agent ?? null,
          undeterminedReason: workline.participation.agent
            ? null
            : "这条工作线没有具备真人参与权威的主会话证据。"
        }
      };
    })
  };
}

function isSuccessfulDigest(
  result: DigestExecutionResultV1
): result is Extract<DigestExecutionResultV1, { status: "success" }> {
  return result.status === "success";
}

async function emitProgress(
  dependencies: StructuredTodayLangGraphDependencies,
  progress: StructuredTodayWorkflowProgressV1
): Promise<void> {
  await dependencies.onProgress?.(progress);
}

function positiveConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error("digestConcurrency must be an integer between 1 and 32.");
  }
  return value;
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "Unknown model-node failure.";
}
