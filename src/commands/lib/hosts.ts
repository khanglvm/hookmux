// Hub entries across hosts: which hosts are wired, which events the installed
// plugins need, and registering them. Hosts come only from ADAPTERS, so new
// adapters are picked up without changes here.

// compileRegistry needs every check kind registered first.
import "../../checks/index.ts";
import { CANONICAL_EVENTS, type CanonicalEvent } from "../../core/types.ts";
import { ADAPTERS } from "../../hosts/index.ts";
import type { ConfigChange, HostAdapter } from "../../hosts/types.ts";
import { readInstallState } from "../../install/records.ts";
import { compileRegistry } from "../../load/registry.ts";
import { type Registry, saveRegistry } from "../../load/snapshot.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { detail, say } from "./output.ts";

/** Events every wired host gets, so a later plugin for them works without re-running init. */
export const BASE_EVENTS: readonly CanonicalEvent[] = ["prompt.submit", "session.start"];

export interface HostResult {
  adapter: HostAdapter;
  change?: ConfigChange;
  error?: string;
}

const EVENT_CAPABILITY = "event:";

export function allAdapters(): HostAdapter[] {
  return Object.values(ADAPTERS);
}

/**
 * Base events plus every event a valid plugin listens to (any host variant).
 * Plugins still waiting for promote count too: promote runs in the user's own
 * terminal and does not touch host configs, and Codex needs a /hooks approval
 * for every new entry, so the entries go in once, before promote. An entry for
 * an untrusted plugin runs the engine and adds nothing.
 */
export function neededEvents(registry: Registry): CanonicalEvent[] {
  const wanted = new Set<string>(BASE_EVENTS);
  for (const p of registry.plugins) {
    if (p.status === "invalid") continue;
    // An untrusted entry keeps no spec, only the capabilities promote would approve.
    for (const c of p.capabilities) if (c.startsWith(EVENT_CAPABILITY)) wanted.add(c.slice(EVENT_CAPABILITY.length));
  }
  return CANONICAL_EVENTS.filter((e) => wanted.has(e));
}

/** Hosts whose config already has at least one hub entry for this launcher. */
export function wiredAdapters(paths: HomePaths): HostAdapter[] {
  return allAdapters().filter((a) => a.config.installed(paths.launcher).length > 0);
}

export function installHub(adapter: HostAdapter, paths: HomePaths, events: CanonicalEvent[]): HostResult {
  try {
    const { timeoutSec } = readInstallState(paths.installState);
    return { adapter, change: adapter.config.install({ launcher: paths.launcher, events, timeoutSec }) };
  } catch (error) {
    return { adapter, error: (error as Error).message };
  }
}

/** Recompiles and saves the registry, then adds missing hub entries on every wired host. */
export function syncHosts(paths: HomePaths): { events: CanonicalEvent[]; results: HostResult[] } {
  const registry = compileRegistry(paths);
  try {
    saveRegistry(paths, registry);
  } catch {
    // The hook recompiles a stale or missing registry itself; saving only saves it the work.
  }
  const events = neededEvents(registry);
  return { events, results: wiredAdapters(paths).map((a) => installHub(a, paths, events)) };
}

/** Prints one line per host. Returns true when every host succeeded. */
export function printHostResults(results: HostResult[]): boolean {
  let ok = true;
  for (const { adapter, change, error } of results) {
    if (error || !change) {
      ok = false;
      say("fail", `${adapter.name}: ${error ?? "no change reported"}`, `fix the file, then run: hookmux sync`);
      continue;
    }
    const parts = [
      change.added.length > 0 ? `added ${change.added.join(", ")}` : "",
      change.removed.length > 0 ? `removed ${change.removed.join(", ")}` : "",
    ].filter(Boolean);
    say("ok", `${adapter.name}: ${parts.length > 0 ? parts.join("; ") : "up to date"} (${change.file})`);
    for (const note of change.notes) detail(`! ${note}`);
  }
  return ok;
}

/** Runs sync after a plugin change and reports it briefly. */
export function syncAfterChange(paths: HomePaths): boolean {
  const { results } = syncHosts(paths);
  if (results.length === 0) {
    say("info", "no host has hub entries yet", "hookmux init");
    return true;
  }
  return printHostResults(results);
}
