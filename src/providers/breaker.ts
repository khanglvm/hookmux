// Circuit breaker shared by every hook run: after a provider fails, later runs
// skip it for a cool-down instead of each paying a full timeout. Every hook run
// is a new process and runs can overlap, so each provider has its own small
// file, named by a hash of the provider name; one provider's update can never
// overwrite another's.

import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../runtime/fsutil.ts";
import { homePaths } from "../runtime/paths.ts";

/** How long a failed provider is skipped, in milliseconds. */
export const COOLDOWN_MS = 30_000;

/** Folder holding one breaker file per provider. */
export function breakerDir(): string {
  return join(homePaths().root, "state", "providers");
}

function breakerFile(dir: string, name: string): string {
  return join(dir, `${createHash("sha256").update(name).digest("hex").slice(0, 32)}.json`);
}

/** Epoch milliseconds when the provider may be tried again, or undefined when it is not cooling down. */
function readUntil(file: string): number | undefined {
  try {
    const until = (JSON.parse(readFileSync(file, "utf8")) as { until?: unknown } | null)?.until;
    return typeof until === "number" ? until : undefined;
  } catch {
    return undefined;
  }
}

export function isCoolingDown(name: string, now = Date.now(), dir = breakerDir()): boolean {
  const until = readUntil(breakerFile(dir, name));
  return until !== undefined && now < until;
}

/**
 * Losing breaker state only means a provider is retried sooner, so a failed
 * write is ignored rather than turned into a check error.
 */
export function recordFailure(name: string, now = Date.now(), dir = breakerDir()): void {
  try {
    writeFileAtomic(breakerFile(dir, name), JSON.stringify({ until: now + COOLDOWN_MS }));
  } catch {
    // Read-only or full disk: keep classifying without the breaker.
  }
}

/** Clears the provider's entry. Removes only when there is one, so a healthy provider costs no disk write. */
export function recordSuccess(name: string, dir = breakerDir()): void {
  const file = breakerFile(dir, name);
  if (readUntil(file) === undefined) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Same as a failed write: the provider is only skipped a little longer.
  }
}
