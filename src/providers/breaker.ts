// Circuit breaker shared by every hook run: after a provider fails, later runs
// skip it for a cool-down instead of each paying a full timeout. State lives in
// one small JSON file because every hook run is a new process.

import { join } from "node:path";
import { readJson, writeFileAtomic } from "../runtime/fsutil.ts";
import { homePaths } from "../runtime/paths.ts";

/** How long a failed provider is skipped, in milliseconds. */
export const COOLDOWN_MS = 30_000;

/** Provider name to the epoch milliseconds when it may be tried again. */
type BreakerState = Record<string, { until: number }>;

export function breakerFile(): string {
  return join(homePaths().root, "state", "providers.json");
}

function readState(file: string): BreakerState {
  const raw = readJson<unknown>(file, {});
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state: BreakerState = {};
  for (const [name, entry] of Object.entries(raw)) {
    const until = (entry as { until?: unknown } | null)?.until;
    if (typeof until === "number") state[name] = { until };
  }
  return state;
}

/**
 * Losing breaker state only means a provider is retried sooner, so a failed
 * write is ignored rather than turned into a check error.
 */
function writeState(file: string, state: BreakerState): void {
  try {
    writeFileAtomic(file, JSON.stringify(state));
  } catch {
    // Read-only or full disk: keep classifying without the breaker.
  }
}

export function isCoolingDown(name: string, now = Date.now(), file = breakerFile()): boolean {
  const until = readState(file)[name]?.until;
  return until !== undefined && now < until;
}

export function recordFailure(name: string, now = Date.now(), file = breakerFile()): void {
  const state = readState(file);
  for (const [key, entry] of Object.entries(state)) if (entry.until <= now) delete state[key];
  state[name] = { until: now + COOLDOWN_MS };
  writeState(file, state);
}

/** Clears the provider's entry. Writes only when there is one, so a healthy provider costs no disk write. */
export function recordSuccess(name: string, file = breakerFile()): void {
  const state = readState(file);
  if (state[name] === undefined) return;
  delete state[name];
  writeState(file, state);
}
