// Per-session memory for `dedupe = "session"`: which plugins already fired.
// One small file per session, named by a hash of the session id so ids from
// the host never become file paths. Last write wins when two hooks race; the
// worst case is one extra suggestion.

import { createHash } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic } from "./fsutil.ts";

const MAX_IDS_PER_SESSION = 200;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionFile {
  fired: string[];
}

function sessionFile(dir: string, sessionId: string): string {
  return join(dir, `${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`);
}

export function readFired(dir: string, sessionId: string): Set<string> {
  if (!sessionId) return new Set();
  const data = readJson<SessionFile>(sessionFile(dir, sessionId), { fired: [] });
  return new Set(Array.isArray(data.fired) ? data.fired.filter((v) => typeof v === "string") : []);
}

export function recordFired(dir: string, sessionId: string, ids: string[]): void {
  if (!sessionId || ids.length === 0) return;
  const fired = readFired(dir, sessionId);
  for (const id of ids) fired.add(id);
  writeFileAtomic(sessionFile(dir, sessionId), JSON.stringify({ fired: [...fired].slice(-MAX_IDS_PER_SESSION) }));
}

/** Deletes session files older than a week. Returns how many were removed. */
export function pruneSessions(dir: string, now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > SESSION_TTL_MS) {
        rmSync(file, { force: true });
        removed++;
      }
    }
  } catch {
    // No state folder yet.
  }
  return removed;
}
