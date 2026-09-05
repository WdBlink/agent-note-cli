import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TASKS } from "@langchain/langgraph-checkpoint";
import {
  EditorialContractBindingSchema,
  TodayWorklineIndexSchema,
  sha256Text,
  type DossierAnalysisCandidate,
  type DossierCandidate,
  type DossierCritiqueCandidate,
  type SessionDigestCandidate,
  type StructuredTodayIndexWorkflowInput,
  type StructuredTodayModelInvocationV1,
  type WorklineSynthesisCandidate
} from "../src/structured-today-contracts";
import type {
  StructuredTodayModelFunctions,
  StructuredTodayModelResult
} from "../src/structured-today-model-functions";
import { createStructuredTodayModelFunctions } from "../src/structured-today-model-functions";
import { validateStructuredTodayIndex } from "../src/structured-today-artifacts";
import {
  createStructuredTodayLangGraphIndex,
  createStructuredTodayLangGraphRuntime,
  invokeStructuredTodayLangGraphDossier,
  invokeStructuredTodayLangGraphIndex,
  resumeStructuredTodayLangGraphIndex,
  retryStructuredTodayLangGraphIndex
} from "../src/structured-today-langgraph";

test("strict index schema rejects a missing required structured field", () => {
  const malformed = {
    schema: "today-workline-index/v1",
    artifactId: "index",
    revision: 1,
    logicalDate: "2026-08-29"
  };
  assert.equal(TodayWorklineIndexSchema.safeParse(malformed).success, false);
});

test("structured model boundary injects the canonical contract and rejects malformed provider output", async () => {
  const contract = editorialContract();
  const calls: Array<{ variables: Record<string, string>; outputJsonSchema: Record<string, unknown> }> = [];
  const models = createStructuredTodayModelFunctions({
    call: async (input) => {
      calls.push({ variables: input.variables, outputJsonSchema: input.outputJsonSchema });
      return {
        output: {
          sessionId: "session-1",
          summary: "A valid digest",
          currentStop: "Ready for synthesis",
          participation: { agent: "Agent performed the implementation." },
          evidenceIds: ["evidence-1"],
          uncertainties: []
        },
        invocationId: "structured-call-1",
        provider: "fixture-provider",
        model: "fixture-model"
      };
    }
  });
  const result = await models.digestSession({
    logicalDate: "2026-08-29",
    editorialContract: contract,
    sessionEvidenceJson: "{}",
    expectedSessionId: "session-1",
    allowedEvidenceIds: ["evidence-1"]
  });
  assert.equal(result.output.sessionId, "session-1");
  assert.equal(calls[0]?.variables.editorialContract, contract.text);
  assert.equal(calls[0]?.variables.editorialContractHash, contract.ref.editorialContractHash);
  assert.equal(typeof calls[0]?.outputJsonSchema, "object");

  const malformed = createStructuredTodayModelFunctions({
    call: async () => ({
      output: { sessionId: "session-1" },
      invocationId: "structured-call-invalid",
      provider: "fixture-provider",
      model: "fixture-model"
    })
  });
  await assert.rejects(() => malformed.digestSession({
    logicalDate: "2026-08-29",
    editorialContract: contract,
    sessionEvidenceJson: "{}",
    expectedSessionId: "session-1",
    allowedEvidenceIds: ["evidence-1"]
  }));
});

test("LangGraph fallback preserves bounded dynamic fan-out and total disposition", async () => {
  const fake = fakeModels();
  const graph = createStructuredTodayLangGraphIndex({
    dependencies: { models: fake.models }
  });
  const result = await invokeStructuredTodayLangGraphIndex({
    graph,
    workflowInput: indexInput(5),
    threadId: "langgraph-bounded-fanout",
    digestConcurrency: 2
  });

  assert.equal("interrupted" in result, false);
  if ("interrupted" in result) return;
  assert.equal(result.publishable, true);
  assert.equal(result.artifact.dispositions.length, 5);
  assert.equal(result.artifact.coverage.assigned, 5);
  assert.equal(fake.state.maxDigestConcurrency, 2);
  assert.equal(fake.state.dossierCalls, 0);
  assert.deepEqual(validateStructuredTodayIndex(result.artifact), []);
});

test("LangGraph keeps a failed digest explicit and refuses complete publication", async () => {
  const fake = fakeModels({ failDigestSessionIds: new Set(["session-2"]) });
  const graph = createStructuredTodayLangGraphIndex({ dependencies: { models: fake.models } });
  const result = await invokeStructuredTodayLangGraphIndex({
    graph,
    workflowInput: indexInput(3),
    threadId: "langgraph-failed-digest",
    digestConcurrency: 3
  });
  assert.equal("interrupted" in result, false);
  if ("interrupted" in result) return;
  assert.equal(result.publishable, false);
  assert.equal(result.artifact.coverage.failed, 1);
  assert.equal(result.artifact.coverage.complete, false);
  assert.deepEqual(
    result.artifact.dispositions.filter((item) => item.kind === "failed").map((item) => item.sessionId),
    ["session-2"]
  );
});

test("subagent-only evidence cannot create human or joint participation", async () => {
  const workflowInput = indexInput(1);
  workflowInput.sessions[0]!.session.lineage = {
    origin: "subagent",
    parentSessionId: "root-session",
    agentPath: "/root/radar_pipeline"
  };
  const fake = fakeModels({ inventHumanParticipation: true });
  const graph = createStructuredTodayLangGraphIndex({ dependencies: { models: fake.models } });
  const result = await invokeStructuredTodayLangGraphIndex({
    graph,
    workflowInput,
    threadId: "subagent-authority-gate",
    digestConcurrency: 1
  });
  assert.equal("interrupted" in result, false);
  if ("interrupted" in result) return;
  const participation = result.artifact.worklines[0]?.participation;
  assert.equal(participation?.status, "described");
  if (participation?.status !== "described") return;
  assert.equal(participation.human, undefined);
  assert.equal(participation.joint, undefined);
  assert.match(participation.agent ?? "", /Agent/);
});

test("LangGraph built-in SQLite checkpointer resumes without repeating completed Send nodes", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "structured-today-langgraph-"));
  const storageUrl = `file:${path.join(temporaryRoot, "checkpoints.db")}`;
  const fake = fakeModels();
  const workflowInput = { ...indexInput(4), pauseBeforeSynthesis: true };

  try {
    const firstRuntime = createStructuredTodayLangGraphRuntime({
      storageUrl,
      dependencies: { models: fake.models }
    });
    const interrupted = await invokeStructuredTodayLangGraphIndex({
      graph: firstRuntime.indexGraph,
      workflowInput,
      threadId: "langgraph-resume-after-digests",
      digestConcurrency: 2
    });
    assert.deepEqual(interrupted, { interrupted: true });
    assert.equal(fake.state.digestCalls, 4);
    const taskPayloads: unknown[] = [];
    for await (const checkpoint of firstRuntime.checkpointer.list(
      { configurable: { thread_id: "langgraph-resume-after-digests" } },
      { limit: 100 }
    )) {
      for (const write of checkpoint.pendingWrites ?? []) {
        if (write[1] === TASKS) taskPayloads.push(write[2]);
      }
    }
    assert.ok(taskPayloads.length > 0);
    const serializedTasks = JSON.stringify(taskPayloads);
    assert.match(serializedTasks, /currentDigestSessionId/u);
    assert.doesNotMatch(serializedTasks, /evidenceText|workflowRunId|editorialContract/u);
    firstRuntime.close();

    const secondRuntime = createStructuredTodayLangGraphRuntime({
      storageUrl,
      dependencies: { models: fake.models }
    });
    const resumed = await resumeStructuredTodayLangGraphIndex({
      graph: secondRuntime.indexGraph,
      threadId: "langgraph-resume-after-digests",
      digestConcurrency: 2
    });
    assert.equal(resumed.publishable, true);
    assert.equal(fake.state.digestCalls, 4);
    assert.equal(fake.state.synthesisCalls, 1);
    const history = [];
    for await (const checkpoint of secondRuntime.checkpointer.list(
      { configurable: { thread_id: "langgraph-resume-after-digests" } },
      { limit: 2 }
    )) {
      history.push(checkpoint);
    }
    assert.equal(history.length, 2);
    await secondRuntime.checkpointer.deleteThread("langgraph-resume-after-digests");
    assert.equal(
      await secondRuntime.checkpointer.getTuple({ configurable: { thread_id: "langgraph-resume-after-digests" } }),
      undefined
    );
    secondRuntime.close();
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("retrying the same failed synthesis thread reuses completed Send digest writes", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "structured-today-langgraph-retry-"));
  const storageUrl = `file:${path.join(temporaryRoot, "checkpoints.db")}`;
  const fake = fakeModels({ failSynthesisAttempts: 1 });
  const workflowInput = indexInput(3);
  try {
    const first = createStructuredTodayLangGraphRuntime({ storageUrl, dependencies: { models: fake.models } });
    await assert.rejects(() => invokeStructuredTodayLangGraphIndex({
      graph: first.indexGraph,
      workflowInput,
      threadId: workflowInput.workflowRunId,
      digestConcurrency: 2
    }), /forced synthesis failure/);
    assert.equal(fake.state.digestCalls, 3);
    first.close();

    const second = createStructuredTodayLangGraphRuntime({ storageUrl, dependencies: { models: fake.models } });
    const retried = await retryStructuredTodayLangGraphIndex({
      graph: second.indexGraph,
      threadId: workflowInput.workflowRunId,
      digestConcurrency: 2
    });
    assert.equal("interrupted" in retried, false);
    assert.equal(fake.state.digestCalls, 3);
    assert.equal(fake.state.synthesisCalls, 2);
    second.close();
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("LangGraph fallback keeps dossier workline-scoped", async () => {
  const fake = fakeModels();
  const runtime = createStructuredTodayLangGraphRuntime({
    storageUrl: ":memory:",
    dependencies: { models: fake.models }
  });
  try {
    const index = await invokeStructuredTodayLangGraphIndex({
      graph: runtime.indexGraph,
      workflowInput: indexInput(2),
      threadId: "langgraph-dossier-index",
      digestConcurrency: 2
    });
    assert.equal("interrupted" in index, false);
    if ("interrupted" in index) return;
    const selected = index.artifact.worklines[0]!;
    const other = index.artifact.worklines[1]!;
    const dossier = await invokeStructuredTodayLangGraphDossier({
      graph: runtime.dossierGraph,
      workflowInput: {
      workflowRunId: "langgraph-selected-dossier",
      artifactId: `structured-today-dossier-${selected.worklineId}`,
      revision: 1,
        editorialContract: editorialContract(),
        sourceIndex: index.artifact,
        worklineId: selected.worklineId,
        linkedEvidence: []
      },
      threadId: "langgraph-selected-dossier"
    });
    assert.equal(dossier.publishable, true);
    const admitted = JSON.stringify(fake.state.lastDossierEvidence);
    assert.equal(admitted.includes(selected.evidenceIds[0]!), true);
    assert.equal(admitted.includes(other.evidenceIds[0]!), false);
  } finally {
    runtime.close();
  }
});

function editorialContract() {
  const text = "Traceink editorial contract fixture: preserve evidence, uncertainty, and human authority.";
  return EditorialContractBindingSchema.parse({
    ref: {
      packageId: "traceink",
      version: "fixture-v1",
      editorialContractHash: sha256Text(text)
    },
    text
  });
}

function indexInput(sessionCount: number): StructuredTodayIndexWorkflowInput {
  const contract = editorialContract();
  const sessions = Array.from({ length: sessionCount }, (_, offset) => {
    const ordinal = offset + 1;
    const sessionId = `session-${ordinal}`;
    const evidenceId = `evidence-${ordinal}`;
    const evidence = {
      evidenceId,
      sourceKind: "session" as const,
      provider: "codex" as const,
      sessionId,
      sourcePath: `/provider/session-${ordinal}.jsonl`,
      range: "messages:1-5",
      contentHash: sha256Text(`session-${ordinal}`)
    };
    return {
      logicalDate: "2026-08-29",
      editorialContract: contract,
      session: {
        sessionId,
        provider: "codex" as const,
        sourcePath: evidence.sourcePath,
        title: `Session ${ordinal}`,
        startedAt: `2026-08-29T0${ordinal}:00:00.000Z`,
        endedAt: `2026-08-29T0${ordinal}:30:00.000Z`,
        evidenceIds: [evidenceId]
      },
      evidence: [evidence],
      evidenceText: `Session ${ordinal} produced observable work evidence.`
    };
  });
  return StructuredTodayIndexWorkflowInputSchemaFixture({
    logicalDate: "2026-08-29",
    workflowRunId: "fixture-index-run",
    artifactId: "structured-today-index-2026-08-29",
    revision: 1,
    evidenceManifestId: "manifest-2026-08-29",
    editorialContract: contract,
    sessions,
    evidence: sessions.flatMap((item) => item.evidence)
  });
}

function StructuredTodayIndexWorkflowInputSchemaFixture(
  input: StructuredTodayIndexWorkflowInput
): StructuredTodayIndexWorkflowInput {
  return input;
}

function fakeModels(options: { failDigestSessionIds?: Set<string>; failSynthesisAttempts?: number; inventHumanParticipation?: boolean } = {}) {
  const state = {
    digestCalls: 0,
    synthesisCalls: 0,
    dossierCalls: 0,
    activeDigests: 0,
    maxDigestConcurrency: 0,
    lastDossierEvidence: undefined as unknown
  };

  const models: StructuredTodayModelFunctions = {
    async digestSession(input) {
      state.digestCalls += 1;
      state.activeDigests += 1;
      state.maxDigestConcurrency = Math.max(state.maxDigestConcurrency, state.activeDigests);
      const parsed = JSON.parse(input.sessionEvidenceJson) as {
        session: { sessionId: string; evidenceIds: string[] };
      };
      await delay(8);
      state.activeDigests -= 1;
      if (options.failDigestSessionIds?.has(parsed.session.sessionId)) {
        throw new Error(`forced digest failure for ${parsed.session.sessionId}`);
      }
      const output: SessionDigestCandidate = {
        sessionId: parsed.session.sessionId,
        summary: `Digest for ${parsed.session.sessionId}`,
        currentStop: `Current stop for ${parsed.session.sessionId}`,
        participation: options.inventHumanParticipation
          ? { human: "User planned this child task.", joint: "User and child Agent collaborated.", agent: "Agent produced the observable implementation work." }
          : { agent: "Agent produced the observable implementation work." },
        evidenceIds: parsed.session.evidenceIds,
        uncertainties: []
      };
      return result("DigestSession", output);
    },
    async synthesizeWorklineIndex(input) {
      state.synthesisCalls += 1;
      if (state.synthesisCalls <= (options.failSynthesisAttempts ?? 0)) {
        throw new Error("forced synthesis failure");
      }
      const digests = JSON.parse(input.sessionDigestsJson) as SessionDigestCandidate[];
      const output: WorklineSynthesisCandidate = {
        worklines: digests.map((digest, index) => ({
          worklineId: `workline-${digest.sessionId}`,
          title: `Workline ${digest.sessionId}`,
          summary: digest.summary,
          startedAt: `2026-08-29T0${index + 1}:00:00.000Z`,
          endedAt: `2026-08-29T0${index + 1}:30:00.000Z`,
          currentStop: digest.currentStop,
          possibleChange: "The implementation direction may now be testable.",
          participation: options.inventHumanParticipation
            ? { human: "User participation inferred from child activity.", joint: "Joint work inferred from volume.", agent: "Agent produced the observable implementation work." }
            : digest.participation,
          evidenceReadiness: "ready",
          sessionIds: [digest.sessionId],
          evidenceIds: digest.evidenceIds,
          extensions: []
        })),
        assignments: digests.map((digest) => ({
          sessionId: digest.sessionId,
          worklineIds: [`workline-${digest.sessionId}`]
        })),
        unresolvedSessionIds: []
      };
      return result("SynthesizeWorklineIndex", output);
    },
    async analyzeWorklineDossier(input) {
      state.dossierCalls += 1;
      state.lastDossierEvidence = JSON.parse(input.admittedEvidenceJson);
      const evidence = state.lastDossierEvidence as Array<{ evidenceId: string }>;
      const output: DossierAnalysisCandidate = {
        priorContext: "The structured producer had not yet been cut over.",
        whatHappened: "The selected workline was reconstructed from admitted evidence.",
        possibleChange: "The workflow boundary may now be reliable.",
        supportingEvidence: [{ claim: "The selected Session was processed.", evidenceIds: [evidence[0]!.evidenceId] }],
        opposingEvidence: [],
        falsifiableObservation: "A forced restart must not increase completed digest calls.",
        gaps: []
      };
      return result("AnalyzeWorklineDossier", output);
    },
    async critiqueWorklineDossier(input) {
      state.dossierCalls += 1;
      const analysis = JSON.parse(input.analysisJson) as DossierAnalysisCandidate;
      const output: DossierCritiqueCandidate = {
        acceptable: true,
        issues: [],
        missingEvidenceIds: analysis.supportingEvidence.flatMap((claim) => claim.evidenceIds).filter(() => false)
      };
      return result("CritiqueWorklineDossier", output);
    },
    async composeWorklineDossier(input) {
      state.dossierCalls += 1;
      const analysis = JSON.parse(input.analysisJson) as DossierAnalysisCandidate;
      const evidenceIds = [...new Set([
        ...analysis.supportingEvidence.flatMap((claim) => claim.evidenceIds),
        ...analysis.opposingEvidence.flatMap((claim) => claim.evidenceIds)
      ])];
      const output: DossierCandidate = {
        title: "Selected workline dossier",
        ...analysis,
        humanQuestion: "Does this evidence justify adopting the proposed backend direction?",
        evidenceIds,
        extensions: []
      };
      return result("ComposeWorklineDossier", output);
    },
    async arrangeReflectionProposals(input) {
      const sourceQuote = input.reflectionText;
      return result("ArrangeReflectionProposals", {
        proposals: ["judgment", "tomorrow", "ctx", "background", "today-only"].map((category) => ({
          category: category as "judgment" | "tomorrow" | "ctx" | "background" | "today-only",
          proposalText: `${category} proposal`,
          sourceQuote,
          evidenceIds: []
        }))
      });
    }
  };
  return { models, state };
}

function result<T>(
  functionName: StructuredTodayModelInvocationV1["functionName"],
  output: T
): StructuredTodayModelResult<T> {
  const invocation: StructuredTodayModelInvocationV1 = {
    invocationId: `${functionName}-${Math.random().toString(16).slice(2)}`,
    provider: "fixture-provider",
    model: "fixture-model",
    functionName,
    functionVersion: `${functionName}/fixture-v1`
  };
  return { output, invocation };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
