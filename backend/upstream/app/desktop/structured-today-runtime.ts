import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { beginCheckpointRun, cleanupPublishedCheckpoint } from "../../src/langgraph-node-sqlite-checkpointer";
import { createStructuredTodayModelFunctions } from "../../src/structured-today-model-functions";
import { loadStructuredTodayEditorialContract } from "../../src/structured-today-model-functions";
import {
  createStructuredTodayLangGraphDossier,
  createStructuredTodayLangGraphIndex,
  createStructuredTodayLangGraphProposals,
  invokeStructuredTodayLangGraphDossier,
  invokeStructuredTodayLangGraphIndex,
  invokeStructuredTodayLangGraphProposals,
  retryStructuredTodayLangGraphIndex,
  retryStructuredTodayLangGraphDossier,
  retryStructuredTodayLangGraphProposals,
  type StructuredTodayWorkflowProgressV1
} from "../../src/structured-today-langgraph";
import { sha256Text, STRUCTURED_TODAY_WORKFLOW_VERSION, type StructuredTodayProposalArtifactV1, type StructuredTodayReflectionV1, type TodayWorklineDossierV1, type TodayWorklineIndexV1 } from "../../src/structured-today-contracts";
import type { CliRunner } from "../../src/agent-summary";
import type { AgentWorkSnapshot, CockpitSettings } from "../../src/types";
import {
  activeStructuredTodayIndexReferenceForDate,
  appendStructuredTodayDossierRevision,
  appendStructuredTodayIndexRevision,
  appendStructuredTodayProposalRevision,
  findStructuredTodayIndex,
  latestStructuredTodayDossier,
  latestStructuredTodayProposals,
  latestStructuredTodayReflection,
  nextStructuredTodayDossierRevision,
  nextStructuredTodayIndexRevision,
  nextStructuredTodayProposalRevision,
  structuredTodayDossierArtifactId,
  structuredTodayIndexArtifactId,
  structuredTodayProposalArtifactId,
  upsertStructuredTodayRun,
  type StructuredTodayRunRecordV1,
  type StructuredTodayIndexReferenceV1
} from "./traceink-asset-store";
import type { TraceinkAssetRepository } from "./traceink-asset-repository";
import { buildStructuredTodayIndexInput, structuredTodaySessionFamilies } from "./structured-today-input";
import {
  createStructuredTodayCliCaller,
  freezeStructuredTodayProviderPlan
} from "./structured-today-cli-caller";

export async function runStructuredTodayIndexPreparation(input: {
  logicalDate: string;
  snapshot: AgentWorkSnapshot;
  settings: CockpitSettings;
  repository: Pick<TraceinkAssetRepository, "load" | "mutate">;
  checkpointer: BaseCheckpointSaver;
  runner: CliRunner;
  onProgress?: (progress: StructuredTodayWorkflowProgressV1) => void | Promise<void>;
}): Promise<{ artifact: TodayWorklineIndexV1; reference: StructuredTodayIndexReferenceV1 }> {
  const starting = await input.repository.load();
  const expectedActive = activeStructuredTodayIndexReferenceForDate(starting, input.logicalDate) ?? null;
  const revision = nextStructuredTodayIndexRevision(starting, input.logicalDate);
  const artifactId = structuredTodayIndexArtifactId(input.logicalDate);
  const editorialContract = await loadStructuredTodayEditorialContract();
  const digestFamilies = structuredTodaySessionFamilies(input.snapshot.sessions.flatMap((session) =>
    session.platform === "codex" || session.platform === "claude" ? [session] : []
  ));
  const plan = freezeStructuredTodayProviderPlan(
    input.settings,
    digestFamilies.map(({ root }) => ({ sessionId: root.id, provider: root.platform }))
  );
  const workflowRunId = `structured-today-index-${sha256Text(JSON.stringify({
    workflowVersion: STRUCTURED_TODAY_WORKFLOW_VERSION,
    editorialContract: editorialContract.ref,
    providerPlan: plan,
    logicalDate: input.logicalDate,
    revision,
    families: digestFamilies.map((family) => ({
      rootSessionId: family.root.id,
      members: family.members.map((session) => ({
        provider: session.platform,
        sessionId: session.id,
        path: session.transcriptCapture?.canonicalPath ?? session.path,
        hash: session.transcriptCapture?.sha256 ?? null,
        bytes: session.transcriptCapture?.byteLength ?? null
      }))
    })).sort((left, right) => left.rootSessionId.localeCompare(right.rootSessionId))
  })).slice(0, 32)}`;
  const workflowInput = await buildStructuredTodayIndexInput({
    logicalDate: input.logicalDate,
    snapshot: input.snapshot,
    editorialContract,
    artifactId,
    revision,
    workflowRunId
  });
  const models = createStructuredTodayModelFunctions(createStructuredTodayCliCaller({
    settings: input.settings,
    plan,
    runner: input.runner
  }));
  const startedAt = starting.structuredRuns?.find((run) => run.runId === workflowRunId)?.startedAt ?? new Date().toISOString();
  const total = workflowInput.sessions.length + 2;
  const persistProgress = async (progress: StructuredTodayWorkflowProgressV1): Promise<void> => {
    const previous = (await input.repository.load()).structuredRuns?.find((run) => run.runId === workflowRunId);
    const terminalDigest = progress.stage === "digest" &&
      (progress.status === "ready" || progress.status === "failed" || progress.status === "excluded");
    const synthesisReady = progress.stage === "index-synthesis" && progress.status === "ready";
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "index",
      logicalDate: input.logicalDate,
      status: progress.status === "failed" ? "failed" : "running",
      stage: progress.stage,
      completed: Math.min(total, (previous?.completed ?? 0) + (terminalDigest || synthesisReady ? 1 : 0)),
      total,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    await input.onProgress?.(progress);
  };
  await persistRun(input.repository, {
    runId: workflowRunId,
    kind: "index",
    logicalDate: input.logicalDate,
    status: "running",
    stage: "capture-evidence",
    completed: 0,
    total,
    startedAt,
    updatedAt: new Date().toISOString()
  });
  const graph = createStructuredTodayLangGraphIndex({
    dependencies: {
      models,
      onProgress: persistProgress
    },
    checkpointer: input.checkpointer
  });
  const finishCheckpointRun = await beginCheckpointRun(input.checkpointer, workflowRunId);
  try {
    const existingCheckpoint = await input.checkpointer.getTuple({ configurable: { thread_id: workflowRunId } });
    const output = existingCheckpoint
      ? await retryStructuredTodayLangGraphIndex({ graph, threadId: workflowRunId, digestConcurrency: 3 })
      : await invokeStructuredTodayLangGraphIndex({ graph, workflowInput, threadId: workflowRunId, digestConcurrency: 3 });
    if ("interrupted" in output) throw new Error("Structured Today index suspended unexpectedly.");
    if (!output.publishable) {
      const detail = indexPublicationFailure(output.artifact, output.issues);
      throw new Error(`Structured Today index did not pass publication gates: ${detail}`);
    }
    const document = await input.repository.mutate((current) =>
      appendStructuredTodayIndexRevision(current, output.artifact, expectedActive)
    );
    const reference = activeStructuredTodayIndexReferenceForDate(document, input.logicalDate);
    const artifact = reference ? findStructuredTodayIndex(document, reference) : undefined;
    if (!reference || !artifact) throw new Error("Structured Today index was saved but could not be reopened.");
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "index",
      logicalDate: input.logicalDate,
      status: "ready",
      stage: "ready",
      completed: total,
      total,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    await cleanupPublishedCheckpoint(input.checkpointer, workflowRunId);
    return { artifact, reference };
  } catch (error) {
    const previous = (await input.repository.load()).structuredRuns?.find((run) => run.runId === workflowRunId);
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "index",
      logicalDate: input.logicalDate,
      status: "failed",
      stage: "failed",
      completed: previous?.completed ?? 0,
      total,
      startedAt,
      updatedAt: new Date().toISOString(),
      message: errorMessage(error)
    });
    throw error;
  } finally {
    await finishCheckpointRun();
  }
}

export async function runStructuredTodayDossierPreparation(input: {
  logicalDate: string;
  indexReference: StructuredTodayIndexReferenceV1;
  worklineId: string;
  settings: CockpitSettings;
  repository: Pick<TraceinkAssetRepository, "load" | "mutate">;
  checkpointer: BaseCheckpointSaver;
  runner: CliRunner;
  onProgress?: (progress: StructuredTodayWorkflowProgressV1) => void | Promise<void>;
}): Promise<TodayWorklineDossierV1> {
  const starting = await input.repository.load();
  const active = activeStructuredTodayIndexReferenceForDate(starting, input.logicalDate);
  if (!active || !sameReference(active, input.indexReference)) {
    throw new Error("工作脉络已经更新，请从当前版本重新选择。");
  }
  const index = findStructuredTodayIndex(starting, active);
  if (!index) throw new Error("当前结构化工作脉络无法读取。");
  const existing = latestStructuredTodayDossier(starting, active, input.worklineId);
  if (existing) return existing;
  if (!index.worklines.some((workline) => workline.worklineId === input.worklineId)) {
    throw new Error("选择的工作线不属于当前结构化索引。");
  }
  const revision = nextStructuredTodayDossierRevision(starting, active, input.worklineId);
  const artifactId = structuredTodayDossierArtifactId(active, input.worklineId);
  const editorialContract = await loadStructuredTodayEditorialContract();
  const plan = freezeStructuredTodayProviderPlan(
    input.settings,
    index.sessions.map((session) => ({ sessionId: session.sessionId, provider: session.provider }))
  );
  const workflowRunId = `structured-today-dossier-${sha256Text(JSON.stringify({
    workflowVersion: STRUCTURED_TODAY_WORKFLOW_VERSION,
    editorialContract: editorialContract.ref,
    providerPlan: plan,
    index: active,
    worklineId: input.worklineId,
    revision
  })).slice(0, 32)}`;
  const models = createStructuredTodayModelFunctions(createStructuredTodayCliCaller({
    settings: input.settings,
    plan,
    runner: input.runner
  }));
  const startedAt = starting.structuredRuns?.find((run) => run.runId === workflowRunId)?.startedAt ?? new Date().toISOString();
  const total = 4;
  const persistProgress = async (progress: StructuredTodayWorkflowProgressV1): Promise<void> => {
    const previous = (await input.repository.load()).structuredRuns?.find((run) => run.runId === workflowRunId);
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "dossier",
      logicalDate: input.logicalDate,
      worklineId: input.worklineId,
      status: progress.status === "failed" ? "failed" : "running",
      stage: progress.stage,
      completed: Math.min(total, (previous?.completed ?? 0) + (progress.status === "ready" ? 1 : 0)),
      total,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    await input.onProgress?.(progress);
  };
  await persistRun(input.repository, {
    runId: workflowRunId,
    kind: "dossier",
    logicalDate: input.logicalDate,
    worklineId: input.worklineId,
    status: "running",
    stage: "gather-evidence",
    completed: 0,
    total,
    startedAt,
    updatedAt: new Date().toISOString()
  });
  const graph = createStructuredTodayLangGraphDossier({
    dependencies: {
      models,
      onProgress: persistProgress
    },
    checkpointer: input.checkpointer
  });
  const finishCheckpointRun = await beginCheckpointRun(input.checkpointer, workflowRunId);
  try {
    const existingCheckpoint = await input.checkpointer.getTuple({ configurable: { thread_id: workflowRunId } });
    const output = existingCheckpoint
      ? await retryStructuredTodayLangGraphDossier({ graph, threadId: workflowRunId })
      : await invokeStructuredTodayLangGraphDossier({
          graph,
          workflowInput: {
            workflowRunId,
            artifactId,
            revision,
            editorialContract,
            sourceIndex: index,
            worklineId: input.worklineId,
            linkedEvidence: []
          },
          threadId: workflowRunId
        });
    const document = await input.repository.mutate((current) =>
      appendStructuredTodayDossierRevision(current, output.artifact, active)
    );
    const dossier = latestStructuredTodayDossier(document, active, input.worklineId);
    if (!dossier) throw new Error("Structured Today dossier was saved but could not be reopened.");
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "dossier",
      logicalDate: input.logicalDate,
      worklineId: input.worklineId,
      status: "ready",
      stage: "ready",
      completed: total,
      total,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    await cleanupPublishedCheckpoint(input.checkpointer, workflowRunId);
    return dossier;
  } catch (error) {
    const previous = (await input.repository.load()).structuredRuns?.find((run) => run.runId === workflowRunId);
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "dossier",
      logicalDate: input.logicalDate,
      worklineId: input.worklineId,
      status: "failed",
      stage: "failed",
      completed: previous?.completed ?? 0,
      total,
      startedAt,
      updatedAt: new Date().toISOString(),
      message: errorMessage(error)
    });
    throw error;
  } finally {
    await finishCheckpointRun();
  }
}

export async function runStructuredTodayProposalPreparation(input: {
  logicalDate: string;
  indexReference: StructuredTodayIndexReferenceV1;
  worklineId: string;
  reflection: StructuredTodayReflectionV1;
  settings: CockpitSettings;
  repository: Pick<TraceinkAssetRepository, "load" | "mutate">;
  checkpointer: BaseCheckpointSaver;
  runner: CliRunner;
  onProgress?: (progress: StructuredTodayWorkflowProgressV1) => void | Promise<void>;
}): Promise<StructuredTodayProposalArtifactV1> {
  const starting = await input.repository.load();
  const active = activeStructuredTodayIndexReferenceForDate(starting, input.logicalDate);
  const dossier = active ? latestStructuredTodayDossier(starting, active, input.worklineId) : undefined;
  const currentReflection = dossier ? latestStructuredTodayReflection(starting, dossier) : undefined;
  if (
    !active ||
    !sameReference(active, input.indexReference) ||
    !dossier ||
    !currentReflection ||
    currentReflection.reflectionId !== input.reflection.reflectionId ||
    currentReflection.revision !== input.reflection.revision ||
    currentReflection.contentHash !== input.reflection.contentHash
  ) {
    throw new Error("你的回顾已经更新，请从最新保存的版本重新整理。");
  }
  const existing = latestStructuredTodayProposals(starting, currentReflection);
  if (existing) return existing;
  const revision = nextStructuredTodayProposalRevision(starting, currentReflection);
  const artifactId = structuredTodayProposalArtifactId(currentReflection);
  const editorialContract = await loadStructuredTodayEditorialContract();
  const index = findStructuredTodayIndex(starting, active);
  if (!index) throw new Error("Structured Today index cannot be reopened for proposal preparation.");
  const plan = freezeStructuredTodayProviderPlan(
    input.settings,
    index.sessions.map((session) => ({ sessionId: session.sessionId, provider: session.provider }))
  );
  const workflowRunId = `structured-today-proposals-${sha256Text(JSON.stringify({
    workflowVersion: STRUCTURED_TODAY_WORKFLOW_VERSION,
    editorialContract: editorialContract.ref,
    providerPlan: plan,
    reflection: currentReflection.contentHash,
    revision
  })).slice(0, 32)}`;
  const models = createStructuredTodayModelFunctions(createStructuredTodayCliCaller({
    settings: input.settings,
    plan,
    runner: input.runner
  }));
  const startedAt = starting.structuredRuns?.find((run) => run.runId === workflowRunId)?.startedAt ?? new Date().toISOString();
  const persistProgress = async (progress: StructuredTodayWorkflowProgressV1): Promise<void> => {
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "proposals",
      logicalDate: input.logicalDate,
      worklineId: input.worklineId,
      status: progress.status === "failed" ? "failed" : "running",
      stage: progress.stage,
      completed: progress.status === "ready" ? 1 : 0,
      total: 1,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    await input.onProgress?.(progress);
  };
  await persistRun(input.repository, {
    runId: workflowRunId,
    kind: "proposals",
    logicalDate: input.logicalDate,
    worklineId: input.worklineId,
    status: "running",
    stage: "proposal-arrange",
    completed: 0,
    total: 1,
    startedAt,
    updatedAt: new Date().toISOString()
  });
  const graph = createStructuredTodayLangGraphProposals({
    dependencies: {
      models,
      onProgress: persistProgress
    },
    checkpointer: input.checkpointer
  });
  const finishCheckpointRun = await beginCheckpointRun(input.checkpointer, workflowRunId);
  try {
    const existingCheckpoint = await input.checkpointer.getTuple({ configurable: { thread_id: workflowRunId } });
    const output = existingCheckpoint
      ? await retryStructuredTodayLangGraphProposals({ graph, threadId: workflowRunId })
      : await invokeStructuredTodayLangGraphProposals({
          graph,
          workflowInput: {
            workflowRunId,
            artifactId,
            revision,
            editorialContract,
            dossier,
            reflection: currentReflection
          },
          threadId: workflowRunId
        });
    const document = await input.repository.mutate((current) =>
      appendStructuredTodayProposalRevision(current, output.artifact, currentReflection)
    );
    const proposals = latestStructuredTodayProposals(document, currentReflection);
    if (!proposals) throw new Error("Structured Today proposals were saved but could not be reopened.");
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "proposals",
      logicalDate: input.logicalDate,
      worklineId: input.worklineId,
      status: "ready",
      stage: "ready",
      completed: 1,
      total: 1,
      startedAt,
      updatedAt: new Date().toISOString()
    });
    await cleanupPublishedCheckpoint(input.checkpointer, workflowRunId);
    return proposals;
  } catch (error) {
    await persistRun(input.repository, {
      runId: workflowRunId,
      kind: "proposals",
      logicalDate: input.logicalDate,
      worklineId: input.worklineId,
      status: "failed",
      stage: "failed",
      completed: 0,
      total: 1,
      startedAt,
      updatedAt: new Date().toISOString(),
      message: errorMessage(error)
    });
    throw error;
  } finally {
    await finishCheckpointRun();
  }
}

function coverageFailure(index: TodayWorklineIndexV1): string {
  return [
    index.coverage.failed ? `${index.coverage.failed} failed Session(s)` : "",
    index.coverage.unresolved ? `${index.coverage.unresolved} unresolved Session(s)` : ""
  ].filter(Boolean).join("; ") || "unknown coverage failure";
}

function indexPublicationFailure(index: TodayWorklineIndexV1, issues: string[]): string {
  const summary = issues.join(" ") || coverageFailure(index);
  const representativeReasons = Array.from(new Set(index.dispositions.flatMap((disposition) =>
    disposition.kind === "failed" || disposition.kind === "unresolved"
      ? [disposition.reason]
      : []
  ))).slice(0, 2);
  return representativeReasons.length > 0
    ? `${summary} Representative cause: ${representativeReasons.join(" | ")}`
    : summary;
}

function sameReference(
  left: StructuredTodayIndexReferenceV1,
  right: StructuredTodayIndexReferenceV1
): boolean {
  return left.artifactId === right.artifactId &&
    left.revision === right.revision &&
    left.contentHash === right.contentHash;
}

async function persistRun(
  repository: Pick<TraceinkAssetRepository, "mutate">,
  record: StructuredTodayRunRecordV1
): Promise<void> {
  await repository.mutate((document) => upsertStructuredTodayRun(document, record));
}

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "Structured Today workflow failed.";
}
