// The `script` check: runs an executable from the plugin's own folder as a
// tier-1 subprocess. Right before it runs, the file is hashed against the hash
// recorded when the plugin was promoted. The script gets a scrubbed environment
// and the event as JSON on stdin. On timeout, deadline or oversized output its
// whole process group is killed, so nothing it started outlives the hook.

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CheckSpec, Signal } from "../core/types.ts";
import { type CheckContext, registerCheck } from "./registry.ts";
import { clip } from "./text.ts";

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 64 * 1024;
/** Only this much stderr is kept, and only for the error message. */
const STDERR_KEEP_CHARS = 300;
/** The only parent variables a script sees, so tokens and keys in the hook's environment stay out. */
const ENV_PASSTHROUGH = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

type ScriptOutput = "bool" | "score";

function unknown(error: string): Signal {
  return { value: null, error };
}

function commandProblems(command: unknown): string[] {
  if (typeof command !== "string" || command === "") return ["command must be a path inside the plugin folder"];
  if (isAbsolute(command) || /^[\\/]/.test(command)) return ["command must be relative to the plugin folder"];
  if (command.split(/[\\/]/).includes("..")) return ["command may not contain '..'"];
  return [];
}

function optionProblems(spec: CheckSpec): string[] {
  const problems = commandProblems(spec.command);
  if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string"))) {
    problems.push("args must be a list of strings");
  }
  const timeout = spec.timeout_ms;
  if (
    timeout !== undefined &&
    (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_TIMEOUT_MS)
  ) {
    problems.push(`timeout_ms must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (spec.needs_raw !== undefined && typeof spec.needs_raw !== "boolean")
    problems.push("needs_raw must be true or false");
  if (spec.output !== undefined && spec.output !== "bool" && spec.output !== "score") {
    problems.push("output must be 'bool' or 'score'");
  }
  return problems;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Finds the script inside the plugin folder and checks it against the promote-time
 * hash. The hash key is the real path relative to the real plugin folder, the same
 * shape the registry records, so "./bin/x.sh" and "bin/x.sh" find the same entry.
 */
function resolveScript(ctx: CheckContext, command: string): { file: string } | { error: string } {
  let dir: string;
  let file: string;
  try {
    dir = realpathSync(ctx.plugin.dir);
    file = realpathSync(join(ctx.plugin.dir, command));
  } catch {
    return { error: "script not found" };
  }
  const rel = relative(dir, file);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { error: "script resolves outside the plugin folder" };
  }
  if (!statSync(file).isFile()) return { error: "script is not a regular file" };
  const expected = ctx.plugin.fileHashes?.[rel];
  if (expected === undefined || expected !== sha256(file)) return { error: "script changed since promote" };
  return { file };
}

/** The check's own name. CheckContext does not carry it, but the engine passes the plugin's own spec object. */
function checkName(spec: CheckSpec, ctx: CheckContext): string {
  return Object.entries(ctx.plugin.checks).find(([, s]) => s === spec)?.[0] ?? "";
}

function stdinPayload(spec: CheckSpec, ctx: CheckContext): string {
  const { name, cwd, sessionId, origin, prompt, tool, source } = ctx.event;
  return JSON.stringify({
    event: { name, cwd, sessionId, origin, prompt, tool, source },
    host: ctx.event.host,
    params: ctx.plugin.params,
    check: checkName(spec, ctx),
    ...(spec.needs_raw === true ? { raw: ctx.event.raw } : {}),
  });
}

function scriptEnv(ctx: CheckContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOOKMUX_PLUGIN_DIR = ctx.plugin.dir;
  env.HOOKMUX_HOST = ctx.event.host.id;
  env.HOOKMUX_EVENT = ctx.event.name;
  return env;
}

function scriptCwd(ctx: CheckContext): string {
  try {
    if (statSync(ctx.event.cwd).isDirectory()) return ctx.event.cwd;
  } catch {
    // The host's working folder may be gone; fall back to the plugin folder.
  }
  return ctx.plugin.dir;
}

/** Process groups still running. Killed on process exit in case the hook exits while a script runs. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // A negative pid targets the group; `detached: true` made the script its leader.
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already gone.
  }
}

function trackGroup(pid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      for (const group of liveGroups) killGroup(group);
    });
  }
  liveGroups.add(pid);
}

interface ProcessRun {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  budgetMs: number;
  signal: AbortSignal;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the run was cut short or never started. */
  failure?: string;
}

/** Buffers stdout up to the cap and the head of stderr; calls `onOverflow` once stdout passes the cap. */
function collectOutput(child: ChildProcess, onOverflow: () => void): { stdout: () => string; stderr: () => string } {
  const chunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES) onOverflow();
    else chunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_KEEP_CHARS) stderr = (stderr + chunk.toString("utf8")).slice(0, STDERR_KEEP_CHARS);
  });
  return { stdout: () => Buffer.concat(chunks).toString("utf8"), stderr: () => stderr };
}

function runProcess(run: ProcessRun): Promise<ProcessResult> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      // The file itself is executed (shebang plus executable bit), with no shell.
      child = spawn(run.file, run.args, { cwd: run.cwd, env: run.env, detached: true, stdio: "pipe" });
    } catch (error) {
      done({ exitCode: null, stdout: "", stderr: "", failure: `cannot run script: ${(error as Error).message}` });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) trackGroup(pid);
    let failure: string | undefined;
    let settled = false;

    // Kills synchronously: the engine stops awaiting this check the moment the deadline aborts.
    const stop = (reason: string) => {
      failure ??= reason;
      killGroup(pid);
    };
    const onAbort = () => stop("deadline reached");
    const timer = setTimeout(() => stop(`timed out after ${run.budgetMs} ms`), run.budgetMs);
    run.signal.addEventListener("abort", onAbort, { once: true });
    const output = collectOutput(child, () => stop(`stdout over ${MAX_STDOUT_BYTES / 1024} KiB`));

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener("abort", onAbort);
      killGroup(pid);
      if (pid !== undefined) liveGroups.delete(pid);
      done({ exitCode, stdout: output.stdout(), stderr: output.stderr(), ...(failure ? { failure } : {}) });
    };

    // A script that exits without reading stdin closes the pipe; that is not an error.
    child.stdin?.on("error", () => {});
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??= `cannot run script: ${error.code ?? error.message}`;
      finish(null);
    });
    // Background processes the script left behind would hold stdout open and delay
    // `close`; killing the group as soon as the script exits ends them.
    child.on("exit", () => killGroup(pid));
    child.on("close", (code) => finish(code));
    child.stdin?.end(run.stdin);
  });
}

function withStderr(reason: string, stderr: string): string {
  const detail = stderr.trim();
  return detail ? `${reason}: ${detail}` : reason;
}

/** Reads `{"value": ..., "evidence"?: ...}`. The value must match the declared output. */
export function parseScriptOutput(text: string, output: ScriptOutput): Signal {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return unknown("script printed invalid JSON");
  }
  if (data === null || typeof data !== "object" || !("value" in data))
    return unknown("script JSON needs a value field");
  const { value, evidence } = data as { value: unknown; evidence?: unknown };
  const extra = typeof evidence === "string" ? { evidence: clip(evidence) } : {};
  if (value === null) return { value: null, ...extra };
  if (output === "bool") {
    return typeof value === "boolean" ? { value, ...extra } : unknown("bool script must return true, false or null");
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) return { value, ...extra };
  return unknown("score script must return a number from 0 to 1 or null");
}

/**
 * Exit 0 or 1 with JSON on stdout uses the JSON. Empty stdout reads the exit
 * code (0 true, 1 false) for bool scripts; a score script must print its score.
 */
export function interpretResult(result: ProcessResult, output: ScriptOutput): Signal {
  if (result.failure) return unknown(withStderr(result.failure, result.stderr));
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return unknown(withStderr(`script exited with ${result.exitCode}`, result.stderr));
  }
  const text = result.stdout.trim();
  if (text !== "") return parseScriptOutput(text, output);
  if (output === "score") return unknown("score script printed nothing");
  return { value: result.exitCode === 0 };
}

registerCheck({
  kind: "script",
  summary: "Runs an executable from the plugin folder; it reads the event as JSON on stdin and prints its value.",
  options: {
    command: "path relative to the plugin folder, executable with a shebang",
    args: "list of string arguments",
    timeout_ms: `default ${DEFAULT_TIMEOUT_MS}, at most ${MAX_TIMEOUT_MS}`,
    needs_raw: "default false; true also sends the host's original payload",
    output: `"bool" (default) or "score"`,
  },
  tier: 1,
  // The kind's output is static, so `when` validation treats every script as bool
  // until it learns to read the spec's own `output` option.
  output: "bool",
  modelBacked: false,
  validate: optionProblems,
  async run(spec, ctx) {
    const script = resolveScript(ctx, spec.command as string);
    if ("error" in script) return unknown(script.error);
    const budgetMs = Math.min((spec.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT_MS, ctx.remainingMs());
    if (ctx.signal.aborted || budgetMs <= 0) return unknown("deadline reached");
    const result = await runProcess({
      file: script.file,
      args: (spec.args as string[] | undefined) ?? [],
      cwd: scriptCwd(ctx),
      env: scriptEnv(ctx),
      stdin: stdinPayload(spec, ctx),
      budgetMs,
      signal: ctx.signal,
    });
    return interpretResult(result, spec.output === "score" ? "score" : "bool");
  },
});
