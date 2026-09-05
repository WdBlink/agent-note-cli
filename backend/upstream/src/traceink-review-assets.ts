import { createHash } from "node:crypto";

export type TraceinkStage = "index" | "dossier" | "proposals";
export type Sha256 = string;

export interface TraceinkSkillBundleRefV1 {
  packageId: "traceink";
  version: string;
  skillHash: Sha256;
  editorialContractHash: Sha256;
}

export interface TraceinkReviewScopeV1 {
  timeZone: string;
  startInclusive: string;
  endExclusive: string;
  evidenceCutoff: string;
}

export interface TraceinkProducerRefV1 {
  provider: "codex" | "claude";
  model: string;
  reasoningConfiguration?: string;
  startedAt: string;
  completedAt: string;
  skill: TraceinkSkillBundleRefV1;
  scope?: TraceinkReviewScopeV1;
}

export interface TraceinkEvidenceRefV1 {
  id: string;
  kind: "session" | "document" | "code" | "test" | "experiment" | "artifact";
  provider?: "codex" | "claude";
  sessionId?: string;
  path: string;
  locator: string;
  contentHash?: Sha256;
}

export interface TraceinkCoverageEntryV1 {
  sourceId: string;
  disposition: "read" | "skipped" | "deduplicated" | "truncated" | "failed";
  detail: string;
}

export interface TraceinkNavigationItemV1 {
  id: string;
  markdownAnchor: string;
  evidenceIds: string[];
}

export type TraceinkProposalCategoryV1 = "judgment" | "tomorrow" | "ctx" | "background" | "today-only";

export interface TraceinkProposalNavigationItemV1 extends TraceinkNavigationItemV1 {
  category: TraceinkProposalCategoryV1;
  /** Fallible presentation sidecar; rawMarkdown remains the semantic authority. */
  proposalText: string;
  sourceQuote: string;
}

export interface TraceinkArtifactReferenceV1 {
  artifactId: string;
  stage: TraceinkStage;
  revision: number;
  outputHash: Sha256;
}

export interface UserReflectionAssetReferenceV1 {
  reflectionId: string;
  revision: number;
  contentHash: Sha256;
}

export interface UserReflectionAssetV1 {
  schemaVersion: 1;
  id: string;
  logicalDate: string;
  worklineId: string;
  dossier: TraceinkArtifactReferenceV1 & { stage: "dossier" };
  revision: number;
  text: string;
  createdAt: string;
  savedAt: string;
  contentHash: Sha256;
}

export type TraceinkProposalDispositionActionV1 = "accept" | "dismiss" | "defer" | "rewrite";

/**
 * One immutable interaction receipt. It records only how the user wants the
 * proposal presented; it grants no destination-write or execution authority.
 */
export interface TraceinkProposalDispositionV1 {
  schemaVersion: 1;
  id: string;
  logicalDate: string;
  worklineId: string;
  proposalArtifact: TraceinkArtifactReferenceV1 & { stage: "proposals" };
  proposalId: string;
  category: TraceinkProposalCategoryV1;
  revision: number;
  action: TraceinkProposalDispositionActionV1;
  rewriteText?: string;
  decidedAt: string;
}

export interface TraceinkArtifactV1 {
  schemaVersion: 1;
  id: string;
  logicalDate: string;
  stage: TraceinkStage;
  worklineId?: string;
  sourceReflection?: UserReflectionAssetReferenceV1;
  revision: number;
  producer: TraceinkProducerRefV1;
  inputEvidenceHash: Sha256;
  rawMarkdown: string;
  outputHash: Sha256;
  coverage: TraceinkCoverageEntryV1[];
  evidence: TraceinkEvidenceRefV1[];
  navigation: Array<TraceinkNavigationItemV1 | TraceinkProposalNavigationItemV1>;
  warnings: string[];
}

export type TraceinkIndexArtifactV1 = TraceinkArtifactV1 & {
  stage: "index";
  worklineId?: never;
  sourceReflection?: never;
};

export type TraceinkIndexArtifactDraftV1 = Omit<
  TraceinkIndexArtifactV1,
  "id" | "revision" | "outputHash"
>;

export type TraceinkDossierArtifactV1 = TraceinkArtifactV1 & {
  stage: "dossier";
  worklineId: string;
  sourceReflection?: never;
};

export type TraceinkDossierArtifactDraftV1 = Omit<
  TraceinkDossierArtifactV1,
  "id" | "revision" | "outputHash"
>;

export type TraceinkProposalsArtifactV1 = Omit<
  TraceinkArtifactV1,
  "stage" | "worklineId" | "sourceReflection" | "navigation"
> & {
  stage: "proposals";
  worklineId: string;
  sourceReflection: UserReflectionAssetReferenceV1;
  navigation: TraceinkProposalNavigationItemV1[];
};

export type TraceinkProposalsArtifactDraftV1 = Omit<
  TraceinkProposalsArtifactV1,
  "id" | "revision" | "outputHash"
>;

export interface TraceinkWorklineSelectionV1 {
  worklineId: string;
  ordinal: number;
  title: string;
  sourceIndex: TraceinkArtifactReferenceV1 & { stage: "index" };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOGICAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRACEINK_STAGES = new Set<TraceinkStage>(["index", "dossier", "proposals"]);
const EVIDENCE_KINDS = new Set<TraceinkEvidenceRefV1["kind"]>([
  "session",
  "document",
  "code",
  "test",
  "experiment",
  "artifact"
]);
const COVERAGE_DISPOSITIONS = new Set<TraceinkCoverageEntryV1["disposition"]>([
  "read",
  "skipped",
  "deduplicated",
  "truncated",
  "failed"
]);
export const TRACEINK_PROPOSAL_CATEGORIES = [
  "judgment",
  "tomorrow",
  "ctx",
  "background",
  "today-only"
] as const satisfies readonly TraceinkProposalCategoryV1[];
const PROPOSAL_CATEGORIES = new Set<TraceinkProposalCategoryV1>(TRACEINK_PROPOSAL_CATEGORIES);
const PROPOSAL_DISPOSITION_ACTIONS = new Set<TraceinkProposalDispositionActionV1>([
  "accept",
  "dismiss",
  "defer",
  "rewrite"
]);
const STORAGE_DIAGNOSTIC_PREFIX = "Traceink storage diagnostic:";

interface SidecarNormalization<T> {
  items: T[];
  unavailable: boolean;
  blocked: number;
}

interface NavigationNormalization extends SidecarNormalization<
  TraceinkNavigationItemV1 | TraceinkProposalNavigationItemV1
> {
  blockedEvidenceReferences: number;
}

/** Hashes the exact UTF-8 bytes represented by a JavaScript string. */
export function sha256TraceinkText(text: string): Sha256 {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function traceinkArtifactReference(artifact: TraceinkArtifactV1): TraceinkArtifactReferenceV1 {
  return {
    artifactId: artifact.id,
    stage: artifact.stage,
    revision: artifact.revision,
    outputHash: artifact.outputHash
  };
}

export function userReflectionAssetReference(asset: UserReflectionAssetV1): UserReflectionAssetReferenceV1 {
  return {
    reflectionId: asset.id,
    revision: asset.revision,
    contentHash: asset.contentHash
  };
}

export function normalizeTraceinkArtifactReferenceV1(value: unknown): TraceinkArtifactReferenceV1 | undefined {
  const raw = asRecord(value);
  const artifactId = nonEmptyString(raw?.artifactId);
  const stage = traceinkStage(raw?.stage);
  const revision = positiveInteger(raw?.revision);
  const outputHash = sha256(raw?.outputHash);
  if (!artifactId || !stage || !revision || !outputHash) return undefined;
  return { artifactId, stage, revision, outputHash };
}

export function normalizeUserReflectionAssetReferenceV1(
  value: unknown
): UserReflectionAssetReferenceV1 | undefined {
  const raw = asRecord(value);
  const reflectionId = nonEmptyString(raw?.reflectionId);
  const revision = positiveInteger(raw?.revision);
  const contentHash = sha256(raw?.contentHash);
  if (!reflectionId || !revision || !contentHash) return undefined;
  return { reflectionId, revision, contentHash };
}

/**
 * Loads a stored generated artifact without interpreting its prose. Provenance,
 * identity, hashes, and stage-to-input references are integrity boundaries.
 * Navigation and coverage are fallible sidecars and may safely degrade to empty.
 */
export function normalizeTraceinkArtifactV1(value: unknown): TraceinkArtifactV1 | undefined {
  const raw = asRecord(value);
  if (!raw || raw.schemaVersion !== 1) return undefined;

  const id = nonEmptyString(raw.id);
  const logicalDate = logicalDateString(raw.logicalDate);
  const stage = traceinkStage(raw.stage);
  const revision = positiveInteger(raw.revision);
  const producer = normalizeProducer(raw.producer, logicalDate);
  const inputEvidenceHash = sha256(raw.inputEvidenceHash);
  const rawMarkdown = typeof raw.rawMarkdown === "string" ? raw.rawMarkdown : undefined;
  const outputHash = sha256(raw.outputHash);
  if (
    !id ||
    !logicalDate ||
    !stage ||
    !revision ||
    !producer ||
    !inputEvidenceHash ||
    rawMarkdown === undefined ||
    !outputHash ||
    outputHash !== sha256TraceinkText(rawMarkdown)
  ) return undefined;

  const worklineId = raw.worklineId === undefined ? undefined : nonEmptyString(raw.worklineId);
  if (raw.worklineId !== undefined && !worklineId) return undefined;
  if (stage === "index" && worklineId) return undefined;
  if ((stage === "dossier" || stage === "proposals") && !worklineId) return undefined;

  const sourceReflection = raw.sourceReflection === undefined
    ? undefined
    : normalizeUserReflectionAssetReferenceV1(raw.sourceReflection);
  if (raw.sourceReflection !== undefined && !sourceReflection) return undefined;
  if (stage !== "proposals" && sourceReflection) return undefined;
  if (stage === "proposals" && !sourceReflection) return undefined;

  const evidenceResult = normalizeEvidence(raw.evidence);
  const evidence = evidenceResult.items;
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const coverageResult = normalizeCoverage(raw.coverage);
  const navigationResult = normalizeNavigation(raw.navigation, evidenceIds);
  const storedWarnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const warnings = appendUniqueStrings(storedWarnings, sidecarDiagnostics({
    evidence: evidenceResult,
    coverage: coverageResult,
    navigation: navigationResult,
    warningsUnavailable: !Array.isArray(raw.warnings),
    blockedWarnings: Array.isArray(raw.warnings) ? raw.warnings.length - storedWarnings.length : 0
  }));

  return {
    schemaVersion: 1,
    id,
    logicalDate,
    stage,
    ...(worklineId ? { worklineId } : {}),
    ...(sourceReflection ? { sourceReflection } : {}),
    revision,
    producer,
    inputEvidenceHash,
    rawMarkdown,
    outputHash,
    coverage: coverageResult.items,
    evidence,
    navigation: navigationResult.items,
    warnings
  };
}

export function normalizeUserReflectionAssetV1(value: unknown): UserReflectionAssetV1 | undefined {
  const raw = asRecord(value);
  if (!raw || raw.schemaVersion !== 1) return undefined;
  const id = nonEmptyString(raw.id);
  const logicalDate = logicalDateString(raw.logicalDate);
  const worklineId = nonEmptyString(raw.worklineId);
  const dossier = normalizeTraceinkArtifactReferenceV1(raw.dossier);
  const revision = positiveInteger(raw.revision);
  const text = typeof raw.text === "string" ? raw.text : undefined;
  const createdAt = timestamp(raw.createdAt);
  const savedAt = timestamp(raw.savedAt);
  const contentHash = sha256(raw.contentHash);
  if (
    !id ||
    !logicalDate ||
    !worklineId ||
    !dossier ||
    dossier.stage !== "dossier" ||
    !revision ||
    text === undefined ||
    !createdAt ||
    !savedAt ||
    Date.parse(savedAt) < Date.parse(createdAt) ||
    !contentHash ||
    contentHash !== sha256TraceinkText(text)
  ) return undefined;
  return {
    schemaVersion: 1,
    id,
    logicalDate,
    worklineId,
    dossier: { ...dossier, stage: "dossier" },
    revision,
    text,
    createdAt,
    savedAt,
    contentHash
  };
}

export function normalizeTraceinkProposalDispositionV1(
  value: unknown
): TraceinkProposalDispositionV1 | undefined {
  const raw = asRecord(value);
  if (!raw || raw.schemaVersion !== 1) return undefined;
  const id = nonEmptyString(raw.id);
  const logicalDate = logicalDateString(raw.logicalDate);
  const worklineId = nonEmptyString(raw.worklineId);
  const proposalArtifact = normalizeTraceinkArtifactReferenceV1(raw.proposalArtifact);
  const proposalId = nonEmptyString(raw.proposalId);
  const category = proposalCategory(raw.category);
  const revision = positiveInteger(raw.revision);
  const action = proposalDispositionAction(raw.action);
  const rewriteText = raw.rewriteText === undefined ? undefined : nonEmptyStringPreservingBytes(raw.rewriteText);
  const decidedAt = timestamp(raw.decidedAt);
  if (
    !id ||
    !logicalDate ||
    !worklineId ||
    !proposalArtifact ||
    proposalArtifact.stage !== "proposals" ||
    !proposalId ||
    !category ||
    !revision ||
    !action ||
    !decidedAt ||
    (action === "rewrite" ? !rewriteText : raw.rewriteText !== undefined)
  ) return undefined;
  return {
    schemaVersion: 1,
    id,
    logicalDate,
    worklineId,
    proposalArtifact: { ...proposalArtifact, stage: "proposals" },
    proposalId,
    category,
    revision,
    action,
    ...(rewriteText !== undefined ? { rewriteText } : {}),
    decidedAt
  };
}

export function isTraceinkLogicalDate(value: unknown): value is string {
  return Boolean(logicalDateString(value));
}

function normalizeProducer(value: unknown, logicalDate?: string): TraceinkProducerRefV1 | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const provider = raw.provider === "codex" || raw.provider === "claude" ? raw.provider : undefined;
  const model = nonEmptyString(raw.model);
  const reasoningConfiguration = raw.reasoningConfiguration === undefined
    ? undefined
    : nonEmptyString(raw.reasoningConfiguration);
  const startedAt = timestamp(raw.startedAt);
  const completedAt = timestamp(raw.completedAt);
  const skill = normalizeSkill(raw.skill);
  const scope = raw.scope === undefined ? undefined : normalizeReviewScope(raw.scope, logicalDate);
  if (
    !provider ||
    !model ||
    (raw.reasoningConfiguration !== undefined && !reasoningConfiguration) ||
    !startedAt ||
    !completedAt ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    !skill ||
    (raw.scope !== undefined && !scope)
  ) return undefined;
  return {
    provider,
    model,
    ...(reasoningConfiguration ? { reasoningConfiguration } : {}),
    startedAt,
    completedAt,
    skill,
    ...(scope ? { scope } : {})
  };
}

function normalizeReviewScope(value: unknown, logicalDate?: string): TraceinkReviewScopeV1 | undefined {
  const raw = asRecord(value);
  if (!raw) return undefined;
  const timeZone = nonEmptyString(raw.timeZone);
  const startInclusive = timestamp(raw.startInclusive);
  const endExclusive = timestamp(raw.endExclusive);
  const evidenceCutoff = timestamp(raw.evidenceCutoff);
  if (
    !timeZone ||
    !isIanaTimeZone(timeZone) ||
    !startInclusive ||
    !endExclusive ||
    !evidenceCutoff ||
    Date.parse(endExclusive) <= Date.parse(startInclusive) ||
    Date.parse(evidenceCutoff) < Date.parse(startInclusive) ||
    (logicalDate !== undefined && !scopeMatchesLogicalDate(logicalDate, timeZone, startInclusive, endExclusive))
  ) return undefined;
  return { timeZone, startInclusive, endExclusive, evidenceCutoff };
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function scopeMatchesLogicalDate(
  logicalDate: string,
  timeZone: string,
  startInclusive: string,
  endExclusive: string
): boolean {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = (timestamp: string): Record<string, string> => Object.fromEntries(
    formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  const start = parts(startInclusive);
  const end = parts(endExclusive);
  const next = new Date(`${logicalDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextLogicalDate = next.toISOString().slice(0, 10);
  return `${start.year}-${start.month}-${start.day}` === logicalDate &&
    `${start.hour}:${start.minute}:${start.second}` === "00:00:00" &&
    `${end.year}-${end.month}-${end.day}` === nextLogicalDate &&
    `${end.hour}:${end.minute}:${end.second}` === "00:00:00";
}

function normalizeSkill(value: unknown): TraceinkSkillBundleRefV1 | undefined {
  const raw = asRecord(value);
  if (!raw || raw.packageId !== "traceink") return undefined;
  const version = nonEmptyString(raw.version);
  const skillHash = sha256(raw.skillHash);
  const editorialContractHash = sha256(raw.editorialContractHash);
  if (!version || !skillHash || !editorialContractHash) return undefined;
  return { packageId: "traceink", version, skillHash, editorialContractHash };
}

function normalizeEvidence(value: unknown): SidecarNormalization<TraceinkEvidenceRefV1> {
  if (!Array.isArray(value)) return { items: [], unavailable: true, blocked: 0 };
  const evidence: TraceinkEvidenceRefV1[] = [];
  const seen = new Set<string>();
  let blocked = 0;
  for (const candidate of value) {
    const raw = asRecord(candidate);
    const id = nonEmptyString(raw?.id);
    const kind = evidenceKind(raw?.kind);
    const path = nonEmptyString(raw?.path);
    const locator = nonEmptyString(raw?.locator);
    const provider = raw?.provider === undefined
      ? undefined
      : raw.provider === "codex" || raw.provider === "claude" ? raw.provider : undefined;
    const sessionId = raw?.sessionId === undefined ? undefined : nonEmptyString(raw.sessionId);
    const contentHash = raw?.contentHash === undefined ? undefined : sha256(raw.contentHash);
    if (
      !raw ||
      !id ||
      !kind ||
      !path ||
      !locator ||
      (raw.provider !== undefined && !provider) ||
      (raw.sessionId !== undefined && !sessionId) ||
      (raw.contentHash !== undefined && !contentHash) ||
      (kind === "session" && (!provider || !sessionId)) ||
      seen.has(id)
    ) {
      blocked += 1;
      continue;
    }
    seen.add(id);
    evidence.push({
      id,
      kind,
      ...(provider ? { provider } : {}),
      ...(sessionId ? { sessionId } : {}),
      path,
      locator,
      ...(contentHash ? { contentHash } : {})
    });
  }
  return { items: evidence, unavailable: false, blocked };
}

function normalizeCoverage(value: unknown): SidecarNormalization<TraceinkCoverageEntryV1> {
  if (!Array.isArray(value)) return { items: [], unavailable: true, blocked: 0 };
  const coverage: TraceinkCoverageEntryV1[] = [];
  let blocked = 0;
  for (const candidate of value) {
    const raw = asRecord(candidate);
    const sourceId = nonEmptyString(raw?.sourceId);
    const disposition = coverageDisposition(raw?.disposition);
    const detail = typeof raw?.detail === "string" ? raw.detail : undefined;
    if (sourceId && disposition && detail !== undefined) coverage.push({ sourceId, disposition, detail });
    else blocked += 1;
  }
  return { items: coverage, unavailable: false, blocked };
}

function normalizeNavigation(
  value: unknown,
  evidenceIds: ReadonlySet<string>
): NavigationNormalization {
  if (!Array.isArray(value)) {
    return { items: [], unavailable: true, blocked: 0, blockedEvidenceReferences: 0 };
  }
  const navigation: Array<TraceinkNavigationItemV1 | TraceinkProposalNavigationItemV1> = [];
  const seen = new Set<string>();
  let blocked = 0;
  let blockedEvidenceReferences = 0;
  for (const candidate of value) {
    const raw = asRecord(candidate);
    const id = nonEmptyString(raw?.id);
    const markdownAnchor = nonEmptyString(raw?.markdownAnchor);
    if (!raw || !id || !markdownAnchor || !Array.isArray(raw.evidenceIds) || seen.has(id)) {
      blocked += 1;
      continue;
    }
    const referencedEvidenceIds: string[] = [];
    const seenEvidenceIds = new Set<string>();
    for (const evidenceId of raw.evidenceIds) {
      if (
        typeof evidenceId !== "string" ||
        !evidenceId ||
        seenEvidenceIds.has(evidenceId) ||
        !evidenceIds.has(evidenceId)
      ) {
        blockedEvidenceReferences += 1;
        continue;
      }
      seenEvidenceIds.add(evidenceId);
      referencedEvidenceIds.push(evidenceId);
    }
    const category = proposalCategory(raw.category);
    const proposalText = nonEmptyString(raw.proposalText);
    const sourceQuote = nonEmptyString(raw.sourceQuote);
    seen.add(id);
    const hasProposalMetadata = hasOwn(raw, "category") || hasOwn(raw, "proposalText") || hasOwn(raw, "sourceQuote");
    if (hasProposalMetadata && (!category || !proposalText || !sourceQuote)) {
      blocked += 1;
      continue;
    }
    if (category && proposalText && sourceQuote) {
      navigation.push({ id, markdownAnchor, evidenceIds: referencedEvidenceIds, category, proposalText, sourceQuote });
    } else {
      navigation.push({ id, markdownAnchor, evidenceIds: referencedEvidenceIds });
    }
  }
  return { items: navigation, unavailable: false, blocked, blockedEvidenceReferences };
}

function sidecarDiagnostics(input: {
  evidence: SidecarNormalization<TraceinkEvidenceRefV1>;
  coverage: SidecarNormalization<TraceinkCoverageEntryV1>;
  navigation: NavigationNormalization;
  warningsUnavailable: boolean;
  blockedWarnings: number;
}): string[] {
  const diagnostics: string[] = [];
  if (input.evidence.unavailable) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} evidence sidecar is unavailable; rawMarkdown remains authoritative.`);
  } else if (input.evidence.blocked > 0) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} blocked ${input.evidence.blocked} malformed or duplicate evidence reference(s).`);
  }
  if (input.coverage.unavailable) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} coverage sidecar is unavailable; coverage may be incomplete.`);
  } else if (input.coverage.blocked > 0) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} blocked ${input.coverage.blocked} malformed coverage entr${input.coverage.blocked === 1 ? "y" : "ies"}.`);
  }
  if (input.navigation.unavailable) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} navigation sidecar is unavailable; rawMarkdown remains readable.`);
  } else {
    if (input.navigation.blocked > 0) {
      diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} blocked ${input.navigation.blocked} malformed or duplicate navigation item(s).`);
    }
    if (input.navigation.blockedEvidenceReferences > 0) {
      diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} blocked ${input.navigation.blockedEvidenceReferences} unresolved navigation evidence reference(s).`);
    }
  }
  if (input.warningsUnavailable) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} producer warnings sidecar is unavailable.`);
  } else if (input.blockedWarnings > 0) {
    diagnostics.push(`${STORAGE_DIAGNOSTIC_PREFIX} blocked ${input.blockedWarnings} malformed producer warning(s).`);
  }
  return diagnostics;
}

function appendUniqueStrings(existing: string[], additions: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...existing, ...additions]) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function sha256(value: unknown): Sha256 | undefined {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function logicalDateString(value: unknown): string | undefined {
  if (typeof value !== "string" || !LOGICAL_DATE_PATTERN.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
    ? value
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function traceinkStage(value: unknown): TraceinkStage | undefined {
  return typeof value === "string" && TRACEINK_STAGES.has(value as TraceinkStage)
    ? value as TraceinkStage
    : undefined;
}

function evidenceKind(value: unknown): TraceinkEvidenceRefV1["kind"] | undefined {
  return typeof value === "string" && EVIDENCE_KINDS.has(value as TraceinkEvidenceRefV1["kind"])
    ? value as TraceinkEvidenceRefV1["kind"]
    : undefined;
}

function coverageDisposition(value: unknown): TraceinkCoverageEntryV1["disposition"] | undefined {
  return typeof value === "string" && COVERAGE_DISPOSITIONS.has(value as TraceinkCoverageEntryV1["disposition"])
    ? value as TraceinkCoverageEntryV1["disposition"]
    : undefined;
}

function proposalCategory(value: unknown): TraceinkProposalNavigationItemV1["category"] | undefined {
  return typeof value === "string" && PROPOSAL_CATEGORIES.has(value as TraceinkProposalNavigationItemV1["category"])
    ? value as TraceinkProposalNavigationItemV1["category"]
    : undefined;
}

function proposalDispositionAction(value: unknown): TraceinkProposalDispositionActionV1 | undefined {
  return typeof value === "string" && PROPOSAL_DISPOSITION_ACTIONS.has(value as TraceinkProposalDispositionActionV1)
    ? value as TraceinkProposalDispositionActionV1
    : undefined;
}

function nonEmptyStringPreservingBytes(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
