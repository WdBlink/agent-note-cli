import type { TodayBoardMode } from "./today-board";

export const DEFAULT_DAILY_REVIEW_SCHEDULE_TIME = "18:30";

export type DailyReviewPreparationStatus = "off" | "scheduled" | "preparing" | "ready" | "failed";
export type DailyReviewPreparationTrigger = "manual" | "scheduled";

export interface DailyReviewActiveRun {
  logicalDate: string;
  status: "preparing";
  trigger: DailyReviewPreparationTrigger;
  startedAt: string;
}

export interface DailyReviewPreparationState {
  enabled: boolean;
  time: string;
  logicalDate: string;
  status: DailyReviewPreparationStatus;
  scheduledFor?: string;
  trigger?: DailyReviewPreparationTrigger;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
}

export interface AutomaticDailyReviewInput {
  enabled: boolean;
  time: string;
  logicalDate: string;
  now: Date;
  sessionCount: number;
  boardMode: TodayBoardMode;
  hasFailure: boolean;
  inFlight: boolean;
  attempted: boolean;
}

export function normalizeDailyReviewScheduleTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return DEFAULT_DAILY_REVIEW_SCHEDULE_TIME;
  const [hours, minutes] = value.split(":").map(Number);
  return hours! >= 0 && hours! <= 23 && minutes! >= 0 && minutes! <= 59
    ? value
    : DEFAULT_DAILY_REVIEW_SCHEDULE_TIME;
}

export function shouldStartAutomaticDailyReview(input: AutomaticDailyReviewInput): boolean {
  if (!input.enabled || input.sessionCount === 0 || input.boardMode !== "raw") return false;
  if (input.hasFailure || input.inFlight || input.attempted) return false;
  if (localDate(input.now) !== input.logicalDate) return false;
  return localTime(input.now) >= normalizeDailyReviewScheduleTime(input.time);
}

export function shouldScheduleSessionSummaries(boardMode: TodayBoardMode): boolean {
  return boardMode === "compiled" || boardMode === "sealed";
}

export function deriveDailyReviewPreparationState(input: {
  enabled: boolean;
  time: string;
  logicalDate: string;
  today: string;
  boardMode: TodayBoardMode;
  sessionCount: number;
  compilationError?: string;
  activeRun?: DailyReviewActiveRun;
}): DailyReviewPreparationState {
  const time = normalizeDailyReviewScheduleTime(input.time);
  const base = { enabled: input.enabled, time, logicalDate: input.logicalDate };
  if (input.activeRun?.logicalDate === input.logicalDate) {
    return {
      ...base,
      status: "preparing",
      trigger: input.activeRun.trigger,
      startedAt: input.activeRun.startedAt
    };
  }
  if (input.boardMode === "compiled" || input.boardMode === "stale" || input.boardMode === "sealed") {
    return { ...base, status: "ready" };
  }
  if (input.compilationError) return { ...base, status: "failed", message: input.compilationError };
  if (input.enabled && input.logicalDate === input.today && input.sessionCount > 0) {
    return { ...base, status: "scheduled", scheduledFor: `${input.logicalDate}T${time}` };
  }
  return { ...base, status: "off" };
}

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
