import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import type { Logger } from "pino";

import { createExternalProcessEnv } from "../paseo-env.js";
import {
  buildStringCommandShellInvocation,
  createStringCommandShellEnv,
} from "../../utils/string-command-shell.js";
import { terminateWithTreeKill, type ProcessTerminator } from "../../utils/tree-kill.js";

export const PROVIDER_LAUNCH_HOOK_TIMEOUT_MS = 5_000;
export const PROVIDER_LAUNCH_HOOK_STDOUT_LIMIT_BYTES = 16 * 1024;
export const PROVIDER_LAUNCH_HOOK_STDERR_LIMIT_BYTES = 64 * 1024;
// Logging previews are bounded well below both enforcement limits; a hook
// returning bulk data as environment variables is misusing the mechanism, so
// 1 KiB of any string is plenty of diagnostic context.
const PROVIDER_LAUNCH_HOOK_LOG_PREVIEW_BYTES = 1024;
const TREE_KILL_GRACEFUL_TIMEOUT_MS = 1_000;
const TREE_KILL_FORCE_TIMEOUT_MS = 1_000;

export type ProviderLaunchHookErrorKind =
  | "spawn"
  | "exit"
  | "timeout"
  | "output-limit"
  | "invalid-utf8"
  | "malformed-output";

/**
 * Typed launch-hook failure. `message` is the actionable user copy surfaced
 * to whoever requested the agent; the structured fields are for logging and
 * tests.
 */
export class ProviderLaunchHookError extends Error {
  readonly kind: ProviderLaunchHookErrorKind;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;

  constructor(details: {
    kind: ProviderLaunchHookErrorKind;
    message: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
  }) {
    super(details.message);
    this.name = "ProviderLaunchHookError";
    this.kind = details.kind;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode ?? null;
    this.signalCode = details.signalCode ?? null;
  }
}

export interface ProviderLaunchHookContext {
  agentId: string;
  provider: string;
  cwd: string;
  workspaceId: string | null;
  labels: Record<string, string>;
  model: string | null;
  modeId: string | null;
}

export interface ProviderLaunchHookRunInput {
  command: string;
  paseoHome: string;
  providerEnv?: Record<string, string>;
  context: ProviderLaunchHookContext;
  logger?: Logger;
  timeoutMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  terminate?: ProcessTerminator;
}

type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Input the manager supplies; bootstrap binds paseoHome and the logger. */
export type ProviderLaunchHookRunnerInput = Omit<
  ProviderLaunchHookRunInput,
  "paseoHome" | "logger"
>;

export type ProviderLaunchHookRunner = (
  input: ProviderLaunchHookRunnerInput,
) => Promise<Record<string, string>>;

/**
 * Runs a provider launch hook: a shell command executed from $PASEO_HOME whose
 * stdout may contribute provider environment for one managed agent session
 * launch. Fails closed on any failure — a hook that does not approve the
 * environment means the session is not started.
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

// Native Promise.withResolvers exists at runtime (Node >= 22) but is not typed
// by the ES2023 lib target — the executor form is required to build the pair.
function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function runProviderLaunchHook(
  input: ProviderLaunchHookRunInput,
): Promise<Record<string, string>> {
  const timeoutMs = input.timeoutMs ?? PROVIDER_LAUNCH_HOOK_TIMEOUT_MS;
  const stdoutLimitBytes = input.stdoutLimitBytes ?? PROVIDER_LAUNCH_HOOK_STDOUT_LIMIT_BYTES;
  const stderrLimitBytes = input.stderrLimitBytes ?? PROVIDER_LAUNCH_HOOK_STDERR_LIMIT_BYTES;
  const terminate: ProcessTerminator = input.terminate ?? terminateWithTreeKill;
  const spawnChild: SpawnFn = input.spawn ?? spawn;
  const { command, paseoHome, providerEnv, context } = input;
  const { agentId, provider, cwd } = context;

  const shellInvocation = buildStringCommandShellInvocation({ command });
  const payload = JSON.stringify({
    agentId: context.agentId,
    provider: context.provider,
    cwd: context.cwd,
    workspaceId: context.workspaceId,
    labels: context.labels,
    model: context.model,
    modeId: context.modeId,
  });

  // Sanitized daemon env < resolved provider env < Paseo-owned launch variables.
  // BASH_ENV is dropped so shell startup files cannot rewrite the environment.
  const childEnv = createStringCommandShellEnv(
    createExternalProcessEnv(process.env, providerEnv ?? {}, {
      PASEO_AGENT_ID: agentId,
      PASEO_PROVIDER: provider,
      PASEO_AGENT_CWD: cwd,
    }),
  );

  const { promise, resolve, reject } = createDeferred<Record<string, string>>();
  let settled = false;
  let aborted = false;
  let timer: NodeJS.Timeout | undefined;
  // Raw bytes until settlement. Never decoded per chunk: a multibyte sequence
  // straddling a read boundary would otherwise corrupt to U+FFFD on both
  // sides, and JSON would happily accept the corrupted value — a fail-open
  // hole. Decoding happens exactly once, after close, with a fatal decoder.
  let stdoutChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  // Strict-decoded text, set by the close handler. Diagnostics that settle
  // before strict decoding (timeout, output-limit, spawn error) fall back to
  // a best-effort decode of the retained bytes; replacement characters are
  // acceptable there because those bytes are never interpreted as output.
  let strictDecoded = false;
  let stdoutText = "";
  let stderrText = "";
  const startedAtMs = performance.now();

  const logStart = () => {
    if (!input.logger) return;
    const commandPreview = truncateForLog(command, PROVIDER_LAUNCH_HOOK_LOG_PREVIEW_BYTES);
    input.logger.debug(
      {
        agentId,
        provider,
        command: commandPreview.value,
        commandTruncated: commandPreview.truncated,
        timeoutMs,
        stdoutLimitBytes,
        stderrLimitBytes,
      },
      "Provider launch hook started",
    );
  };

  const diagnosticText = (stream: "stdout" | "stderr"): string => {
    if (strictDecoded) {
      return stream === "stdout" ? stdoutText : stderrText;
    }
    return Buffer.concat(stream === "stdout" ? stdoutChunks : stderrChunks).toString("utf8");
  };

  const logOutcome = (outcome: "success" | "failure", error?: ProviderLaunchHookError) => {
    if (!input.logger) return;
    const commandPreview = truncateForLog(command, PROVIDER_LAUNCH_HOOK_LOG_PREVIEW_BYTES);
    const fields: Record<string, unknown> = {
      agentId,
      provider,
      command: commandPreview.value,
      commandTruncated: commandPreview.truncated,
      durationMs: performance.now() - startedAtMs,
      outcome,
      stdoutBytes,
      stderrBytes,
    };
    if (error) {
      fields.failureKind = error.kind;
      if (error.exitCode !== null) {
        fields.exitCode = error.exitCode;
      }
      if (error.signalCode) {
        fields.signalCode = error.signalCode;
      }
    }
    // Successful stdout is the returned env object and commonly contains
    // tokens or other secrets; its byte count is enough for diagnostics.
    if (stderrBytes > 0) {
      const preview = truncateForLog(
        diagnosticText("stderr"),
        PROVIDER_LAUNCH_HOOK_LOG_PREVIEW_BYTES,
      );
      fields.stderr = preview.value;
      fields.stderrTruncated = preview.truncated;
    }
    if (outcome === "failure" && stdoutBytes > 0) {
      const preview = truncateForLog(
        diagnosticText("stdout"),
        PROVIDER_LAUNCH_HOOK_LOG_PREVIEW_BYTES,
      );
      fields.stdout = preview.value;
      fields.stdoutTruncated = preview.truncated;
    }
    input.logger.info(fields, "Provider launch hook completed");
  };

  const fail = (error: ProviderLaunchHookError) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    logOutcome("failure", error);
    reject(error);
  };

  const succeed = (env: Record<string, string>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    logOutcome("success");
    resolve(env);
  };

  const abortWithTreeKill = async (error: ProviderLaunchHookError) => {
    if (settled) return;
    aborted = true;
    clearTimeout(timer);
    try {
      await terminate(child, {
        gracefulSignal: "SIGTERM",
        forceSignal: "SIGKILL",
        gracefulTimeoutMs: TREE_KILL_GRACEFUL_TIMEOUT_MS,
        forceTimeoutMs: TREE_KILL_FORCE_TIMEOUT_MS,
      });
    } catch {
      // Process-tree cleanup is best-effort; the original error is what matters.
    }
    fail(error);
  };

  const outputLimitError = (stream: "stdout" | "stderr"): ProviderLaunchHookError =>
    new ProviderLaunchHookError({
      kind: "output-limit",
      message: `Provider launch hook exceeded the ${
        stream === "stdout" ? stdoutLimitBytes : stderrLimitBytes
      } byte ${stream} limit`,
      stdout: diagnosticText("stdout"),
      stderr: diagnosticText("stderr"),
    });

  let child: ChildProcess;
  try {
    child = spawnChild(shellInvocation.shell, shellInvocation.args, {
      cwd: paseoHome,
      env: childEnv as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    // A spawn factory that throws synchronously must still fail closed with
    // the hook's typed error contract and an outcome event — no start event
    // because no subprocess was created.
    fail(
      new ProviderLaunchHookError({
        kind: "spawn",
        message: `Provider launch hook failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    return promise;
  }
  logStart();

  // The hook may exit without reading stdin; an EPIPE on the write side is
  // not a hook failure — the close handler owns the outcome.
  child.stdin?.on("error", () => undefined);

  try {
    child.stdin?.write(payload);
    child.stdin?.end();
  } catch {
    // Same as EPIPE above: the close handler owns the outcome.
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    const overflow = stdoutBytes + chunk.length > stdoutLimitBytes;
    const retained = retainUpTo(stdoutChunks, stdoutBytes, stdoutLimitBytes, chunk);
    stdoutChunks = retained.chunks;
    stdoutBytes = retained.bytes;
    if (overflow && !aborted) {
      void abortWithTreeKill(outputLimitError("stdout"));
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const overflow = stderrBytes + chunk.length > stderrLimitBytes;
    const retained = retainUpTo(stderrChunks, stderrBytes, stderrLimitBytes, chunk);
    stderrChunks = retained.chunks;
    stderrBytes = retained.bytes;
    if (overflow && !aborted) {
      void abortWithTreeKill(outputLimitError("stderr"));
    }
  });

  child.on("error", (error) => {
    // The error event fires for spawn failures and for kill failures. A kill
    // failure during an in-flight abort must not replace the abort outcome
    // (timeout, output-limit) with a misleading spawn error — the abort path
    // owns the settlement once `aborted` is set.
    if (settled || aborted) return;
    fail(
      new ProviderLaunchHookError({
        kind: "spawn",
        message: `Provider launch hook failed to start: ${error.message}`,
        stdout: diagnosticText("stdout"),
        stderr: diagnosticText("stderr"),
      }),
    );
  });

  child.on("close", (code, signal) => {
    if (settled || aborted) return;
    clearTimeout(timer);
    // Strict decoding happens before exit-code interpretation: a non-zero
    // hook with malformed bytes still fails, but as invalid UTF-8 rather
    // than with corrupted bytes treated as its explanatory message.
    try {
      stdoutText = decodeUtf8(stdoutChunks);
    } catch {
      fail(
        new ProviderLaunchHookError({
          kind: "invalid-utf8",
          message: "Provider launch hook stdout was not valid UTF-8",
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: diagnosticText("stderr"),
        }),
      );
      return;
    }
    try {
      stderrText = decodeUtf8(stderrChunks);
    } catch {
      fail(
        new ProviderLaunchHookError({
          kind: "invalid-utf8",
          message: "Provider launch hook stderr was not valid UTF-8",
          stdout: stdoutText,
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        }),
      );
      return;
    }
    strictDecoded = true;
    if (code !== 0) {
      fail(
        new ProviderLaunchHookError({
          kind: "exit",
          message: `Provider launch hook exited with code ${code}${stdoutText ? `:\n${stdoutText}` : ""}`,
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code,
          signalCode: signal,
        }),
      );
      return;
    }
    try {
      succeed(parseHookOutput(stdoutText));
    } catch (error) {
      fail(
        error instanceof ProviderLaunchHookError
          ? error
          : new ProviderLaunchHookError({
              kind: "malformed-output",
              message: `Provider launch hook returned invalid output:\n${stdoutText}`,
              stdout: stdoutText,
              stderr: stderrText,
            }),
      );
    }
  });

  timer = setTimeout(() => {
    void abortWithTreeKill(
      new ProviderLaunchHookError({
        kind: "timeout",
        message: `Provider launch hook timed out after ${timeoutMs}ms`,
        stdout: diagnosticText("stdout"),
        stderr: diagnosticText("stderr"),
      }),
    );
  }, timeoutMs);

  return promise;
}

/**
 * Retains at most `limit` bytes of the incoming chunk stream for bounded
 * diagnostics. Overflowing bytes are dropped, including a suffix that ends
 * mid-multibyte-sequence: such a prefix is only diagnostic after an
 * output-limit failure and must never be parsed as hook output.
 */
function retainUpTo(
  chunks: Buffer[],
  bytes: number,
  limit: number,
  chunk: Buffer,
): { chunks: Buffer[]; bytes: number } {
  if (bytes >= limit) return { chunks, bytes };
  const room = limit - bytes;
  if (chunk.length <= room) {
    chunks.push(chunk);
    return { chunks, bytes: bytes + chunk.length };
  }
  chunks.push(chunk.subarray(0, room));
  return { chunks, bytes: limit };
}

function decodeUtf8(chunks: Buffer[]): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/**
 * Truncates a string to at most `byteLimit` bytes for logging, without
 * splitting a multibyte character. Safe on any decoded string; for
 * best-effort previews replacement characters may already be present.
 */
function truncateForLog(value: string, byteLimit: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= byteLimit) {
    return { value, truncated: false };
  }
  let out = "";
  let bytes = 0;
  for (const ch of value) {
    const chBytes = Buffer.byteLength(ch);
    if (bytes + chBytes > byteLimit) break;
    out += ch;
    bytes += chBytes;
  }
  return { value: out, truncated: true };
}

function parseHookOutput(stdout: string): Record<string, string> {
  // Whitespace-only stdout contributes nothing and is a valid success.
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ProviderLaunchHookError({
      kind: "malformed-output",
      message: `Provider launch hook returned invalid JSON:\n${stdout}`,
      stdout,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderLaunchHookError({
      kind: "malformed-output",
      message: `Provider launch hook returned invalid output (expected a JSON object):\n${stdout}`,
      stdout,
    });
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key !== "env") {
      // Unknown top-level keys are ignored, leaving room for future extensions.
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ProviderLaunchHookError({
        kind: "malformed-output",
        message: `Provider launch hook returned an invalid "env" value:\n${stdout}`,
        stdout,
      });
    }
    for (const [envKey, envValue] of Object.entries(value as Record<string, unknown>)) {
      if (typeof envValue !== "string") {
        throw new ProviderLaunchHookError({
          kind: "malformed-output",
          message: `Provider launch hook returned a non-string env value for "${envKey}":\n${stdout}`,
          stdout,
        });
      }
      env[envKey] = envValue;
    }
  }
  return env;
}
