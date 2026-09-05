import type { SessionTranscriptState } from "../app/desktop/api";
import type { AgentWorkSession } from "./types";

export type ActivityConfidence = "observed" | "uncertain";

export interface SessionActivitySource {
  session: AgentWorkSession;
  transcript: Pick<SessionTranscriptState, "messages" | "activityWindows" | "omittedToolEvents" | "truncated" | "warning">;
}

export interface UserIntervention {
  id: string;
  timestamp: string;
}

export interface AgentActivityWindow {
  start: string;
  end: string;
  durationMs: number;
  basis: "provider-task" | "provider-item" | "tool-execution";
  coverage: "observed";
}

export interface SessionActivityLane {
  identity: string;
  sessionId: string;
  platform: AgentWorkSession["platform"];
  path: string;
  operationalState: "running" | "not-running";
  confidence: ActivityConfidence;
  timeRange?: { start: string; end: string };
  userInterventions: UserIntervention[];
  agentActivityWindows: AgentActivityWindow[];
  warnings: string[];
}

export interface DailyActivityFacts {
  userInterventionCount: number;
  observedAgentActivityMs: number;
  observedConcurrentAgentActivityMs: number;
  peakObservedAgentConcurrency: number;
  contextSwitchCount: number;
  confidence: ActivityConfidence;
  basis: {
    userInterventions: "host-classified-human-main-session-messages";
    agentActivity: "union-of-provider-events-and-tool-windows";
    concurrency: "overlap-of-provider-activity-windows";
    contextSwitches: "chronological-timestamped-user-session-transitions";
  };
}

export interface DailySessionActivity {
  logicalDate: string;
  lanes: SessionActivityLane[];
  facts: DailyActivityFacts;
}

export function projectDailySessionActivity(input: {
  logicalDate: string;
  sessions: SessionActivitySource[];
  timeZone?: string;
}): DailySessionActivity {
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lanes = input.sessions.map((source) => projectSessionActivityLane({
    logicalDate: input.logicalDate,
    source,
    ...(input.timeZone ? { timeZone } : {})
  }));
  return summarizeDailySessionActivity({ logicalDate: input.logicalDate, lanes });
}

export function projectSessionActivityLane(input: {
  logicalDate: string;
  source: SessionActivitySource;
  timeZone?: string;
}): SessionActivityLane {
  return projectLane(input.logicalDate, input.source, input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
}

export function summarizeDailySessionActivity(input: {
  logicalDate: string;
  lanes: SessionActivityLane[];
}): DailySessionActivity {
  const lanes = input.lanes;
  const windows = lanes.flatMap((lane) => lane.agentActivityWindows.map((window) => ({
    start: Date.parse(window.start),
    end: Date.parse(window.end)
  })));
  const measurements = measureWindows(windows);
  const chronologicalUserEvents = lanes
    .flatMap((lane) => lane.userInterventions.map((event) => ({ identity: lane.identity, timestamp: event.timestamp, time: Date.parse(event.timestamp) })))
    .sort((left, right) => left.time - right.time || left.identity.localeCompare(right.identity));
  const facts: DailyActivityFacts = {
    userInterventionCount: chronologicalUserEvents.length,
    observedAgentActivityMs: measurements.unionMs,
    observedConcurrentAgentActivityMs: measurements.concurrentMs,
    peakObservedAgentConcurrency: measurements.peakConcurrency,
    contextSwitchCount: countContextSwitches(chronologicalUserEvents),
    confidence: lanes.every((lane) => lane.confidence === "observed") ? "observed" : "uncertain",
    basis: {
      userInterventions: "host-classified-human-main-session-messages",
      agentActivity: "union-of-provider-events-and-tool-windows",
      concurrency: "overlap-of-provider-activity-windows",
      contextSwitches: "chronological-timestamped-user-session-transitions"
    }
  };
  return { logicalDate: input.logicalDate, lanes, facts };
}

function projectLane(logicalDate: string, source: SessionActivitySource, timeZone: string): SessionActivityLane {
  const messages = source.transcript.messages;
  const warnings: string[] = [];
  if (source.transcript.warning) warnings.push(source.transcript.warning);
  const parsed = messages.map((message) => ({ ...message, time: parseTimestamp(message.timestamp) }));
  const hasMissingTimestamp = parsed.some((message) => message.time === undefined);
  const hasReversedTimestamp = hasReverseTimestamp(parsed);
  const hasNoMessages = messages.length === 0;
  if (source.transcript.truncated) warnings.push("会话记录为有界读取，活动覆盖不完整。");
  if (hasNoMessages) warnings.push("没有可用于活动判断的用户或助手消息。");
  if (hasMissingTimestamp) warnings.push("部分用户或助手消息缺少可用时间戳，无法推断持续时间。");
  if (hasReversedTimestamp) warnings.push("部分消息时间戳顺序异常；有效 provider 活动窗口仍单独计量。");

  const dailyMessages = parsed.filter((message) => message.time !== undefined && dateInTimeZone(message.time, timeZone) === logicalDate);
  const userInterventions = dailyMessages
    .filter((message) =>
      message.role === "user" &&
      message.authorKind === "human" &&
      source.session.lineage?.origin === "primary"
    )
    .map((message) => ({ id: message.id, timestamp: message.timestamp as string }));
  const day = logicalDayBounds(logicalDate, timeZone);
  const providerActivityWindows = source.transcript.activityWindows ?? [];
  const agentActivityWindows = providerActivityWindows.flatMap((window) => {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const clippedStart = Math.max(start, day.start);
    const clippedEnd = Math.min(end, day.end);
    if (clippedEnd <= clippedStart) return [];
    return [{
      start: new Date(clippedStart).toISOString(),
      end: new Date(clippedEnd).toISOString(),
      durationMs: clippedEnd - clippedStart,
      basis: window.basis,
      coverage: "observed" as const
    }];
  });
  if (source.transcript.omittedToolEvents > 0 && !providerActivityWindows.some((window) => window.basis === "tool-execution")) {
    warnings.push("检测到工具事件，但 provider 记录没有提供可配对的完整工具执行窗口。");
  }
  const observedTimes = [
    ...dailyMessages.map((message) => message.time as number),
    ...agentActivityWindows.flatMap((window) => [Date.parse(window.start), Date.parse(window.end)])
  ].sort((left, right) => left - right);
  const timeRange = observedTimes.length > 0
    ? { start: new Date(observedTimes[0]!).toISOString(), end: new Date(observedTimes.at(-1)!).toISOString() }
    : undefined;
  const confidence: ActivityConfidence = hasNoMessages || hasMissingTimestamp || hasReversedTimestamp || source.transcript.truncated || (messages.length > 0 && observedTimes.length === 0)
    ? "uncertain"
    : "observed";
  if (messages.length > 0 && observedTimes.length === 0 && warnings.length === 0) warnings.push("没有属于当前日期的可用活动时间戳。");

  return {
    identity: sessionIdentity(source.session),
    sessionId: source.session.id,
    platform: source.session.platform,
    path: source.session.path,
    operationalState: source.session.status === "active" ? "running" : "not-running",
    confidence,
    ...(timeRange ? { timeRange } : {}),
    userInterventions,
    agentActivityWindows,
    warnings
  };
}

function hasReverseTimestamp(messages: Array<{ time: number | undefined }>): boolean {
  let previous: number | undefined;
  for (const message of messages) {
    if (message.time === undefined) continue;
    if (previous !== undefined && message.time < previous) return true;
    previous = message.time;
  }
  return false;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function dateInTimeZone(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function logicalDayBounds(logicalDate: string, timeZone: string): { start: number; end: number } {
  const start = zonedMidnight(logicalDate, timeZone);
  const next = new Date(`${logicalDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDate = next.toISOString().slice(0, 10);
  return { start, end: zonedMidnight(nextDate, timeZone) };
}

function zonedMidnight(logicalDate: string, timeZone: string): number {
  const [year, month, day] = logicalDate.split("-").map(Number);
  const desired = Date.UTC(year!, month! - 1, day!);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(guess));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const represented = Date.UTC(
      Number(values.get("year")),
      Number(values.get("month")) - 1,
      Number(values.get("day")),
      Number(values.get("hour")),
      Number(values.get("minute")),
      Number(values.get("second"))
    );
    guess += desired - represented;
  }
  return guess;
}

function sessionIdentity(session: AgentWorkSession): string {
  return `${session.platform}:${session.id}:${session.path}`;
}

function measureWindows(windows: Array<{ start: number; end: number }>): { unionMs: number; concurrentMs: number; peakConcurrency: number } {
  const boundaries = [...new Set(windows.flatMap((window) => [window.start, window.end]))].sort((left, right) => left - right);
  let unionMs = 0;
  let concurrentMs = 0;
  let peakConcurrency = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const concurrency = windows.filter((window) => window.start <= start && window.end > start).length;
    if (concurrency > 0) unionMs += end - start;
    if (concurrency > 1) concurrentMs += end - start;
    peakConcurrency = Math.max(peakConcurrency, concurrency);
  }
  return { unionMs, concurrentMs, peakConcurrency };
}

function countContextSwitches(events: Array<{ identity: string }>): number {
  let switches = 0;
  let previous: string | undefined;
  for (const event of events) {
    if (previous !== undefined && event.identity !== previous) switches += 1;
    previous = event.identity;
  }
  return switches;
}
