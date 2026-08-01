import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test, vi, type Mock } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { buildStringCommandShellInvocation } from "../../utils/string-command-shell.js";
import {
  PROVIDER_LAUNCH_HOOK_STDERR_LIMIT_BYTES,
  PROVIDER_LAUNCH_HOOK_STDOUT_LIMIT_BYTES,
  runProviderLaunchHook,
} from "./launch-hook.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "launch-hook-test-"));
  tempDirs.push(dir);
  return dir;
}

const baseContext = {
  agentId: "agent_01H-test",
  provider: "pi",
  cwd: "/home/me/worktrees/feature-x",
  workspaceId: "ws_01H-test",
  labels: { tenant: "acme" },
  model: "llama-4",
  modeId: "default",
};

function createFakeChild() {
  const child = new EventEmitter() as ReturnType<typeof spawn> & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.kill = vi.fn(() => true);
  return child;
}

describe("runProviderLaunchHook shell invocation and cwd", () => {
  test("invokes the configured command through the shared shell from $PASEO_HOME", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);

    const promise = runProviderLaunchHook({
      command: "my-hook --flag",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [shell, args, options] = spawnSpy.mock.calls[0]!;
    const expectedInvocation = buildStringCommandShellInvocation({ command: "my-hook --flag" });
    expect(shell).toBe(expectedInvocation.shell);
    expect(args).toEqual(expectedInvocation.args);
    expect(options.cwd).toBe(paseoHome);
    expect(options.shell).toBe(false);

    child.stdin?.end();
    child.emit("close", 0, null);
    await expect(promise).resolves.toEqual({});
  });
});

describe("runProviderLaunchHook environment and stdin", () => {
  test("passes sanitized daemon env, provider env, and Paseo-owned variables", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    vi.stubEnv("EXISTING_DAEMON_VAR", "keep-me");
    vi.stubEnv("BASH_ENV", "/tmp/evil.sh");
    vi.stubEnv("PASEO_NODE_ENV", "development");

    try {
      const promise = runProviderLaunchHook({
        command: "hook",
        paseoHome,
        providerEnv: { PROVIDER_VAR: "from-provider" },
        context: baseContext,
        spawn: spawnSpy,
      });

      const [, , options] = spawnSpy.mock.calls[0]!;
      const env = options.env as Record<string, string>;
      expect(env.EXISTING_DAEMON_VAR).toBe("keep-me");
      expect(env.PROVIDER_VAR).toBe("from-provider");
      expect(env.PASEO_AGENT_ID).toBe(baseContext.agentId);
      expect(env.PASEO_PROVIDER).toBe(baseContext.provider);
      expect(env.PASEO_AGENT_CWD).toBe(baseContext.cwd);
      // Runtime control and shell startup vars are stripped.
      expect(env.BASH_ENV).toBeUndefined();
      expect(env.PASEO_NODE_ENV).toBeUndefined();

      child.stdin?.end();
      child.emit("close", 0, null);
      await promise;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("writes exactly one JSON payload to stdin with null optional values", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const writes: Buffer[] = [];

    child.stdin.write = vi.fn((chunk: unknown) => {
      writes.push(Buffer.from(chunk as string));
      return true;
    }) as never;
    child.stdin.end = vi.fn(() => undefined) as never;

    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: {
        agentId: "agent_1",
        provider: "codex",
        cwd: "/work",
        workspaceId: null,
        labels: {},
        model: null,
        modeId: null,
      },
      spawn: spawnSpy,
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.toString("utf8"))).toEqual({
      agentId: "agent_1",
      provider: "codex",
      cwd: "/work",
      workspaceId: null,
      labels: {},
      model: null,
      modeId: null,
    });
    expect(child.stdin.end).toHaveBeenCalledTimes(1);

    child.emit("close", 0, null);
    await promise;
  });
});

describe("runProviderLaunchHook output parsing", () => {
  test("empty and whitespace-only stdout contribute no env", async () => {
    for (const output of ["", "   \n\t  "]) {
      const paseoHome = createTempHome();
      const child = createFakeChild();
      const spawnSpy = vi.fn(() => child);
      const promise = runProviderLaunchHook({
        command: "hook",
        paseoHome,
        context: baseContext,
        spawn: spawnSpy,
      });

      child.stdout?.write(output);
      child.stdout?.end();
      child.stderr?.end();
      child.stdin?.end();
      child.emit("close", 0, null);

      await expect(promise).resolves.toEqual({});
    }
  });

  test("returns parsed env and ignores unknown top-level keys", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.write(
      JSON.stringify({
        env: { SOME_VAR: "value", OTHER: "x" },
        futureKey: { anything: true },
      }),
    );
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    const env = await promise;
    expect(env).toEqual({ SOME_VAR: "value", OTHER: "x" });
  });

  test("does not mutate process.env or the provider env input", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const providerEnv = { PROVIDER_VAR: "original" };
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      providerEnv,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.write(JSON.stringify({ env: { PROVIDER_VAR: "hooked", NEW: "1" } }));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    const env = await promise;
    expect(env).toEqual({ PROVIDER_VAR: "hooked", NEW: "1" });
    expect(providerEnv).toEqual({ PROVIDER_VAR: "original" });
    expect(process.env.PROVIDER_VAR).toBeUndefined();
    expect(process.env.NEW).toBeUndefined();
  });

  test("non-zero exit returns stdout verbatim without parsing", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.write("missing required label 'tenant'\naccepted: acme, corp");
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 7, null);

    await expect(promise).rejects.toMatchObject({
      kind: "exit",
      exitCode: 7,
      stdout: "missing required label 'tenant'\naccepted: acme, corp",
    });
    await expect(promise).rejects.toThrow(
      "Provider launch hook exited with code 7:\nmissing required label 'tenant'\naccepted: acme, corp",
    );
  });

  test("non-zero exit with empty stdout still fails closed", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 1, null);

    await expect(promise).rejects.toMatchObject({ kind: "exit", exitCode: 1 });
  });

  test("malformed JSON fails with stdout included", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.write("not json at all");
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).rejects.toMatchObject({
      kind: "malformed-output",
      stdout: "not json at all",
    });
    await expect(promise).rejects.toThrow("not json at all");
  });

  test("arrays, null, and non-object env shapes fail", async () => {
    for (const output of ["[]", "null", '{"env": []}', '{"env": null}', '{"env": {"K": 42}}']) {
      const paseoHome = createTempHome();
      const child = createFakeChild();
      const spawnSpy = vi.fn(() => child);
      const promise = runProviderLaunchHook({
        command: "hook",
        paseoHome,
        context: baseContext,
        spawn: spawnSpy,
      });

      child.stdout?.write(output);
      child.stdout?.end();
      child.stderr?.end();
      child.stdin?.end();
      child.emit("close", 0, null);

      await expect(promise).rejects.toMatchObject({ kind: "malformed-output" });
    }
  });
});

describe("runProviderLaunchHook stderr and failure paths", () => {
  test("stderr is captured into the single outcome event and never treated as output", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const logger = createTestLogger();
    const infoSpy = vi.spyOn(logger, "info");
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      spawn: spawnSpy,
    });

    child.stderr?.write("trace line");
    child.stderr?.end();
    child.stdout?.write(JSON.stringify({ env: { A: "1" } }));
    child.stdout?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ A: "1" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: baseContext.agentId,
        provider: "pi",
        outcome: "success",
        stderr: "trace line",
        stderrTruncated: false,
      }),
      expect.any(String),
    );
  });

  test("spawn failure rejects with a spawn-kind error", async () => {
    const paseoHome = createTempHome();
    const spawnSpy = createFailingSpawnSpy("ENOENT: bash not found");

    await expect(
      runProviderLaunchHook({
        command: "hook",
        paseoHome,
        context: baseContext,
        spawn: spawnSpy,
      }),
    ).rejects.toMatchObject({
      kind: "spawn",
      message: "Provider launch hook failed to start: ENOENT: bash not found",
    });
  });

  test("hook exiting without reading stdin does not fail the run", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({});
  });
});

describe("runProviderLaunchHook timeout", () => {
  // Deliberately exercises real wall-clock timeout and OS process-tree
  // termination against a live subprocess — deterministic time control cannot
  // simulate signal delivery and descendant reaping.
  test("deterministically times out and kills the full process tree", async () => {
    const paseoHome = createTempHome();
    const grandchildPidFile = join(paseoHome, "grandchild.pid");
    // The hook spawns a detached-ish grandchild that ignores the shell's exit,
    // so only a full tree kill can stop it.
    // The script is embedded into `bash -c`, so it must not contain double
    // quotes; the pid file path travels via the provider env instead.
    const script = [
      `const { spawn } = require('node:child_process');`,
      `const gc = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });`,
      `require('node:fs').writeFileSync(process.env.GRANDCHILD_PID_FILE, String(gc.pid));`,
      `setInterval(()=>{},1000);`,
    ].join(" ");
    const command = `node -e "${script}"`;

    const promise = runProviderLaunchHook({
      command,
      paseoHome,
      providerEnv: { GRANDCHILD_PID_FILE: grandchildPidFile },
      context: baseContext,
      timeoutMs: 250,
    });

    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
    await expect(promise).rejects.toThrow(/timed out after 250ms/);

    const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
    await waitForProcessGone(grandchildPid);
  });
});

describe("runProviderLaunchHook output limits", () => {
  test("exports independent stdout and stderr default limits", () => {
    expect(PROVIDER_LAUNCH_HOOK_STDOUT_LIMIT_BYTES).toBe(16 * 1024);
    expect(PROVIDER_LAUNCH_HOOK_STDERR_LIMIT_BYTES).toBe(64 * 1024);
  });

  test("default stdout limit is enforced without an override", async () => {
    const paseoHome = createTempHome();
    const terminate = vi.fn(async () => "terminated" as const);
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
      terminate,
    });

    child.stdout?.write("x".repeat(PROVIDER_LAUNCH_HOOK_STDOUT_LIMIT_BYTES + 1));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    await expect(promise).rejects.toThrow(/16384 byte stdout limit/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("default stderr limit is enforced without an override", async () => {
    const paseoHome = createTempHome();
    const terminate = vi.fn(async () => "terminated" as const);
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
      terminate,
    });

    child.stderr?.write("y".repeat(PROVIDER_LAUNCH_HOOK_STDERR_LIMIT_BYTES + 1));
    child.stderr?.end();
    child.stdout?.end();
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    await expect(promise).rejects.toThrow(/65536 byte stderr limit/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("stdout accumulated across chunks up to exactly its limit is accepted", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stdoutLimitBytes: 16,
      spawn: spawnSpy,
    });

    // Split the exactly-16-byte payload across two chunks: an off-by-one in
    // cumulative accounting would live in this accumulate-to-the-limit path.
    const payload = '{"env":{"a":""}}';
    child.stdout?.write(payload.slice(0, 9));
    child.stdout?.write(payload.slice(9));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ a: "" });
  });

  test("stdout of exactly its limit is accepted when it forms valid output", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stdoutLimitBytes: 16,
      spawn: spawnSpy,
    });

    // {"env":{"a":""}} is exactly 16 bytes.
    child.stdout?.write('{"env":{"a":""}}');
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ a: "" });
  });

  test("stdout one byte beyond its limit terminates the tree and fails with the stdout limit", async () => {
    const paseoHome = createTempHome();
    const terminate = vi.fn(async () => "terminated" as const);
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stdoutLimitBytes: 16,
      spawn: spawnSpy,
      terminate,
    });

    child.stdout?.write("x".repeat(17));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    await expect(promise).rejects.toThrow(/16 byte stdout limit/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("stderr of exactly its limit is accepted", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stderrLimitBytes: 16,
      spawn: spawnSpy,
    });

    child.stderr?.write("y".repeat(16));
    child.stderr?.end();
    child.stdout?.write(JSON.stringify({ env: { A: "1" } }));
    child.stdout?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ A: "1" });
  });

  test("stderr one byte beyond its limit terminates the tree and fails with the stderr limit", async () => {
    const paseoHome = createTempHome();
    const terminate = vi.fn(async () => "terminated" as const);
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stderrLimitBytes: 16,
      spawn: spawnSpy,
      terminate,
    });

    child.stderr?.write("y".repeat(17));
    child.stderr?.end();
    child.stdout?.end();
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    await expect(promise).rejects.toThrow(/16 byte stderr limit/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("non-ASCII content is counted by encoded bytes, not string length", async () => {
    const paseoHome = createTempHome();
    const terminate = vi.fn(async () => "terminated" as const);
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      // JSON.stringify({env:{k:"é"}}) is 17 characters but 18 UTF-8 bytes,
      // so a 17-byte limit must still reject it.
      stdoutLimitBytes: 17,
      spawn: spawnSpy,
      terminate,
    });

    child.stdout?.write(JSON.stringify({ env: { k: "é" } }));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    await expect(promise).rejects.toThrow(/17 byte stdout limit/);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("crossing both limits or closing during termination settles once and terminates once", async () => {
    const paseoHome = createTempHome();
    const terminate = vi.fn(async () => "terminated" as const);
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stdoutLimitBytes: 4,
      stderrLimitBytes: 4,
      spawn: spawnSpy,
      terminate,
    });

    child.stdout?.write("x".repeat(10));
    child.stderr?.write("y".repeat(10));
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    child.emit("close", 0, null);

    const rejections = await countRejections(promise);
    expect(rejections).toBe(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  test("an error event during termination does not replace the abort outcome", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    let releaseTerminate!: () => void;
    const terminate = vi.fn(
      () =>
        new Promise<"terminated">((resolve) => {
          releaseTerminate = () => resolve("terminated");
        }),
    );
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stdoutLimitBytes: 4,
      spawn: spawnSpy,
      terminate,
    });

    child.stdout?.write("way too long");
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();

    // The tree-kill is still in flight when the child reports a kill failure;
    // the abort outcome must win over the misleading spawn error.
    child.emit("error", Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }));
    releaseTerminate();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    await expect(promise).rejects.toThrow(/4 byte stdout limit/);
    expect(terminate).toHaveBeenCalledTimes(1);
    const rejections = await countRejections(promise);
    expect(rejections).toBe(1);
  });
});

describe("runProviderLaunchHook UTF-8 handling", () => {
  test("a multibyte character split across stdout chunks decodes without corruption", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    const payload = Buffer.from(JSON.stringify({ env: { K: "café" } }), "utf8");
    const splitAt = payload.indexOf(Buffer.from("caf", "utf8")) + Buffer.byteLength("caf");
    child.stdout?.write(payload.subarray(0, splitAt));
    child.stdout?.write(payload.subarray(splitAt));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ K: "café" });
  });

  test("a multibyte character split across stderr chunks is retained", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const logger = createTestLogger();
    const infoSpy = vi.spyOn(logger, "info");
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      spawn: spawnSpy,
    });

    const stderrBytes = Buffer.from("café", "utf8");
    const splitAt = stderrBytes.indexOf(Buffer.from("caf", "utf8")) + Buffer.byteLength("caf");
    child.stderr?.write(stderrBytes.subarray(0, splitAt));
    child.stderr?.write(stderrBytes.subarray(splitAt));
    child.stderr?.end();
    child.stdout?.write(JSON.stringify({ env: { A: "1" } }));
    child.stdout?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ A: "1" });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "success", stderr: "café", stderrTruncated: false }),
      expect.any(String),
    );
  });

  test("invalid UTF-8 on stdout fails with invalid-utf8", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    // 0xC3 starts a two-byte sequence; 0x28 is not a valid continuation byte.
    child.stdout?.write(Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).rejects.toMatchObject({ kind: "invalid-utf8" });
    await expect(promise).rejects.toThrow(/stdout was not valid UTF-8/);
  });

  test("invalid UTF-8 on stderr fails with invalid-utf8 even when stdout is valid JSON", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.write(JSON.stringify({ env: { A: "1" } }));
    child.stdout?.end();
    child.stderr?.write(Buffer.from([0xc3, 0x28]));
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).rejects.toMatchObject({ kind: "invalid-utf8" });
    await expect(promise).rejects.toThrow(/stderr was not valid UTF-8/);
  });

  test("non-zero exit with valid non-JSON UTF-8 stdout remains an exit error", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdout?.write("missing required label 'tenant'");
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 7, null);

    await expect(promise).rejects.toMatchObject({
      kind: "exit",
      exitCode: 7,
      stdout: "missing required label 'tenant'",
    });
  });

  test("non-zero exit with invalid UTF-8 output is rejected as invalid-utf8", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    // "foo" followed by an invalid continuation byte.
    child.stdout?.write(Buffer.from([0x66, 0x6f, 0x6f, 0xc3, 0x28]));
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 7, null);

    await expect(promise).rejects.toMatchObject({ kind: "invalid-utf8" });
    await expect(promise).rejects.toThrow(/stdout was not valid UTF-8/);
  });
});

describe("runProviderLaunchHook logging", () => {
  test("start event carries agent, provider, command preview, timeout, and both limits", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const logger = createTestLogger();
    const debugSpy = vi.spyOn(logger, "debug");
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      timeoutMs: 1234,
      stdoutLimitBytes: 4096,
      stderrLimitBytes: 8192,
      spawn: spawnSpy,
    });

    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: baseContext.agentId,
        provider: "pi",
        command: "hook",
        commandTruncated: false,
        timeoutMs: 1234,
        stdoutLimitBytes: 4096,
        stderrLimitBytes: 8192,
      }),
      expect.any(String),
    );

    child.stdin?.end();
    child.emit("close", 0, null);
    await promise;
  });

  test("success emits one outcome with duration and byte counts, stderr preview, and no stdout contents", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const logger = createTestLogger();
    const infoSpy = vi.spyOn(logger, "info");
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      spawn: spawnSpy,
    });

    const stdoutPayload = JSON.stringify({ env: { SECRET_TOKEN: "s3cr3t" } });
    child.stdout?.write(stdoutPayload);
    child.stdout?.end();
    child.stderr?.write("trace line");
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ SECRET_TOKEN: "s3cr3t" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [fields, message] = infoSpy.mock.calls[0]!;
    expect(message).toBe("Provider launch hook completed");
    expect(fields).toMatchObject({
      agentId: baseContext.agentId,
      provider: "pi",
      outcome: "success",
      stdoutBytes: Buffer.byteLength(stdoutPayload),
      stderrBytes: Buffer.byteLength("trace line"),
      stderr: "trace line",
      stderrTruncated: false,
      durationMs: expect.any(Number),
    });
    // Successful stdout is the returned env object; its contents stay out of logs.
    expect(JSON.stringify(fields)).not.toContain("s3cr3t");
  });

  test("non-zero exit emits one failure outcome with exit code, kind, and previews", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const logger = createTestLogger();
    const infoSpy = vi.spyOn(logger, "info");
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      spawn: spawnSpy,
    });

    child.stdout?.write("missing label");
    child.stdout?.end();
    child.stderr?.write("oops");
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 3, null);

    await expect(promise).rejects.toMatchObject({ kind: "exit", exitCode: 3 });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]![0]).toMatchObject({
      outcome: "failure",
      failureKind: "exit",
      exitCode: 3,
      stdout: "missing label",
      stdoutTruncated: false,
      stderr: "oops",
      stderrTruncated: false,
    });
  });

  test("commands and previews longer than 1 KiB are truncated and carry their flags", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const logger = createTestLogger();
    const debugSpy = vi.spyOn(logger, "debug");
    const infoSpy = vi.spyOn(logger, "info");
    const promise = runProviderLaunchHook({
      command: "x".repeat(2000),
      paseoHome,
      context: baseContext,
      logger,
      spawn: spawnSpy,
    });

    child.stdout?.write("y".repeat(2000));
    child.stdout?.end();
    child.stderr?.write("z".repeat(2000));
    child.stderr?.end();
    child.stdin?.end();
    child.emit("close", 3, null);

    await expect(promise).rejects.toMatchObject({ kind: "exit" });
    expect(debugSpy.mock.calls[0]![0]).toMatchObject({
      commandTruncated: true,
    });
    const debugFields = debugSpy.mock.calls[0]![0] as Record<string, unknown>;
    const commandPreview = debugFields.command as string;
    expect(commandPreview.length).toBeLessThan(2000);
    expect(commandPreview.length).toBeGreaterThan(0);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const fields = infoSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      outcome: "failure",
      failureKind: "exit",
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect((fields.stdout as string).length).toBeLessThan(2000);
    expect((fields.stderr as string).length).toBeLessThan(2000);
  });

  test("timeout and output-limit paths each emit exactly one outcome log", async () => {
    const paseoHome = createTempHome();
    const logger = createTestLogger();
    const infoSpy = vi.spyOn(logger, "info");

    const timeoutChild = createFakeChild();
    const timeoutPromise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      timeoutMs: 10,
      spawn: vi.fn(() => timeoutChild),
      terminate: vi.fn(async () => "terminated" as const),
    });
    await expect(timeoutPromise).rejects.toMatchObject({ kind: "timeout" });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const timeoutFields = infoSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(timeoutFields).toMatchObject({ outcome: "failure", failureKind: "timeout" });
    // Abort paths never observe the child's exit, so exitCode/signalCode stay
    // absent under the "when known" contract.
    expect(timeoutFields).not.toHaveProperty("exitCode");
    expect(timeoutFields).not.toHaveProperty("signalCode");

    const limitChild = createFakeChild();
    const limitPromise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      logger,
      stdoutLimitBytes: 4,
      spawn: vi.fn(() => limitChild),
      terminate: vi.fn(async () => "terminated" as const),
    });
    limitChild.stdout?.write("way too long");
    limitChild.stdout?.end();
    limitChild.stderr?.end();
    limitChild.stdin?.end();
    await expect(limitPromise).rejects.toMatchObject({ kind: "output-limit" });
    expect(infoSpy).toHaveBeenCalledTimes(2);
    const limitFields = infoSpy.mock.calls[1]![0] as Record<string, unknown>;
    expect(limitFields).toMatchObject({
      outcome: "failure",
      failureKind: "output-limit",
    });
    expect(limitFields).not.toHaveProperty("exitCode");
    expect(limitFields).not.toHaveProperty("signalCode");
  });
});

describe("runProviderLaunchHook settle races", () => {
  test("close then late error settles exactly once", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      spawn: spawnSpy,
    });

    child.stdin?.end();
    child.emit("close", 0, null);
    child.emit("error", new Error("late error"));

    await expect(promise).resolves.toEqual({});
  });

  test("timeout then close settles exactly once with the timeout error", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      timeoutMs: 10,
      spawn: spawnSpy,
      terminate: vi.fn(async () => "terminated" as const),
    });

    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
    child.emit("close", 0, null);

    const rejections = await countRejections(promise);
    expect(rejections).toBe(1);
  });

  test("output-limit then close settles exactly once", async () => {
    const paseoHome = createTempHome();
    const child = createFakeChild();
    const spawnSpy = vi.fn(() => child);
    const promise = runProviderLaunchHook({
      command: "hook",
      paseoHome,
      context: baseContext,
      stdoutLimitBytes: 4,
      spawn: spawnSpy,
      terminate: vi.fn(async () => "terminated" as const),
    });

    child.stdout?.write("way too long");
    child.stdout?.end();
    child.stderr?.end();
    child.stdin?.end();

    await expect(promise).rejects.toMatchObject({ kind: "output-limit" });
    child.emit("close", 0, null);

    const rejections = await countRejections(promise);
    expect(rejections).toBe(1);
  });
});

async function countRejections(promise: Promise<unknown>): Promise<number> {
  let rejections = 0;
  const seen = promise.catch(() => {
    rejections += 1;
  });
  await seen;
  return rejections;
}

function createFailingSpawnSpy(message: string): Mock {
  return vi.fn(() => {
    const child = createFakeChild();
    const error = Object.assign(new Error(message), { code: "ENOENT" });
    process.nextTick(() => child.emit("error", error));
    return child;
  });
}

// Polling a live OS process for exit — same pattern as utils/tree-kill.test.ts;
// no deterministic substitute for observing a reaped descendant.
async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 25);
    await promise;
  }
  throw new Error(`Process ${pid} is still alive after tree kill`);
}
