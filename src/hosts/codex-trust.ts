// Approves hookmux's own hub entries in Codex through `codex app-server`, so a
// person does not have to open /hooks after every change. Written against
// codex-cli 0.170.0: `hooks/list` returns each hook's trust key, current hash
// and trustStatus (app-server-protocol v2 HooksListResponse), and
// `config/batchWrite` stores `hooks.state."<key>".trusted_hash` in the user's
// config.toml, which is what /hooks writes (hooks/src/engine/discovery.rs).
//
// Security: only an entry whose command is exactly a hub command for this
// launcher, in the hooks.json hookmux manages, from the user layer and not
// managed by policy, is approved. The key and hash come from Codex itself and
// are never built here. Every other hook keeps its own approval state; a hub
// entry in an older written form is reported, but left for /hooks, because
// isHubCommand accepts trailing text after --event that the hub never wrote.

import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { CANONICAL_EVENTS, type CanonicalEvent } from "../core/types.ts";
import { hubCommand, hubEventOf } from "./hub-command.ts";

const DEFAULT_TIMEOUT_MS = 20_000;
/** How long the server gets to exit after SIGTERM before SIGKILL, so hookmux never waits on it. */
const KILL_GRACE_MS = 2_000;

/** The HookMetadata fields this module reads. */
export interface CodexHook {
  key: string;
  handlerType: string;
  command: string | null;
  async: boolean;
  matcher: string | null;
  sourcePath: string;
  source: string;
  isManaged: boolean;
  currentHash: string;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
}

export interface ApprovalTarget {
  launcher: string;
  /** The hooks.json hookmux edits for this CODEX_HOME. */
  hooksFile: string;
  /** Events hookmux has hub entries for in that file; each must show up in Codex's list. */
  events: readonly CanonicalEvent[];
  env: NodeJS.ProcessEnv;
  /** The codex executable; `codex` on PATH by default. */
  codex?: string;
  timeoutMs?: number;
}

export interface ApprovalResult {
  /** Trust keys approved by this call. */
  approved: string[];
  /** Hub entries that were already trusted. */
  alreadyTrusted: number;
  /** Hub entries still not trusted after the write, by key. */
  stillUntrusted: string[];
  /** Events whose hub entry Codex does not list in that file, so nothing could approve it. */
  missing: CanonicalEvent[];
}

export interface HubListing {
  entries: CodexHook[];
  missing: CanonicalEvent[];
}

type HubScope = Pick<ApprovalTarget, "launcher" | "hooksFile" | "events">;

/**
 * Hub entries of this launcher that Codex lists in hookmux's hooks.json, in any
 * form hookmux has written and whatever their trust state, and the events it lists none for.
 */
export function hubEntries(hooks: CodexHook[], target: HubScope): HubListing {
  const sourcePaths = codexSourcePaths(target.hooksFile);
  const entries = hooks.filter(
    (h) =>
      hubEventOf(h.command, target.launcher) !== undefined &&
      sourcePaths.includes(h.sourcePath) &&
      h.source === "user" &&
      !h.isManaged,
  );
  const seen = new Set(entries.map((h) => hubEventOf(h.command, target.launcher)));
  return { entries, missing: target.events.filter((e) => !seen.has(e)) };
}

/**
 * True when the entry is exactly what hookmux writes today, the only form approved here.
 * Security: an entry edited to run async or under a matcher no longer guards every call,
 * so it is left for the person to look at in /hooks.
 */
function isCurrentHubEntry(hook: CodexHook, launcher: string): boolean {
  return (
    hook.handlerType === "command" &&
    hook.async === false &&
    hook.matcher === null &&
    CANONICAL_EVENTS.some((e) => hook.command === hubCommand(launcher, "codex", e))
  );
}

/** Codex could not be started at all, so there is nothing to approve with; not a failed approval. */
export class CodexUnavailableError extends Error {}

/**
 * The spellings Codex may report for this file (codex-cli 0.170.0): under the realpath of
 * a CODEX_HOME given in the environment (a symlinked home, macOS /tmp and /var), but under
 * the unresolved path for the default ~/.codex even when that is a symlink.
 */
function codexSourcePaths(hooksFile: string): string[] {
  try {
    return [hooksFile, join(realpathSync(dirname(hooksFile)), basename(hooksFile))];
  } catch {
    // No such folder: Codex lists nothing from it either, and the event shows up as missing.
    return [hooksFile];
  }
}

function needsApproval(hook: CodexHook): boolean {
  return hook.trustStatus === "untrusted" || hook.trustStatus === "modified";
}

/** Lists hooks, approves hookmux's untrusted hub entries, then lists again to confirm. */
export async function approveHubEntries(target: ApprovalTarget): Promise<ApprovalResult> {
  return withAppServer(target, async (call) => {
    const { entries: listed, missing } = hubEntries(await listHooks(call), target);
    const untrusted = listed.filter(needsApproval);
    const pending = untrusted.filter((h) => isCurrentHubEntry(h, target.launcher));
    if (pending.length === 0) {
      const stillUntrusted = untrusted.map((h) => h.key);
      return { approved: [], alreadyTrusted: listed.length - untrusted.length, stillUntrusted, missing };
    }
    await call("config/batchWrite", {
      edits: pending.map((h) => ({
        keyPath: `hooks.state.${tomlKey(h.key)}.trusted_hash`,
        mergeStrategy: "upsert",
        value: h.currentHash,
      })),
    });
    const after = hubEntries(await listHooks(call), target).entries;
    return {
      approved: pending.map((h) => h.key).filter((k) => after.some((h) => h.key === k && h.trustStatus === "trusted")),
      alreadyTrusted: listed.length - untrusted.length,
      stillUntrusted: after.filter(needsApproval).map((h) => h.key),
      missing,
    };
  });
}

/** Hub entries and their trust state, for doctor. */
export async function listHubEntries(target: ApprovalTarget): Promise<HubListing> {
  return withAppServer(target, async (call) => hubEntries(await listHooks(call), target));
}

type Call = (method: string, params: unknown) => Promise<unknown>;

async function listHooks(call: Call): Promise<CodexHook[]> {
  // User hooks do not depend on the folder; the home folder keeps project hooks out of the way.
  const result = (await call("hooks/list", { cwds: [homedir()] })) as { data?: { hooks?: CodexHook[] }[] };
  return (result.data ?? []).flatMap((entry) => entry.hooks ?? []);
}

/** A config key path segment: the trust key holds `/`, `:` and `.`, so it is always quoted. */
function tomlKey(key: string): string {
  return JSON.stringify(key);
}

/**
 * Runs one app-server session: initialize, the caller's requests, then kill.
 * @throws Error when codex cannot start, a request fails, or the session runs past its timeout.
 */
async function withAppServer<T>(target: ApprovalTarget, body: (call: Call) => Promise<T>): Promise<T> {
  const child = spawn(target.codex ?? "codex", ["app-server"], {
    env: target.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  let failure: Error | undefined;
  const failAll = (error: Error) => {
    failure ??= error;
    for (const w of waiting.values()) w.reject(failure);
    waiting.clear();
  };
  child.on("error", (error) =>
    failAll(new CodexUnavailableError(`could not start codex app-server: ${error.message}`)),
  );
  child.on("exit", (code) => failAll(new Error(`codex app-server exited (${code ?? "signal"})`)));
  child.stdin.on("error", (error) => failAll(new Error(`codex app-server closed its input: ${error.message}`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // A message with a method is the server's own request or notification; its id is not one of ours.
    if (message.method !== undefined) return;
    const w = typeof message.id === "number" ? waiting.get(message.id) : undefined;
    if (!w) return;
    waiting.delete(message.id as number);
    if (message.error) w.reject(new Error(message.error.message ?? "codex app-server returned an error"));
    else w.resolve(message.result);
  });
  const send = (payload: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const call: Call = (method, params) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  const timer = setTimeout(
    () => failAll(new Error("codex app-server did not answer in time")),
    target.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    await call("initialize", { clientInfo: { name: "hookmux", version: "1" } });
    send({ jsonrpc: "2.0", method: "initialized" });
    return await body(call);
  } finally {
    clearTimeout(timer);
    await stop(child);
  }
}

/** Ends the server: SIGTERM, then SIGKILL after KILL_GRACE_MS, and waits for it to exit. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin?.end();
  child.kill();
  const escalate = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  await exited;
  clearTimeout(escalate);
}
