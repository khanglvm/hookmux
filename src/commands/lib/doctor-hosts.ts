// Doctor checks per host: the config parses, hub entries cover every needed
// event, and the real launcher answers a sample event in time with valid output.
// Codex also records approval per hook, so its approvals are checked best effort.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import type { CanonicalEvent } from "../../core/types.ts";
import { isHubCommand } from "../../hosts/hub-command.ts";
import type { HostAdapter } from "../../hosts/types.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import type { Finding } from "./doctor-checks.ts";
import { allAdapters } from "./hosts.ts";

const runFile = promisify(execFile);
/** The real launcher gets this long to answer before doctor calls it a hang. */
const LIVE_TIMEOUT_MS = 10_000;

export async function checkHosts(paths: HomePaths, needed: CanonicalEvent[]): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const adapter of allAdapters()) out.push(...(await checkHost(adapter, paths, needed)));
  if (out.length === 0)
    out.push({
      id: "hosts",
      status: "warn",
      title: "no agent client detected or wired",
      fix: "hookmux init --host <id>",
    });
  return out;
}

async function checkHost(adapter: HostAdapter, paths: HomePaths, needed: CanonicalEvent[]): Promise<Finding[]> {
  const id = `host.${adapter.id}`;
  const file = adapter.config.file();
  try {
    // With no events, install() only reads and validates the config; it writes nothing.
    adapter.config.install({ launcher: paths.launcher, events: [], timeoutSec: 1 });
  } catch (error) {
    if (!adapter.config.detect()) return [];
    return [
      {
        id,
        status: "fail",
        title: `${adapter.name}: ${(error as Error).message}`,
        fix: `fix ${file}, then hookmux sync`,
      },
    ];
  }
  const installed = adapter.config.installed(paths.launcher);
  if (installed.length === 0) {
    return adapter.config.detect()
      ? [
          {
            id,
            status: "info",
            title: `${adapter.name}: detected, not wired`,
            fix: `hookmux init --host ${adapter.id}`,
          },
        ]
      : [];
  }
  const out: Finding[] = [];
  const wanted = needed.filter((e) => adapter.nativeEvents[e] !== null);
  const missing = wanted.filter((e) => !installed.includes(e));
  if (missing.length > 0) {
    out.push({
      id,
      status: "fail",
      title: `${adapter.name}: no hub entry for ${missing.join(", ")}`,
      fix: "hookmux sync",
    });
  } else out.push({ id, status: "ok", title: `${adapter.name}: hub entries for ${installed.join(", ")} (${file})` });
  out.push(await liveRun(adapter, paths));
  out.push(...(HOST_PROBES[adapter.id]?.(adapter, paths, installed) ?? []));
  return out;
}

/** Runs the real launcher with the adapter's sample prompt, in a fresh session so dedupe is empty. */
async function liveRun(adapter: HostAdapter, paths: HomePaths): Promise<Finding> {
  const id = `host.${adapter.id}.run`;
  const payload = adapter.sample("prompt.submit");
  if ("session_id" in payload) payload.session_id = `hookmux-doctor-${randomUUID()}`;
  const { HOOKMUX_DISABLE: _off, ...env } = process.env;
  const started = performance.now();
  try {
    const pending = runFile(paths.launcher, ["--host", adapter.id, "--event", "prompt.submit"], {
      timeout: LIVE_TIMEOUT_MS,
      env,
    });
    pending.child.stdin?.end(JSON.stringify(payload));
    const { stdout } = await pending;
    const ms = Math.round(performance.now() - started);
    if (stdout.trim() !== "") JSON.parse(stdout);
    return {
      id,
      status: "ok",
      title: `${adapter.name}: launcher answered in ${ms} ms (${stdout.trim() ? "JSON" : "empty"} output)`,
    };
  } catch (error) {
    const e = error as Error & { killed?: boolean };
    const why = e.killed
      ? `no answer within ${LIVE_TIMEOUT_MS / 1000} s`
      : e instanceof SyntaxError
        ? "stdout is not valid JSON"
        : e.message;
    return {
      id,
      status: "fail",
      title: `${adapter.name}: launcher run failed: ${why}`,
      fix: 'hookmux log on --for 30m, then hookmux explain "test"',
    };
  }
}

type HostProbe = (adapter: HostAdapter, paths: HomePaths, installed: CanonicalEvent[]) => Finding[];

/** Host-specific extras that the adapter contract does not cover. */
const HOST_PROBES: Record<string, HostProbe> = { codex: codexApprovals };

/** "UserPromptSubmit" → "user_prompt_submit", the event label Codex uses in its trust keys. */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Codex trusts each hook by `[hooks.state."<hooks.json>:<event>:<group>:<handler>"]`
 * with a `trusted_hash`. Best effort: any read failure becomes a hint to use /hooks.
 */
function codexApprovals(adapter: HostAdapter, paths: HomePaths, installed: CanonicalEvent[]): Finding[] {
  const id = `host.${adapter.id}.approval`;
  const hint = "open Codex, run /hooks and approve the hookmux entries";
  try {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const config = parseToml(readFileSync(join(home, "config.toml"), "utf8")) as {
      hooks?: { state?: Record<string, { trusted_hash?: unknown }> };
    };
    const state = config.hooks?.state ?? {};
    const hooksFile = adapter.config.file();
    const table =
      (JSON.parse(readFileSync(hooksFile, "utf8")) as { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> })
        .hooks ?? {};
    const unapproved: string[] = [];
    for (const event of installed) {
      const native = adapter.nativeEvents[event] as string;
      (table[native] ?? []).forEach((group, g) => {
        (group.hooks ?? []).forEach((handler, h) => {
          if (!isHubCommand(handler.command, paths.launcher)) return;
          if (typeof state[`${hooksFile}:${snakeCase(native)}:${g}:${h}`]?.trusted_hash !== "string")
            unapproved.push(event);
        });
      });
    }
    return unapproved.length > 0
      ? [{ id, status: "warn", title: `${adapter.name} has not approved: ${unapproved.join(", ")}`, fix: hint }]
      : [{ id, status: "ok", title: `${adapter.name}: hub entries approved` }];
  } catch {
    return [{ id, status: "warn", title: `${adapter.name}: could not read hook approvals`, fix: hint }];
  }
}
