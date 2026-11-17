// Runs one script process for the script check: pipes the event in, collects a
// capped stdout, and stops it on timeout, deadline or oversized output. The
// script leads its own process group, and that whole group is killed once the
// script exits or is stopped, so nothing it left running in the background
// outlives the check (process-group.ts has the one case that escapes this).

import { type ChildProcess, spawn } from "node:child_process";
import { killGroup, trackGroup, untrackGroup } from "../runtime/process-group.ts";

export const MAX_STDOUT_BYTES = 64 * 1024;
/** Only this much stderr is kept, and only for the error message. */
const STDERR_KEEP_CHARS = 300;
/**
 * How long to wait for stdout to close after the script exits. The group kill
 * ends leftovers in the script's group at once, but one that moved to another
 * group (setsid) can hold the pipe open for its whole life; past this grace the
 * result is taken without it.
 */
const PIPE_GRACE_MS = 50;

export interface ProcessRun {
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

export function runProcess(run: ProcessRun): Promise<ProcessResult> {
  return new Promise((done) => {
    const child = spawnScript(run);
    if (typeof child === "string") done({ exitCode: null, stdout: "", stderr: "", failure: child });
    else supervise(child, run, done);
  });
}

/** Starts the script, or returns why it could not start. */
function spawnScript(run: ProcessRun): ChildProcess | string {
  try {
    // The file itself is executed (shebang plus executable bit), with no shell.
    // `detached` makes the script a process group leader, so its pid is the group id.
    return spawn(run.file, run.args, { cwd: run.cwd, env: run.env, stdio: "pipe", detached: true });
  } catch (error) {
    return `cannot run script: ${(error as Error).message}`;
  }
}

/**
 * Tracks the script's group and returns a function that kills it, synchronously,
 * the first time it is called. The group is signalled once only: its id stays
 * reserved while any member lives, but once the group is empty the number can be
 * reused, so a later kill could hit a stranger.
 */
function groupKiller(pgid: number | undefined): () => void {
  if (pgid === undefined) return () => {};
  trackGroup(pgid);
  let killed = false;
  return () => {
    if (killed) return;
    killed = true;
    untrackGroup(pgid);
    killGroup(pgid);
  };
}

/** Feeds the script its stdin, enforces the budget and the output cap, and reports once. */
function supervise(child: ChildProcess, run: ProcessRun, done: (result: ProcessResult) => void): void {
  // Kills synchronously: the engine stops awaiting this check the moment the deadline aborts.
  const killScriptGroup = groupKiller(child.pid);
  let failure: string | undefined;
  let settled = false;
  let exitCode: number | null = null;

  const stop = (reason: string) => {
    failure ??= reason;
    killScriptGroup();
  };
  const onAbort = () => stop("deadline reached");
  const timer = setTimeout(() => stop(`timed out after ${run.budgetMs} ms`), run.budgetMs);
  run.signal.addEventListener("abort", onAbort, { once: true });
  const output = collectOutput(child, () => stop(`stdout over ${MAX_STDOUT_BYTES / 1024} KiB`));

  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    run.signal.removeEventListener("abort", onAbort);
    killScriptGroup();
    child.stdout?.destroy();
    child.stderr?.destroy();
    done({ exitCode, stdout: output.stdout(), stderr: output.stderr(), ...(failure ? { failure } : {}) });
  };

  // A script that exits without reading stdin closes the pipe; that is not an error.
  child.stdin?.on("error", () => {});
  child.on("error", (error: NodeJS.ErrnoException) => {
    failure ??= `cannot run script: ${error.code ?? error.message}`;
    finish();
  });
  child.on("exit", (code) => {
    exitCode = code;
    // A normal exit still ends whatever the script left running in its group.
    killScriptGroup();
    // `close` normally follows at once; a leftover that escaped the group and holds the pipe would delay it.
    setTimeout(finish, PIPE_GRACE_MS);
  });
  child.on("close", finish);
  child.stdin?.end(run.stdin);
}
