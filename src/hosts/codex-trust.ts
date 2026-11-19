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
// are never built here. Every other hook keeps its own approval state.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { CANONICAL_EVENTS } from "../core/types.ts";
import { hubCommand } from "./hub-command.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

/** The HookMetadata fields this module reads. */
export interface CodexHook {
  key: string;
  command: string | null;
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
}

/** Hub entries of this launcher that Codex lists, whatever their trust state. */
export function hubEntries(hooks: CodexHook[], target: Pick<ApprovalTarget, "launcher" | "hooksFile">): CodexHook[] {
  const commands = new Set(CANONICAL_EVENTS.map((e) => hubCommand(target.launcher, "codex", e)));
  return hooks.filter(
    (h) =>
      h.command !== null &&
      commands.has(h.command) &&
      h.sourcePath === target.hooksFile &&
      h.source === "user" &&
      !h.isManaged,
  );
}

function needsApproval(hook: CodexHook): boolean {
  return hook.trustStatus === "untrusted" || hook.trustStatus === "modified";
}

/** Lists hooks, approves hookmux's untrusted hub entries, then lists again to confirm. */
export async function approveHubEntries(target: ApprovalTarget): Promise<ApprovalResult> {
  return withAppServer(target, async (call) => {
    const listed = hubEntries(await listHooks(call), target);
    const pending = listed.filter(needsApproval);
    if (pending.length === 0) return { approved: [], alreadyTrusted: listed.length, stillUntrusted: [] };
    await call("config/batchWrite", {
      edits: pending.map((h) => ({
        keyPath: `hooks.state.${tomlKey(h.key)}.trusted_hash`,
        mergeStrategy: "upsert",
        value: h.currentHash,
      })),
    });
    const after = hubEntries(await listHooks(call), target);
    return {
      approved: pending.map((h) => h.key).filter((k) => after.some((h) => h.key === k && h.trustStatus === "trusted")),
      alreadyTrusted: listed.length - pending.length,
      stillUntrusted: after.filter(needsApproval).map((h) => h.key),
    };
  });
}

/** Hub entries and their trust state, for doctor. */
export async function listHubEntries(target: ApprovalTarget): Promise<CodexHook[]> {
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
  child.on("error", (error) => failAll(new Error(`could not start codex app-server: ${error.message}`)));
  child.on("exit", (code) => failAll(new Error(`codex app-server exited (${code ?? "signal"})`)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
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
    child.stdin.end();
    child.kill();
  }
}
