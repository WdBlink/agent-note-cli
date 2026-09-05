import path from "node:path";
import type { SessionTranscriptRequest } from "./api";
import type { NotebookDocument } from "./notebook-store";
import {
  activeIndexReferenceForDate,
  activeStructuredTodayIndexReferenceForDate,
  currentTraceinkWorklineLineage,
  findTraceinkArtifact,
  findStructuredTodayIndex,
  sameTraceinkArtifactReference,
  type TraceinkAssetStoreDocumentV1
} from "./traceink-asset-store";
import type { TraceinkArtifactReferenceV1, TraceinkArtifactV1 } from "../../src/traceink-review-assets";
import type { AgentPlatform, AgentTranscriptCapture, AgentWorkSession } from "../../src/types";
import type { DailyReviewEvidence } from "../../src/workline-review";

export interface AuthorizedSessionTranscriptReference {
  id: string;
  platform: AgentPlatform;
  path: string;
  readPath: string;
  title: string;
  origin: "current-snapshot" | "sealed-package" | "traceink-asset";
  evidenceUpdatedAt?: string;
  transcriptCapture?: AgentTranscriptCapture;
}

export function authorizeSessionTranscriptRequest(
  request: SessionTranscriptRequest,
  currentSessions: AgentWorkSession[],
  document: NotebookDocument,
  traceinkAssets?: TraceinkAssetStoreDocumentV1
): AuthorizedSessionTranscriptReference {
  const authorityCount = [request?.packageRef, request?.traceinkRef, request?.structuredTodayRef].filter(Boolean).length;
  if (authorityCount > 1) {
    throw new Error("一次会话读取不能同时使用多种封存证据授权。");
  }
  if (request?.structuredTodayRef) return authorizeStructuredTodayTranscript(request, traceinkAssets);
  if (request?.traceinkRef) return authorizeTraceinkTranscript(request, traceinkAssets);
  const packageRef = request?.packageRef;
  if (!packageRef) {
    const current = currentSessions.find((session) =>
      session.id === request?.id && session.platform === request?.platform && session.path === request?.path
    );
    if (current) return pickReference(current);
    throw new Error("这条会话不在当前只读快照中，也没有封存证据授权。");
  }
  const page = document.pages[packageRef.logicalDate];
  if (!page || page.activePackageGenerationId !== packageRef.generationId) {
    throw new Error("指定的证据包不是当前封存证据包，拒绝读取。");
  }
  const generation = page.packageGenerations?.find((candidate) => candidate.id === packageRef.generationId);
  if (!generation) throw new Error("指定的证据包不是当前封存证据包，拒绝读取。");
  const evidence = generation.package.evidence.find((candidate) =>
    candidate.id === packageRef.evidenceId && candidate.kind === "session"
  );
  if (!evidence) throw new Error("封存证据包中没有找到这条会话证据。");
  if (evidence.sessionId !== request.id || evidence.platform !== request.platform || evidence.path !== request.path) {
    throw new Error("请求的会话元组与封存证据不匹配，拒绝读取。");
  }
  if (evidence.transcriptCapture && evidence.transcriptCapture.canonicalPath !== evidence.path) {
    throw new Error("封存证据的 canonical path 与会话元组不匹配，拒绝读取。");
  }
  if (evidence.transcriptCapture) return pickPackageReference(evidence);
  if (page.status !== "sealed") {
    const current = currentSessions.find((session) =>
      session.id === evidence.sessionId && session.platform === evidence.platform && session.path === evidence.path
    );
    if (!current) throw new Error("指定日期尚未封页，不能用工作包回开历史会话。");
    return pickReference(current);
  }
  return pickPackageReference(evidence);
}

function authorizeStructuredTodayTranscript(
  request: SessionTranscriptRequest,
  document: TraceinkAssetStoreDocumentV1 | undefined
): AuthorizedSessionTranscriptReference {
  const requested = request.structuredTodayRef;
  if (!requested || !document) throw new Error("Structured Today 证据资产尚未加载，拒绝读取。");
  const active = activeStructuredTodayIndexReferenceForDate(document, requested.logicalDate);
  if (
    !active ||
    active.artifactId !== requested.artifactId ||
    active.revision !== requested.revision ||
    active.contentHash !== requested.contentHash
  ) {
    throw new Error("这条证据不属于该日期当前结构化工作脉络，拒绝读取。");
  }
  const index = findStructuredTodayIndex(document, active);
  const evidence = index?.evidence.find((candidate) => candidate.evidenceId === requested.evidenceId);
  if (!index || !evidence || evidence.sourceKind !== "session") {
    throw new Error("结构化工作脉络中找不到指定 Session 证据。");
  }
  if (
    evidence.sessionId !== request.id ||
    evidence.provider !== request.platform ||
    evidence.sourcePath !== request.path
  ) {
    throw new Error("请求的会话元组与结构化证据不匹配，拒绝读取。");
  }
  const match = /^bytes 0-(\d+)$/.exec(evidence.range ?? "");
  const byteLength = match ? Number(match[1]) : Number.NaN;
  if (!path.isAbsolute(evidence.sourcePath) || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("结构化 Session 证据的冻结路径或范围无效，拒绝读取。");
  }
  return {
    id: evidence.sessionId,
    platform: evidence.provider,
    path: evidence.sourcePath,
    readPath: evidence.sourcePath,
    title: index.sessions.find((session) => session.sessionId === evidence.sessionId)?.title ?? evidence.sessionId,
    origin: "traceink-asset",
    transcriptCapture: {
      canonicalPath: evidence.sourcePath,
      sha256: evidence.contentHash,
      byteLength,
      coverage: { startByte: 0, endByte: byteLength }
    }
  };
}

function authorizeTraceinkTranscript(
  request: SessionTranscriptRequest,
  document: TraceinkAssetStoreDocumentV1 | undefined
): AuthorizedSessionTranscriptReference {
  const traceinkRef = request.traceinkRef;
  if (!traceinkRef || !document) throw new Error("Traceink 证据资产尚未加载，拒绝读取。");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(traceinkRef.logicalDate)) {
    throw new Error("Traceink 证据日期无效，拒绝读取。");
  }
  const artifact = findTraceinkArtifact(document, traceinkRef);
  if (!artifact || artifact.logicalDate !== traceinkRef.logicalDate) {
    throw new Error("找不到请求所指向的精确 Traceink 资产版本，拒绝读取。");
  }
  if (!belongsToCurrentTodayTraceinkLineage(document, traceinkRef.logicalDate, artifact, traceinkRef)) {
    throw new Error("这条 Traceink 证据不属于该日期当前工作脉络，拒绝从 Today 重开。");
  }
  const evidence = artifact.evidence.find((candidate) => candidate.id === traceinkRef.evidenceId);
  if (!evidence) throw new Error("Traceink 资产中找不到指定证据，拒绝读取。");
  if (evidence.kind !== "session") throw new Error("只有 Traceink Session 证据可以在会话阅读器中重开。");
  if (
    evidence.sessionId !== request.id ||
    evidence.provider !== request.platform ||
    evidence.path !== request.path
  ) {
    throw new Error("请求的会话元组与 Traceink 证据不匹配，拒绝读取。");
  }
  if (!path.isAbsolute(evidence.path) || evidence.path.includes("\0")) {
    throw new Error("Traceink 会话证据路径无效，拒绝读取。");
  }
  const match = /^bytes 0-(\d+)$/.exec(evidence.locator);
  const byteLength = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new Error("Traceink 会话证据的冻结范围无效，拒绝读取。");
  }
  if (!evidence.contentHash || !/^[a-f0-9]{64}$/.test(evidence.contentHash)) {
    throw new Error("Traceink 会话证据缺少有效的 SHA-256，拒绝读取。");
  }
  const transcriptCapture: AgentTranscriptCapture = {
    canonicalPath: evidence.path,
    sha256: evidence.contentHash,
    byteLength,
    coverage: { startByte: 0, endByte: byteLength }
  };
  return {
    id: evidence.sessionId,
    platform: evidence.provider,
    path: evidence.path,
    readPath: evidence.path,
    title: evidence.sessionId,
    origin: "traceink-asset",
    transcriptCapture
  };
}

function belongsToCurrentTodayTraceinkLineage(
  document: TraceinkAssetStoreDocumentV1,
  logicalDate: string,
  artifact: TraceinkArtifactV1,
  requested: TraceinkArtifactReferenceV1
): boolean {
  const active = activeIndexReferenceForDate(document, logicalDate);
  if (!active || artifact.logicalDate !== logicalDate) return false;
  if (artifact.stage === "index") return sameTraceinkArtifactReference(active, requested);
  if (!artifact.worklineId) return false;
  const lineage = currentTraceinkWorklineLineage(document, logicalDate, artifact.worklineId);
  if (artifact.stage === "dossier") {
    return Boolean(lineage?.dossier && sameTraceinkArtifactReference(
      traceinkArtifactReference(lineage.dossier),
      requested
    ));
  }
  return Boolean(lineage?.proposals && sameTraceinkArtifactReference(
    traceinkArtifactReference(lineage.proposals),
    requested
  ));
}

function traceinkArtifactReference(artifact: TraceinkArtifactV1): TraceinkArtifactReferenceV1 {
  return {
    artifactId: artifact.id,
    stage: artifact.stage,
    revision: artifact.revision,
    outputHash: artifact.outputHash
  };
}

function pickPackageReference(evidence: DailyReviewEvidence): AuthorizedSessionTranscriptReference {
  return {
    id: evidence.sessionId,
    platform: evidence.platform,
    path: evidence.path,
    readPath: evidence.transcriptCapture?.canonicalPath ?? evidence.path,
    title: evidence.label,
    origin: "sealed-package",
    ...(evidence.transcriptCapture
      ? { transcriptCapture: structuredClone(evidence.transcriptCapture) }
      : evidence.updatedAt ? { evidenceUpdatedAt: evidence.updatedAt } : {})
  };
}

function pickReference(session: AgentWorkSession): AuthorizedSessionTranscriptReference {
  return {
    id: session.id,
    platform: session.platform,
    path: session.path,
    readPath: session.transcriptCapture?.canonicalPath ?? session.path,
    title: session.title,
    origin: "current-snapshot",
    ...(session.transcriptCapture ? { transcriptCapture: structuredClone(session.transcriptCapture) } : {})
  };
}
