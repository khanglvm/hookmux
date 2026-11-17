// Private, content-addressed copies of verified scripts. The script check
// hashes the plugin's file and then runs this copy, named by that hash, so an
// edit to the plugin file between the hash check and the exec cannot change
// what runs. Copies live in ~/.hookmux/cache/scripts (mode 0700), are written
// atomically, and are re-hashed before each reuse.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../runtime/fsutil.ts";
import { homePaths } from "../runtime/paths.ts";

/** Owner-only: readable, writable and executable by the user who runs the hook. */
const SCRIPT_MODE = 0o700;

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Path of the cached copy of `bytes`, writing it first if it is not there yet.
 * @param sha256 the hex digest of `bytes`, already checked against the promote-time hash.
 * @throws Error when the cache folder cannot be written.
 */
export function cachedScript(bytes: Buffer, sha256: string, root = homePaths().root): string {
  const file = join(root, "cache", "scripts", sha256);
  // The name alone proves nothing: a copy that was edited or planted is replaced.
  if (cachedHash(file) !== sha256) writeFileAtomic(file, bytes, SCRIPT_MODE);
  return file;
}

function cachedHash(file: string): string | undefined {
  try {
    return sha256Hex(readFileSync(file));
  } catch {
    return undefined;
  }
}
