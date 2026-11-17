// Per-session memory for `dedupe = "session"`: which plugins already fired.
// Each session is a folder named by a hash of the session id, so ids from the
// host never become file paths, and each plugin that fired is an empty marker
// file in it. Hook runs of one session can overlap (parallel tool calls), and
// creating a marker is atomic, so concurrent runs never overwrite each other.

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ID } from "../core/types.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sessionDir(dir: string, sessionId: string): string {
  return join(dir, createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
}

export function readFired(dir: string, sessionId: string): Set<string> {
  if (!sessionId) return new Set();
  try {
    return new Set(readdirSync(sessionDir(dir, sessionId)).filter((name) => PLUGIN_ID.test(name)));
  } catch {
    // No marker yet for this session.
    return new Set();
  }
}

/** Creates one marker per plugin id; a marker that already exists is left as it is. */
export function recordFired(dir: string, sessionId: string, ids: string[]): void {
  if (!sessionId || ids.length === 0) return;
  const session = sessionDir(dir, sessionId);
  mkdirSync(session, { recursive: true, mode: 0o700 });
  for (const id of ids) {
    // Ids come from validated manifests; the check keeps any other string out of paths.
    if (!PLUGIN_ID.test(id)) continue;
    try {
      closeSync(openSync(join(session, id), "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Deletes session folders not written to for a week, and files left by the
 * older one-file-per-session format. Returns how many were removed.
 */
export function pruneSessions(dir: string, now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const entry = join(dir, name);
      if (now - statSync(entry).mtimeMs > SESSION_TTL_MS) {
        rmSync(entry, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    // No state folder yet.
  }
  return removed;
}
