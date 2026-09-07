import { spawn } from "node:child_process";
import os from "node:os";
import type { CliRunner, CliRunRequest, CliRunResult } from "../../src/agent-summary";
import { createCliOutputCollector, structuredCliError } from "../../src/cli-output-collector";

let activeCalls = 0;
const waiting: Array<() => void> = [];
export const desktopCliRunner: CliRunner = async (request) => {
  request.signal?.throwIfAborted();
  if (activeCalls >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  else activeCalls += 1;
  try {
    request.signal?.throwIfAborted();
    return await runDesktopCli(request);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else activeCalls -= 1;
  }
};

export function runDesktopCli(request: CliRunRequest): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    request.signal?.throwIfAborted();
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: desktopCliEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const collector = createCliOutputCollector(request.stdoutMode);
    let settled = false;
    let closed = false;
    let terminationError: Error | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const stopChild = (): void => {
      child.kill("SIGTERM");
      if (forceKillTimer) return;
      forceKillTimer = setTimeout(() => {
        if (!closed) child.kill("SIGKILL");
      }, 500);
      forceKillTimer.unref?.();
    };

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) reject(error);
      else {
        try {
          resolve(collector.finish());
        } catch (collectorError) {
          reject(collectorError);
        }
      }
    };
    const terminate = (error: Error): void => {
      if (terminationError) return;
      terminationError = error;
      stopChild();
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (terminationError) return;
      try {
        if (target === "stdout") collector.pushStdout(chunk);
        else collector.pushStderr(chunk);
      } catch (collectorError) {
        terminate(collectorError instanceof Error ? collectorError : new Error("CLI 输出处理失败"));
      }
    };

    const timer = setTimeout(() => {
      terminate(new Error(`CLI 总结超过 ${Math.round(request.timeoutMs / 1000)} 秒`));
    }, request.timeoutMs);
    const abort = (): void => terminate(new Error("CLI 任务已取消"));
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      closed = true;
      finish(terminationError ?? error);
    });
    child.on("close", (code, signal) => {
      closed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code === 0) finish();
      else {
        let snapshot: CliRunResult = { stdout: "", stderr: "" };
        try {
          snapshot = collector.finish();
        } catch (collectorError) {
          finish(collectorError instanceof Error ? collectorError : new Error("CLI 输出处理失败"));
          return;
        }
        const detail = structuredCliError(snapshot.stdout) || tail(snapshot.stderr, 500);
        finish(new Error(`CLI 退出码 ${code ?? signal ?? "unknown"}${detail ? `：${detail}` : ""}`));
      }
    });
    child.stdin.on("error", (error) => { if (!settled) terminate(error); });
    child.stdin.end(request.stdin);
  });
}

function desktopCliEnvironment(): NodeJS.ProcessEnv {
  const homeDir = os.homedir();
  const defaults = [`${homeDir}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    ...process.env,
    HOME: process.env.HOME || homeDir,
    PATH: Array.from(new Set([...defaults, ...(process.env.PATH ?? "").split(":").filter(Boolean)])).join(":")
  };
}

function tail(value: string, length: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > length ? compact.slice(-length) : compact;
}
