import type { AgentPlatform, CockpitData, SessionProvider } from "../../src/types";
import type { DailySessionActivity } from "../../src/session-activity";
import type { DailyReviewPackage } from "../../src/workline-review";
import type { TodayBoardPackageGeneration, TodayBoardProjection } from "../../src/today-board";
import type { DailyReviewPreparationState } from "../../src/daily-review-schedule";
import type { TraceinkReviewProjection } from "../../src/traceink-review-state";
import type { StructuredTodayReviewProjection } from "../../src/structured-today-review-state";
import type { StructuredTodayIndexReferenceV1 } from "./traceink-asset-store";
import type { StructuredTodayProposalDispositionV1 } from "../../src/structured-today-contracts";
import type { TodayWorklineDossierV2, TodayWorklineIndexV2 } from "../../src/structured-today-v2-contracts";
import type {
  TraceinkArtifactReferenceV1,
  TraceinkProposalDispositionActionV1,
  TraceinkWorklineSelectionV1,
  UserReflectionAssetReferenceV1
} from "../../src/traceink-review-assets";

export type DailyReviewPreparationMode = "compile" | "refresh";

export interface DesktopState {
  /** Monotonic within the main-process lifetime; absent in legacy fixtures. */
  stateRevision?: number;
  data: CockpitData;
  activeDate: string;
  activityDates: string[];
  appVersion: string;
  userDataPath: string;
  notebook: DesktopNotebookState;
  activity: DailySessionActivity;
  summaryJob?: DesktopSummaryJob;
  reviewPreparation: DailyReviewPreparationState;
  traceinkReview: TraceinkReviewProjection;
  structuredTodayReview: StructuredTodayReviewProjection;
  structuredTodayProgress: StructuredTodayProgressState;
  structuredTodayV2Candidate: {
    enabled: boolean;
    index?: TodayWorklineIndexV2;
    dossiers: TodayWorklineDossierV2[];
    status: "empty" | "complete" | "partial" | "failed";
    issues: string[];
  };
  traceinkReviewError?: string;
}

export interface StructuredTodayRunProgress {
  runId: string;
  status: "queued" | "running" | "ready" | "failed" | "cancelled";
  stage: string;
  completed: number;
  total: number;
  message?: string;
}

export interface StructuredTodayProgressState {
  index?: StructuredTodayRunProgress;
  dossierByWorklineId: Record<string, StructuredTodayRunProgress>;
  proposalByWorklineId?: Record<string, StructuredTodayRunProgress>;
}

export interface StructuredTodayProgressUpdate {
  logicalDate: string;
  stateRevision: number;
  progress: StructuredTodayProgressState;
}

export type NotebookNoteKind = "thought" | "web" | "note";
export type NotebookDeliveryKind = "card" | "wiki" | "project";

export interface NotebookNoteDelivery {
  kind: NotebookDeliveryKind;
  deliveredAt: string;
  target: string;
  status: "delivered" | "queued";
}

export interface NotebookNote {
  id: string;
  logicalDate: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  body: string;
  kind: NotebookNoteKind;
  sourceLabel: string;
  favorite: boolean;
  deliveries: NotebookNoteDelivery[];
}

export interface DailySessionReference {
  id: string;
  platform: AgentPlatform;
  path: string;
  title: string;
}

export interface DailyWorkRecord {
  id: string;
  projectKey: string;
  projectName: string;
  title: string;
  summary: string;
  changed: string;
  uncertainty: string;
  occurredAt: string;
  sessions: DailySessionReference[];
}

export interface DailyContinuationBookmark {
  id: string;
  title: string;
  projectName: string;
  provider: AgentPlatform;
  sessionId: string;
  sessionPath: string;
  cwd?: string;
  resumeCommand?: string;
}

export interface DailyNotebookPage {
  schemaVersion: 1 | 2 | 3 | 4;
  logicalDate: string;
  status: "unformed" | "draft" | "sealed";
  createdAt?: string;
  updatedAt?: string;
  evidenceCutoff?: string;
  sealedAt?: string;
  workRecords: DailyWorkRecord[];
  reflection: string;
  reviewPackage?: DailyReviewPackage;
  packageGenerations?: TodayBoardPackageGeneration[];
  activePackageGenerationId?: string;
  lastCompilationError?: string;
  worklineReflections: DailyWorklineReflection[];
  bookmarks: DailyContinuationBookmark[];
  structuredCloseout?: StructuredTodaySealedCloseoutV1;
}

export interface StructuredTodaySealedCloseoutV1 {
  index: StructuredTodayIndexReferenceV1;
  dossiers: Array<{ artifactId: string; revision: number; contentHash: string; worklineId: string }>;
  reflections: Array<{ reflectionId: string; revision: number; contentHash: string; worklineId: string }>;
  proposals: Array<{ artifactId: string; revision: number; contentHash: string; worklineId: string }>;
  dispositions: Array<{ dispositionId: string; revision: number; proposalId: string }>;
}

export interface StructuredTodaySealInput {
  index: StructuredTodayIndexReferenceV1;
  bookmarkIds: string[];
}

export interface DailyWorklineReflection {
  packageGenerationId: string;
  worklineId: string;
  text: string;
  updatedAt: string;
}

export interface DesktopNotebookState {
  notes: NotebookNote[];
  page: DailyNotebookPage;
  todayBoard: TodayBoardProjection;
  previewRecords: DailyWorkRecord[];
  continuationCandidates: DailyContinuationBookmark[];
  knowledgeRoot: string;
  knowledgeRawPath: string;
  pendingPreviousDates: string[];
  latestSealedDate?: string;
}

export interface NotebookNoteInput {
  title?: string;
  body: string;
}

export interface DailyDraftInput {
  reflection: string;
  worklineReflections?: Array<Pick<DailyWorklineReflection, "worklineId" | "text">>;
  bookmarkIds: string[];
  expectedActiveGenerationId: string | null;
}

export type DailySealInput = DailyDraftInput;

export interface DesktopSummaryJob {
  status: "idle" | "running" | "complete" | "unavailable";
  total: number;
  completed: number;
  models: { codex: string; claude: string };
  message?: string;
}

export interface DesktopSettingsPatch {
  enabledSessionProviders?: SessionProvider[];
  sessionScanRoots?: string[];
  knowledgeRoot?: string;
  dailyReviewScheduleEnabled?: boolean;
  dailyReviewScheduleTime?: string;
}

export interface TraceinkProposalDispositionInput {
  action: TraceinkProposalDispositionActionV1;
  rewriteText?: string;
}

export interface ProjectContextDocument {
  id: string;
  kind: "overview" | "progress" | "spec" | "decision";
  label: string;
  path: string;
  relativePath: string;
  content: string;
  updatedAt: string;
}

export interface ProjectContextState {
  projectPath: string;
  storePath?: string;
  documents: ProjectContextDocument[];
  warnings: string[];
}

export interface SessionTranscriptRequest {
  id: string;
  platform: AgentPlatform;
  path: string;
  packageRef?: {
    logicalDate: string;
    generationId: string;
    evidenceId: string;
  };
  traceinkRef?: TraceinkArtifactReferenceV1 & {
    logicalDate: string;
    evidenceId: string;
  };
  structuredTodayRef?: StructuredTodayIndexReferenceV1 & {
    logicalDate: string;
    evidenceId: string;
  };
}

export interface SessionTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  /** Display metadata only. Evidence authority is carried by V2 message locators. */
  authorKind?: "human" | "agent" | "automation" | "host-notification" | "unknown";
  content: string;
  timestamp?: string;
}

export interface SessionTranscriptActivityWindow {
  id: string;
  start: string;
  end: string;
  basis: "provider-task" | "provider-item" | "tool-execution";
}

export interface SessionTranscriptState {
  sessionId: string;
  platform: AgentPlatform;
  title: string;
  path: string;
  messages: SessionTranscriptMessage[];
  activityWindows?: SessionTranscriptActivityWindow[];
  omittedToolEvents: number;
  truncated: boolean;
  warning?: string;
}

export interface StructuredTodaySpanRequest {
  owner: {
    kind: "index-v2-candidate" | "dossier-v2-candidate";
    logicalDate: string;
    artifactId: string;
    revision: number;
    contentHash: string;
  };
  statementId: string;
  spanId: string;
}

export interface StructuredTodaySpanState {
  status: "exact";
  owner: StructuredTodaySpanRequest["owner"];
  statementId: string;
  spanId: string;
  evidenceId: string;
  provider: "codex" | "claude";
  sessionId: string;
  role: "user" | "assistant";
  authorKind: "human" | "agent" | "automation" | "host-notification" | "unknown";
  messageKey: string;
  messageLocatorId: string;
  content: string;
  utf16Start: number;
  utf16End: number;
  messages: Array<{
    messageKey: string;
    role: "user" | "assistant";
    authorKind: "human" | "agent" | "automation" | "host-notification" | "unknown";
    content: string;
  }>;
  omittedBefore: number;
  omittedAfter: number;
}

export interface DesktopApi {
  getState(date?: string): Promise<DesktopState>;
  refreshSessions(date?: string): Promise<DesktopState>;
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopState>;
  createNotebookNote(date: string, input: NotebookNoteInput): Promise<DesktopNotebookState>;
  updateNotebookNote(noteId: string, patch: Partial<Pick<NotebookNote, "title" | "body" | "favorite">>): Promise<DesktopNotebookState>;
  deleteNotebookNote(noteId: string): Promise<DesktopNotebookState>;
  exportNotebookNoteCard(noteId: string): Promise<{ notebook: DesktopNotebookState; path: string }>;
  routeNotebookNoteToWiki(noteId: string): Promise<{ notebook: DesktopNotebookState; path: string }>;
  routeNotebookNoteToProject(noteId: string, projectPath: string): Promise<{ notebook: DesktopNotebookState; path: string }>;
  prepareDailyReview(date: string, mode: DailyReviewPreparationMode): Promise<DesktopNotebookState>;
  prepareTraceinkDossier(date: string, selection: TraceinkWorklineSelectionV1): Promise<DesktopState>;
  prepareStructuredTodayDossier(
    date: string,
    index: StructuredTodayIndexReferenceV1,
    worklineId: string
  ): Promise<DesktopState>;
  prepareStructuredTodayV2Candidate(date: string): Promise<DesktopState>;
  prepareStructuredTodayV2DossierCandidate(
    date: string,
    index: StructuredTodayIndexReferenceV1,
    worklineId: string
  ): Promise<DesktopState>;
  saveStructuredTodayReflection(
    date: string,
    index: StructuredTodayIndexReferenceV1,
    worklineId: string,
    text: string
  ): Promise<DesktopState>;
  prepareStructuredTodayProposals(
    date: string,
    index: StructuredTodayIndexReferenceV1,
    worklineId: string
  ): Promise<DesktopState>;
  disposeStructuredTodayProposal(
    date: string,
    proposalArtifact: { artifactId: string; revision: number; contentHash: string },
    proposalId: string,
    input: Pick<StructuredTodayProposalDispositionV1, "action" | "rewriteText">
  ): Promise<DesktopState>;
  sealStructuredTodayPage(date: string, input: StructuredTodaySealInput): Promise<DesktopState>;
  saveTraceinkReflection(date: string, dossier: TraceinkArtifactReferenceV1 & { stage: "dossier" }, text: string): Promise<DesktopState>;
  prepareTraceinkProposals(date: string, reflection: UserReflectionAssetReferenceV1): Promise<DesktopState>;
  disposeTraceinkProposal(
    date: string,
    proposals: TraceinkArtifactReferenceV1 & { stage: "proposals" },
    proposalId: string,
    input: TraceinkProposalDispositionInput
  ): Promise<DesktopState>;
  composeDailyPage(date: string): Promise<DesktopNotebookState>;
  saveDailyDraft(date: string, input: DailyDraftInput): Promise<DesktopNotebookState>;
  sealDailyPage(date: string, input: DailySealInput): Promise<DesktopNotebookState>;
  getProjectContext(projectPath: string): Promise<ProjectContextState>;
  getSessionTranscript(request: SessionTranscriptRequest): Promise<SessionTranscriptState>;
  getStructuredTodaySpan(request: StructuredTodaySpanRequest): Promise<StructuredTodaySpanState>;
  chooseDirectory(): Promise<string | null>;
  copyText(text: string): Promise<boolean>;
  openPath(path: string, reveal?: boolean): Promise<boolean>;
  subscribeState(listener: (state: DesktopState) => void): () => void;
  subscribeStructuredProgress?(listener: (update: StructuredTodayProgressUpdate) => void): () => void;
}

declare global {
  interface Window {
    agentWhiteboard: DesktopApi;
  }
}
