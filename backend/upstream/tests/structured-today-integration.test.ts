import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CliRunner } from "../src/agent-summary";
import { StructuredTodayRuntimeStore } from "../app/desktop/structured-today-runtime-store";
import { NodeSqliteSaver } from "../src/langgraph-node-sqlite-checkpointer";
import { projectStructuredTodayReview } from "../src/structured-today-review-state";
import type { AgentWorkSession, AgentWorkSnapshot, CockpitSettings } from "../src/types";
import {
  createTraceinkAssetRepository
} from "../app/desktop/traceink-asset-repository";
import {
  activeStructuredTodayIndexReferenceForDate,
  appendStructuredTodayProposalDisposition,
  appendStructuredTodayReflectionRevision,
  appendStructuredTodayIndexRevision,
  latestStructuredTodayDossier,
  latestStructuredTodayProposalDispositions,
  latestStructuredTodayProposals,
  latestStructuredTodayReflection,
  structuredTodayDossierReference,
  structuredTodayReflectionReference
} from "../app/desktop/traceink-asset-store";
import {
  runStructuredTodayDossierPreparation,
  runStructuredTodayIndexPreparation,
  runStructuredTodayProposalPreparation
} from "../app/desktop/structured-today-runtime";
import { createStructuredTodayCitationTargets } from "../app/desktop/structured-today-citations";
import { buildStructuredTodayIndexInput } from "../app/desktop/structured-today-input";
import { loadStructuredTodayEditorialContract } from "../src/structured-today-model-functions";
import { authorizeSessionTranscriptRequest } from "../app/desktop/session-transcript-access";
import { createEmptyNotebookDocument, normalizeNotebookDocument, sealStructuredTodayPage } from "../app/desktop/notebook-store";

const logicalDate = "2026-08-29";

test("real T049 path freezes evidence, commits a structured index, and prepares only the selected dossier", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "structured-today-integration-"));
  const transcriptPath = path.join(temporaryRoot, "session.jsonl");
  const transcript = [
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-29T01:00:00.000Z",
      payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "重构 Today 后端。" }] }
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-29T01:10:00.000Z",
      payload: { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "实现结构化 workflow。" }] }
    })
  ].join("\n");
  await fs.writeFile(transcriptPath, transcript, "utf8");
  const session = capturedSession(transcriptPath, transcript);
  const snapshot: AgentWorkSnapshot = {
    date: logicalDate,
    generatedAt: "2026-08-29T02:00:00.000Z",
    sessions: [session],
    sources: [transcriptPath],
    warnings: []
  };
  const repository = createTraceinkAssetRepository({
    filePath: path.join(temporaryRoot, "traceink-assets-v1.json")
  });
  const checkpointer = NodeSqliteSaver.fromConnectionString(":memory:");
  const runtimeStore = new StructuredTodayRuntimeStore(":memory:");
  const prompts: string[] = [];
  const delegate = structuredRunner();
  let rejectProposalOnce = true;
  const runner: CliRunner = async (request) => {
    prompts.push(request.stdin);
    const result = await delegate(request);
    if (request.stdin.includes("Arrange the user") && rejectProposalOnce) {
      rejectProposalOnce = false;
      const envelope = JSON.parse(result.stdout);
      const output = JSON.parse(envelope.item.text);
      output.proposals[0].sourceQuote = "invented human reflection";
      envelope.item.text = JSON.stringify(output);
      return { ...result, stdout: JSON.stringify(envelope) };
    }
    return result;
  };
  try {
    await repository.load();
    const indexResult = await runStructuredTodayIndexPreparation({
      logicalDate,
      snapshot,
      settings: settings(),
      repository,
      checkpointer,
      runtimeStore,
      runner
    });
    assert.equal(indexResult.artifact.worklines.length, 1);
    assert.equal(indexResult.artifact.worklines[0]?.sessionIds[0], session.id);
    assert.equal(indexResult.artifact.coverage.complete, true);
    assert.equal(
      await checkpointer.getTuple({ configurable: { thread_id: indexResult.artifact.workflowRunId } }),
      undefined,
      "published index checkpoint is cleaned after immutable artifact persistence"
    );
    assert.deepEqual(activeStructuredTodayIndexReferenceForDate(repository.snapshot(), logicalDate), indexResult.reference);
    assert.equal(repository.snapshot().artifacts.length, 0, "legacy Traceink artifacts remain untouched");
    const evidence = indexResult.artifact.evidence[0]!;
    const authorized = authorizeSessionTranscriptRequest({
      id: session.id,
      platform: session.platform,
      path: transcriptPath,
      structuredTodayRef: {
        ...indexResult.reference,
        logicalDate,
        evidenceId: evidence.evidenceId
      }
    }, [session], createEmptyNotebookDocument(), repository.snapshot());
    assert.equal(authorized.origin, "traceink-asset");
    assert.equal(authorized.transcriptCapture?.sha256, session.transcriptCapture?.sha256);

    const projection = projectStructuredTodayReview(repository.snapshot(), logicalDate, [session]);
    assert.equal(projection.mode, "compiled");
    assert.equal(projection.worklines[0]?.dossier, undefined);

    const worklineId = indexResult.artifact.worklines[0]!.worklineId;
    const beforeDossier = prompts.length;
    await fs.rm(transcriptPath);
    await assert.rejects(runStructuredTodayDossierPreparation({ logicalDate, indexReference: indexResult.reference,
      worklineId, settings: settings(), repository, checkpointer, runtimeStore, runner }), /ENOENT/);
    assert.equal(prompts.length, beforeDossier, "missing frozen source must fail before model calls");
    await fs.writeFile(transcriptPath, transcript + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "LATER_APPEND_NOT_ADMITTED" } }));
    const dossier = await runStructuredTodayDossierPreparation({
      logicalDate,
      indexReference: indexResult.reference,
      worklineId,
      settings: settings(),
      repository,
      checkpointer,
      runtimeStore,
      runner
    });
    assert.equal(prompts.length - beforeDossier, 3);
    for (const prompt of prompts.slice(beforeDossier)) {
      assert.ok(prompt.includes("重构 Today 后端。"));
      assert.ok(!prompt.includes("LATER_APPEND_NOT_ADMITTED"));
    }
    assert.equal(dossier.worklineId, worklineId);
    assert.equal(await checkpointer.getTuple({ configurable: { thread_id: dossier.workflowRunId } }), undefined);
    assert.deepEqual(dossier.admittedSessionIds, [session.id]);
    assert.equal(latestStructuredTodayDossier(repository.snapshot(), indexResult.reference, worklineId)?.content.humanQuestion, dossier.content.humanQuestion);

    const reflectionText = "我确认结构化工作线能够重开，但仍需验证完整封页。";
    await repository.mutate((document) => appendStructuredTodayReflectionRevision(
      document,
      dossier,
      reflectionText,
      "2026-08-29T03:00:00.000Z"
    ));
    const reflection = latestStructuredTodayReflection(repository.snapshot(), dossier)!;
    assert.equal(reflection.text, reflectionText);
    const reflectionCount = repository.snapshot().structuredReflections?.length;
    await repository.mutate((document) => appendStructuredTodayReflectionRevision(
      document,
      dossier,
      reflectionText,
      "2026-08-29T03:01:00.000Z"
    ));
    assert.equal(repository.snapshot().structuredReflections?.length, reflectionCount);
    assert.equal(latestStructuredTodayReflection(repository.snapshot(), dossier)?.revision, 1);
    await assert.rejects(runStructuredTodayProposalPreparation({ logicalDate, indexReference: indexResult.reference,
      worklineId, reflection, settings: settings(), repository, checkpointer, runtimeStore, runner }), /sourceQuote/);
    const proposals = await runStructuredTodayProposalPreparation({
      logicalDate,
      indexReference: indexResult.reference,
      worklineId,
      reflection,
      settings: settings(),
      repository,
      checkpointer,
      runtimeStore,
      runner
    });
    assert.deepEqual(new Set(proposals.proposals.map((proposal) => proposal.category)), new Set([
      "judgment", "tomorrow", "ctx", "background", "today-only"
    ]));
    for (const proposal of proposals.proposals) {
      await repository.mutate((document) => appendStructuredTodayProposalDisposition(
        document,
        proposals,
        proposal.proposalId,
        { action: "accept", decidedAt: "2026-08-29T03:10:00.000Z" }
      ));
    }
    const dispositions = latestStructuredTodayProposalDispositions(repository.snapshot(), proposals);
    assert.equal(dispositions.length, 5);
    assert.deepEqual(
      runtimeStore.listRuns().map((run) => [run.kind, run.status]),
      [["index", "ready"], ["dossier", "ready"], ["proposals", "ready"]]
    );
    const sealed = sealStructuredTodayPage(
      createEmptyNotebookDocument(),
      logicalDate,
      indexResult.artifact,
      [reflection],
      {
        index: indexResult.reference,
        dossiers: [{ ...structuredTodayDossierReference(dossier), worklineId }],
        reflections: [{ ...structuredTodayReflectionReference(reflection), worklineId }],
        proposals: [{ artifactId: proposals.artifactId, revision: proposals.revision, contentHash: proposals.contentHash, worklineId }],
        dispositions: dispositions.map((item) => ({ dispositionId: item.dispositionId, revision: item.revision, proposalId: item.proposalId }))
      },
      [],
      [],
      new Date("2026-08-29T03:20:00.000Z")
    );
    const normalizedSealed = normalizeNotebookDocument(JSON.parse(JSON.stringify(sealed)));
    assert.equal(normalizedSealed.pages[logicalDate]?.schemaVersion, 4);
    assert.equal(normalizedSealed.pages[logicalDate]?.structuredCloseout?.dispositions.length, 5);

    const revisedReflectionText = `${reflectionText} 我补充了第二版理解。`;
    await repository.mutate((document) => appendStructuredTodayReflectionRevision(
      document,
      dossier,
      revisedReflectionText,
      "2026-08-29T03:30:00.000Z"
    ));
    const revisedReflection = latestStructuredTodayReflection(repository.snapshot(), dossier)!;
    assert.equal(revisedReflection.revision, 2);
    assert.equal(revisedReflection.text, revisedReflectionText);
    const proposalGate = gatedProposalRunner(runner);
    const revisedProposalPromise = runStructuredTodayProposalPreparation({
      logicalDate,
      indexReference: indexResult.reference,
      worklineId,
      reflection: revisedReflection,
      settings: settings(),
      repository,
      checkpointer,
      runtimeStore,
      runner: proposalGate.runner
    });
    await proposalGate.entered;
    try {
      await repository.mutate((document) => appendStructuredTodayReflectionRevision(
        document,
        dossier,
        revisedReflectionText,
        "2026-08-29T03:31:00.000Z"
      ));
      assert.equal(latestStructuredTodayReflection(repository.snapshot(), dossier)?.revision, 2);
    } finally {
      proposalGate.release();
    }
    const revisedProposals = await revisedProposalPromise;
    assert.notEqual(revisedProposals.artifactId, proposals.artifactId);
    assert.equal(revisedProposals.sourceReflection.revision, 2);

    const reopened = createTraceinkAssetRepository({
      filePath: path.join(temporaryRoot, "traceink-assets-v1.json")
    });
    await reopened.load();
    assert.equal(projectStructuredTodayReview(reopened.snapshot(), logicalDate, [session]).worklines[0]?.dossier?.artifactId, dossier.artifactId);
    assert.equal(latestStructuredTodayProposals(reopened.snapshot(), reflection)?.artifactId, proposals.artifactId);
    assert.equal(latestStructuredTodayProposals(reopened.snapshot(), revisedReflection)?.artifactId, revisedProposals.artifactId);

    assert.throws(
      () => appendStructuredTodayIndexRevision(
        repository.snapshot(),
        indexResult.artifact,
        indexResult.reference
      ),
      /identity or revision/
    );
  } finally {
    checkpointer.close();
    runtimeStore.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("structured input keeps missing transcript capture as an explicit failed disposition candidate", async () => {
  const editorialContract = await loadStructuredTodayEditorialContract();
  const session: AgentWorkSession = {
    id: "missing-capture",
    platform: "codex",
    title: "Missing capture",
    summary: "metadata only",
    path: "/tmp/missing-capture.jsonl",
    updatedAt: "2026-08-29T02:00:00.000Z",
    artifacts: [],
    status: "unknown"
  };
  const result = await buildStructuredTodayIndexInput({
    logicalDate,
    snapshot: {
      date: logicalDate,
      generatedAt: "2026-08-29T02:00:00.000Z",
      sessions: [session],
      sources: [],
      warnings: []
    },
    editorialContract,
    artifactId: `structured-today-index-${logicalDate}`,
    revision: 1,
    workflowRunId: "missing-capture-run"
  });
  assert.equal(result.sessions[0]?.preDisposition?.kind, "failed");
  assert.match(result.sessions[0]?.preDisposition?.reason ?? "", /transcript capture/);
});

test("structured input digests one primary Session family and embeds child-Agent execution evidence", async () => {
  const rootText = JSON.stringify({
    timestamp: "2026-08-29T01:00:00.000Z",
    type: "response_item",
    payload: { type: "message", id: "root-user", role: "user", content: [{ type: "input_text", text: "主会话任务" }] }
  });
  const childText = JSON.stringify({
    timestamp: "2026-08-29T01:05:00.000Z",
    type: "response_item",
    payload: { type: "message", id: "child-task", role: "user", content: [{ type: "input_text", text: "子 Agent 规划" }] }
  });
  const root = { ...capturedSession("/tmp/root.jsonl", rootText), lineage: { origin: "primary" as const } };
  const child: AgentWorkSession = {
    ...capturedSession("/tmp/child.jsonl", childText),
    id: "child-1",
    lineage: { origin: "subagent", parentSessionId: root.id, agentPath: "/root/research" }
  };
  const editorialContract = await loadStructuredTodayEditorialContract();
  const result = await buildStructuredTodayIndexInput({
    logicalDate,
    snapshot: {
      date: logicalDate,
      generatedAt: "2026-08-29T02:00:00.000Z",
      sessions: [child, root],
      sources: [],
      warnings: []
    },
    editorialContract,
    artifactId: `structured-today-index-${logicalDate}`,
    revision: 1,
    workflowRunId: "family-run",
    readTranscript: async (sourcePath) => ({
      content: sourcePath === root.path ? rootText : childText,
      truncated: false
    })
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.session.sessionId, root.id);
  const evidence = JSON.parse(result.sessions[0]!.evidenceText) as {
    family: { primarySessionId: string; childSessionIds: string[] };
    messages: Array<{ familySessionId: string; authorKind: string; content: string }>;
  };
  assert.deepEqual(evidence.family, { primarySessionId: root.id, childSessionIds: [child.id] });
  assert.equal(evidence.messages.some((message) =>
    message.familySessionId === child.id && message.authorKind === "agent" && message.content === "子 Agent 规划"
  ), true);
  assert.equal(result.evidence.some((item) =>
    item.sourceKind === "linked-material" && item.evidenceId === "family-child:codex:child-1"
  ), true);
});

test("a primary family with child-Agent evidence invokes one digest and remains compiled", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "structured-today-family-runtime-"));
  const rootPath = path.join(temporaryRoot, "root.jsonl");
  const childPath = path.join(temporaryRoot, "child.jsonl");
  const rootText = JSON.stringify({ timestamp: "2026-08-29T01:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "主会话任务" }] } });
  const childText = JSON.stringify({ timestamp: "2026-08-29T01:05:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "子 Agent 执行" }] } });
  await fs.writeFile(rootPath, rootText, "utf8");
  await fs.writeFile(childPath, childText, "utf8");
  const root = { ...capturedSession(rootPath, rootText), lineage: { origin: "primary" as const } };
  const child: AgentWorkSession = {
    ...capturedSession(childPath, childText),
    id: "child-runtime",
    lineage: { origin: "subagent", parentSessionId: root.id }
  };
  const repository = createTraceinkAssetRepository({ filePath: path.join(temporaryRoot, "assets.json") });
  const checkpointer = NodeSqliteSaver.fromConnectionString(":memory:");
  const runtimeStore = new StructuredTodayRuntimeStore(":memory:");
  let digestCalls = 0;
  const delegate = structuredRunner();
  try {
    await repository.load();
    const result = await runStructuredTodayIndexPreparation({
      logicalDate,
      snapshot: { date: logicalDate, generatedAt: "2026-08-29T02:00:00.000Z", sessions: [child, root], sources: [], warnings: [] },
      settings: settings(),
      repository,
      checkpointer,
      runtimeStore,
      runner: async (request) => {
        if (request.stdin.includes("Digest exactly one")) digestCalls += 1;
        return delegate(request);
      }
    });
    assert.equal(digestCalls, 1);
    assert.equal(result.artifact.sessions.length, 1);
    assert.equal(result.artifact.evidence.length, 2);
    const targets = createStructuredTodayCitationTargets(result.artifact, ["family-child:codex:child-runtime"], "E");
    assert.equal(targets.length, 1);
    const authorized = authorizeSessionTranscriptRequest(targets[0]!.target.request, [], createEmptyNotebookDocument(), repository.snapshot());
    assert.equal(authorized.id, child.id);
    assert.equal(authorized.transcriptCapture?.sha256, child.transcriptCapture?.sha256);
    assert.throws(() => authorizeSessionTranscriptRequest({ ...targets[0]!.target.request, path: rootPath }, [], createEmptyNotebookDocument(), repository.snapshot()), /不匹配/);

    assert.equal(projectStructuredTodayReview(repository.snapshot(), logicalDate, [child, root]).mode, "compiled");
  } finally {
    checkpointer.close();
    runtimeStore.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("structured projection becomes stale only when exact captured evidence changes", async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "structured-today-stale-"));
  const transcriptPath = path.join(temporaryRoot, "session.jsonl");
  const transcript = `${JSON.stringify({ type: "response_item", timestamp: "2026-08-29T01:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } })}\n`;
  await fs.writeFile(transcriptPath, transcript, "utf8");
  const original = capturedSession(transcriptPath, transcript);
  const repository = createTraceinkAssetRepository({ filePath: path.join(temporaryRoot, "assets.json") });
  const checkpointer = NodeSqliteSaver.fromConnectionString(":memory:");
  const runtimeStore = new StructuredTodayRuntimeStore(":memory:");
  try {
    await repository.load();
    await runStructuredTodayIndexPreparation({
      logicalDate,
      snapshot: { date: logicalDate, generatedAt: "2026-08-29T02:00:00.000Z", sessions: [original], sources: [], warnings: [] },
      settings: settings(),
      repository,
      checkpointer,
      runtimeStore,
      runner: structuredRunner()
    });
    assert.equal(projectStructuredTodayReview(repository.snapshot(), logicalDate, [original]).mode, "compiled");
    const changed = {
      ...original,
      transcriptCapture: {
        ...original.transcriptCapture!,
        sha256: "f".repeat(64)
      }
    };
    assert.equal(projectStructuredTodayReview(repository.snapshot(), logicalDate, [changed]).mode, "stale");
  } finally {
    checkpointer.close();
    runtimeStore.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

function structuredRunner(): CliRunner {
  return async (request) => {
    const evidenceId = "session:codex:session-1";
    const variables = JSON.parse(request.stdin.split("VARIABLES:\n")[1]!) as Record<string, string>;
    let output: unknown;
    if (request.stdin.includes("Digest exactly one")) {
      output = {
        sessionId: variables.expectedSessionId,
        summary: "完成结构化 workflow 接缝。",
        currentStop: "等待接入 Today UI。",
        participation: { human: "用户确定方向。", agent: "Agent 完成实现。" },
        evidenceIds: JSON.parse(variables.allowedEvidenceIdsJson!),
        uncertainties: []
      };
    } else if (request.stdin.includes("Reconstruct cross-Session")) {
      const sessionIds = JSON.parse(variables.allowedSessionIdsJson!) as string[];
      output = {
        worklines: [{
          worklineId: "workline-structured-today",
          title: "结构化 Today 后端",
          summary: "把确定性控制流与模型节点分离。",
          startedAt: "2026-08-29T01:00:00.000Z",
          endedAt: "2026-08-29T01:10:00.000Z",
          currentStop: "等待 UI 切换。",
          possibleChange: "Today 可以稳定显示结构化工作线。",
          participation: { human: "确定产品方向。", agent: "完成工程实现。" },
          evidenceReadiness: "ready",
          sessionIds,
          evidenceIds: JSON.parse(variables.allowedEvidenceIdsJson!),
          extensions: []
        }],
        assignments: sessionIds.map((sessionId) => ({ sessionId, worklineIds: ["workline-structured-today"] })),
        unresolvedSessionIds: []
      };
    } else if (request.stdin.includes("Analyze only the selected")) {
      output = {
        priorContext: "旧路径依赖 Markdown 解析。",
        whatHappened: "结构化 index 已持久化。",
        possibleChange: "核心导航不再依赖 Markdown。",
        supportingEvidence: [{ claim: "Session 已进入结构化工作线。", evidenceIds: [evidenceId] }],
        opposingEvidence: [],
        falsifiableObservation: "刷新后 Session membership 必须保持一致。",
        gaps: []
      };
    } else if (request.stdin.includes("Critique unsupported")) {
      output = { acceptable: true, issues: [], missingEvidenceIds: [] };
    } else if (request.stdin.includes("Compose the final")) {
      output = {
        title: "结构化 Today 证据档案",
        priorContext: "旧路径依赖 Markdown 解析。",
        whatHappened: "结构化 index 已持久化。",
        possibleChange: "核心导航不再依赖 Markdown。",
        supportingEvidence: [{ claim: "Session 已进入结构化工作线。", evidenceIds: [evidenceId] }],
        opposingEvidence: [],
        falsifiableObservation: "刷新后 Session membership 必须保持一致。",
        gaps: [],
        humanQuestion: "是否把结构化 producer 设为默认路径？",
        evidenceIds: [evidenceId],
        extensions: []
      };
    } else if (request.stdin.includes("Arrange the user")) {
      const sourceQuote = "我确认结构化工作线能够重开，但仍需验证完整封页。";
      output = {
        proposals: ["judgment", "tomorrow", "ctx", "background", "today-only"].map((category) => ({
          category,
          proposalText: `${category} proposal`,
          sourceQuote,
          evidenceIds: category === "judgment" ? [evidenceId] : []
        }))
      };
    } else {
      throw new Error(`Unexpected structured prompt: ${request.stdin.slice(0, 80)}`);
    }
    return {
      stdout: `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(output) } })}\n`,
      stderr: ""
    };
  };
}

function gatedProposalRunner(delegate: CliRunner): {
  runner: CliRunner;
  entered: Promise<void>;
  release(): void;
} {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return {
    entered,
    release,
    runner: async (request) => {
      if (request.stdin.includes("Arrange the user")) {
        markEntered();
        await released;
      }
      return delegate(request);
    }
  };
}

function capturedSession(transcriptPath: string, transcript: string): AgentWorkSession {
  return {
    id: "session-1",
    platform: "codex",
    title: "Structured Today",
    summary: "metadata summary",
    path: transcriptPath,
    startedAt: "2026-08-29T01:00:00.000Z",
    updatedAt: "2026-08-29T01:10:00.000Z",
    artifacts: [],
    status: "active",
    transcriptCapture: {
      canonicalPath: transcriptPath,
      sha256: createHash("sha256").update(transcript, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(transcript),
      coverage: { startByte: 0, endByte: Buffer.byteLength(transcript) }
    }
  };
}

function settings(): CockpitSettings {
  return {
    dailyNoteFolder: "Agent Cockpit",
    llmEndpoint: "http://127.0.0.1:11434/v1/chat/completions",
    llmModel: "local-model",
    sessionScanRoots: [],
    enabledSessionProviders: ["codex"],
    sessionSummaryMode: "metadata",
    runtimeNodePath: "node",
    codexCliPath: "codex",
    claudeCliPath: "claude",
    cursorCliPath: "agent",
    dailyReviewScheduleEnabled: false,
    dailyReviewScheduleTime: "18:30"
  };
}

// Regression: the first family survives a terminal business failure in its sibling.
test("terminal digest retry reruns only failed families and publishes once recovered", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "structured-retry-"));
  const checkpointer = NodeSqliteSaver.fromConnectionString(":memory:");
  const runtimeStore = new StructuredTodayRuntimeStore(":memory:");
  try {
    const text = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "retry evidence" } });
    const sessions = await Promise.all([1, 2].map(async (n) => {
      const filename = path.join(root, `${n}.jsonl`);
      await fs.writeFile(filename, text);
      return { ...capturedSession(filename, text), id: `session-${n}` };
    }));
    const calls = new Map<string, number>();
    const delegate = structuredRunner();
    const runner: CliRunner = async (request) => {
      if (request.stdin.includes("Digest exactly one")) {
        const { expectedSessionId } = JSON.parse(request.stdin.split("VARIABLES:\n")[1]!);
        calls.set(expectedSessionId, (calls.get(expectedSessionId) ?? 0) + 1);
        if (expectedSessionId === "session-2" && calls.get(expectedSessionId) === 1) throw new Error("temporary outage");
      }
      return delegate(request);
    };
    const args = { logicalDate, snapshot: { date: logicalDate, generatedAt: "2026-08-29T02:00:00.000Z", sessions, sources: [], warnings: [] },
      settings: settings(), repository: createTraceinkAssetRepository({ filePath: path.join(root, "assets.json") }), checkpointer, runtimeStore, runner };
    await assert.rejects(runStructuredTodayIndexPreparation(args), /publication gates/);
    const recovered = await runStructuredTodayIndexPreparation(args);
    assert.equal(recovered.artifact.coverage.complete, true);
    assert.equal(calls.get("session-1"), 1);
    assert.equal(calls.get("session-2"), 2);
    await runStructuredTodayIndexPreparation(args);
    assert.equal(calls.get("session-1"), 1, "unchanged family reuses its successful digest across revisions");
    assert.equal(calls.get("session-2"), 2);
    const changedText = text + "\n" + JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "new evidence" } });
    await fs.writeFile(sessions[1]!.path, changedText);
    args.snapshot.sessions[1] = { ...capturedSession(sessions[1]!.path, changedText), id: "session-2" };
    await runStructuredTodayIndexPreparation(args);
    assert.equal(calls.get("session-1"), 1);
    assert.equal(calls.get("session-2"), 3, "only changed family recomputes");
  } finally {
    checkpointer.close();
    runtimeStore.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("structured evidence budget bounds serialized metadata and never repeats head/tail messages", async () => {
  const content = Array.from({ length: 4000 }, (_, n) => JSON.stringify({ type: "response_item", timestamp: "2026-08-29T01:00:00.000Z",
    payload: { type: "message", id: String(n), role: "assistant", content: `message-${n} \\ \"` } })).join("\n");
  const result = await buildStructuredTodayIndexInput({ logicalDate,
    snapshot: { date: logicalDate, generatedAt: "2026-08-29T02:00:00.000Z", sessions: [capturedSession("/tmp/budget.jsonl", content)], sources: [], warnings: [] },
    editorialContract: await loadStructuredTodayEditorialContract(), artifactId: "budget", revision: 1, workflowRunId: "budget",
    readTranscript: async () => ({ content, truncated: false }) });
  const serialized = result.sessions[0]!.evidenceText;
  assert.ok(serialized.length <= 240000);
  const parsed = JSON.parse(serialized) as { coverage: string; messages: Array<{ id: string }> };
  assert.equal(parsed.coverage, "partial");
  assert.equal(new Set(parsed.messages.map((m) => m.id)).size, parsed.messages.length);
  assert.equal(parsed.messages[0]?.id, "0");
  assert.equal(parsed.messages.at(-1)?.id, "3999");
});
