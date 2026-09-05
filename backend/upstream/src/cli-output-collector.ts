import { StringDecoder } from "node:string_decoder";

export type CliStdoutMode = "buffered" | "codex-jsonl" | "single-json";

const MAX_FINAL_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CODEX_EVENT_BYTES = MAX_FINAL_OUTPUT_BYTES + 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

export class CliProtocolError extends Error {
  readonly code: "final-output-too-large";

  constructor(code: CliProtocolError["code"], message: string) {
    super(message);
    this.name = "CliProtocolError";
    this.code = code;
  }
}

export interface CliOutputSnapshot {
  stdout: string;
  stderr: string;
}

export interface CliOutputCollector {
  pushStdout(chunk: Buffer | string | unknown): void;
  pushStderr(chunk: Buffer | string | unknown): void;
  finish(): CliOutputSnapshot;
}

export function createCliOutputCollector(mode: CliStdoutMode = "buffered"): CliOutputCollector {
  return mode === "codex-jsonl" ? new CodexJsonlCollector() : new FinalEnvelopeCollector(mode);
}

export function structuredCliError(value: string): string {
  let result = "";
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const error = asRecord(event.error);
      const item = asRecord(event.item);
      const errorList = Array.isArray(event.errors)
        ? event.errors.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8)
        : [];
      const candidate =
        (event.type === "turn.failed" && typeof error?.message === "string" ? error.message : "") ||
        (event.type === "error" && typeof event.message === "string" ? event.message : "") ||
        (item?.type === "error" && typeof item.message === "string" ? item.message : "") ||
        (event.is_error === true && typeof event.result === "string" ? event.result : "") ||
        (typeof event.subtype === "string" && event.subtype.startsWith("error_") && typeof event.result === "string" ? event.result : "") ||
        (event.is_error === true && errorList.length > 0 ? errorList.join("; ") : "") ||
        (typeof error?.message === "string" ? error.message : "");
      if (candidate) result = nestedErrorMessage(candidate);
    } catch {
      // Provider stdout can contain ordinary progress lines; only valid structured errors are admitted.
    }
  }
  return compactTail(result, 500);
}

class FinalEnvelopeCollector implements CliOutputCollector {
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdout = "";
  private stderr = "";
  private finished = false;

  constructor(private readonly mode: "buffered" | "single-json") {}

  pushStdout(chunk: Buffer | string | unknown): void {
    this.assertOpen();
    const buffer = toBuffer(chunk);
    const next = this.stdoutDecoder.write(buffer);
    if (Buffer.byteLength(this.stdout) + Buffer.byteLength(next) > MAX_FINAL_OUTPUT_BYTES) {
      throw new CliProtocolError("final-output-too-large", "CLI 最终结果超过 4 MB 限制");
    }
    this.stdout += next;
  }

  pushStderr(chunk: Buffer | string | unknown): void {
    this.assertOpen();
    const buffer = toBuffer(chunk);
    this.stderr = appendUtf8Tail(this.stderr, this.stderrDecoder.write(buffer), MAX_STDERR_BYTES);
  }

  finish(): CliOutputSnapshot {
    this.assertOpen();
    this.finished = true;
    const finalStdout = this.stdoutDecoder.end();
    if (Buffer.byteLength(this.stdout) + Buffer.byteLength(finalStdout) > MAX_FINAL_OUTPUT_BYTES) {
      throw new CliProtocolError("final-output-too-large", "CLI 最终结果超过 4 MB 限制");
    }
    this.stdout += finalStdout;
    this.stderr = appendUtf8Tail(this.stderr, this.stderrDecoder.end(), MAX_STDERR_BYTES);
    return { stdout: this.stdout, stderr: this.stderr };
  }

  private assertOpen(): void {
    if (this.finished) throw new Error(`${this.mode} CLI 输出收集器已经结束`);
  }
}

class CodexJsonlCollector implements CliOutputCollector {
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutRemainder = "";
  private stdoutRemainderBytes = 0;
  private oversizedLine = false;
  private oversizedPrefix = "";
  private lastFinalEvent = "";
  private lastErrorEvent = "";
  private stderr = "";
  private finalTooLarge = false;
  private finished = false;

  pushStdout(chunk: Buffer | string | unknown): void {
    this.assertOpen();
    const buffer = toBuffer(chunk);
    this.consume(this.stdoutDecoder.write(buffer));
  }

  pushStderr(chunk: Buffer | string | unknown): void {
    this.assertOpen();
    const buffer = toBuffer(chunk);
    this.stderr = appendUtf8Tail(this.stderr, this.stderrDecoder.write(buffer), MAX_STDERR_BYTES);
  }

  finish(): CliOutputSnapshot {
    this.assertOpen();
    this.finished = true;
    this.consume(this.stdoutDecoder.end());
    this.completeLine();
    this.stderr = appendUtf8Tail(this.stderr, this.stderrDecoder.end(), MAX_STDERR_BYTES);
    if (this.finalTooLarge) {
      throw new CliProtocolError("final-output-too-large", "Codex 最终整理结果超过 4 MB 限制");
    }
    return {
      stdout: [this.lastFinalEvent, this.lastErrorEvent].filter(Boolean).join("\n") + (this.lastFinalEvent || this.lastErrorEvent ? "\n" : ""),
      stderr: this.stderr
    };
  }

  private consume(value: string): void {
    let cursor = 0;
    while (cursor < value.length) {
      const newline = value.indexOf("\n", cursor);
      const end = newline === -1 ? value.length : newline;
      this.appendLineSegment(value.slice(cursor, end));
      if (newline === -1) break;
      this.completeLine();
      cursor = newline + 1;
    }
  }

  private appendLineSegment(segment: string): void {
    if (!segment) return;
    const bytes = Buffer.byteLength(segment);
    if (this.oversizedLine) {
      if (this.oversizedPrefix.length < MAX_ERROR_BYTES) this.oversizedPrefix += segment.slice(0, MAX_ERROR_BYTES - this.oversizedPrefix.length);
      return;
    }
    if (this.stdoutRemainderBytes + bytes > MAX_CODEX_EVENT_BYTES) {
      this.oversizedLine = true;
      const remainingPrefixCharacters = Math.max(0, MAX_ERROR_BYTES - this.stdoutRemainder.length);
      this.oversizedPrefix = `${this.stdoutRemainder.slice(0, MAX_ERROR_BYTES)}${segment.slice(0, remainingPrefixCharacters)}`;
      this.stdoutRemainder = "";
      this.stdoutRemainderBytes = 0;
      return;
    }
    this.stdoutRemainder += segment;
    this.stdoutRemainderBytes += bytes;
  }

  private completeLine(): void {
    if (this.oversizedLine) {
      if (/\"type\"\s*:\s*\"agent_message\"/.test(this.oversizedPrefix)) this.finalTooLarge = true;
      this.resetLine();
      return;
    }
    const line = this.stdoutRemainder.trim();
    this.resetLine();
    if (!line.startsWith("{")) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = asRecord(event.item);
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        if (Buffer.byteLength(item.text) > MAX_FINAL_OUTPUT_BYTES) {
          this.finalTooLarge = true;
          return;
        }
        this.lastFinalEvent = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: item.text } });
        return;
      }
      if (structuredCliError(line)) {
        this.lastErrorEvent = boundedErrorEvent(event);
      }
    } catch {
      // Reasoning and tool progress are intentionally not retained.
    }
  }

  private resetLine(): void {
    this.stdoutRemainder = "";
    this.stdoutRemainderBytes = 0;
    this.oversizedLine = false;
    this.oversizedPrefix = "";
  }

  private assertOpen(): void {
    if (this.finished) throw new Error("Codex CLI 输出收集器已经结束");
  }
}

function boundedErrorEvent(event: Record<string, unknown>): string {
  const error = asRecord(event.error);
  const item = asRecord(event.item);
  const message = structuredCliError(JSON.stringify(event));
  if (event.type === "turn.failed") return JSON.stringify({ type: "turn.failed", error: { message } });
  if (event.type === "error") return JSON.stringify({ type: "error", message });
  if (item?.type === "error") return JSON.stringify({ type: "item.completed", item: { type: "error", message } });
  if (event.is_error === true) return JSON.stringify({ type: "result", is_error: true, result: message });
  return JSON.stringify({ type: "error", message: error?.message ?? message });
}

function appendUtf8Tail(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined) <= maxBytes) return combined;
  const buffer = Buffer.from(combined);
  return buffer.subarray(Math.max(0, buffer.byteLength - maxBytes)).toString("utf8").replace(/^\uFFFD/, "");
}

function toBuffer(chunk: Buffer | string | unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
}

function compactTail(value: string, length: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? compact.slice(-length) : compact;
}

function nestedErrorMessage(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const record = asRecord(JSON.parse(trimmed));
    const nested = asRecord(record?.error);
    if (typeof nested?.message === "string") return nested.message;
    if (typeof record?.message === "string") return record.message;
  } catch {
    // Preserve the outer provider message when its payload is not valid JSON.
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
