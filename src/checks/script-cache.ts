// Private, content-addressed copies of verified scripts. The script check
// hashes the plugin's file and then runs this copy, named by that hash, so an
// edit to the plugin file between the hash check and the exec cannot change
// what runs. Copies live in ~/.hookmux/cache/scripts. A copy is reused only when
// it and both cache folders are private to the user and its bytes still hash
// right; anything else is replaced atomically before it runs.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homePaths } from "../runtime/paths.ts";

/** Owner-only: readable, writable and executable by the user who runs the hook. */
const PRIVATE_MODE = 0o700;
/** Permission bits plus setuid, setgid and sticky, so "exactly 0700" also rules those out. */
const MODE_BITS = 0o7777;

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Path of the cached copy of `bytes`, writing it first if no trustworthy copy is there.
 * @param sha256 the hex digest of `bytes`, already checked against the promote-time hash.
 * @throws Error when a cache folder is not private to the user or cannot be written.
 */
export function cachedScript(bytes: Buffer, sha256: string, root = homePaths().root): string {
  const cache = join(root, "cache");
  const dir = join(cache, "scripts");
  mkdirSync(root, { recursive: true, mode: PRIVATE_MODE });
  ensurePrivateDir(cache);
  ensurePrivateDir(dir);
  const file = join(dir, sha256);
  // The name alone proves nothing: a copy that was edited, planted or linked is replaced.
  if (!isTrustedCopy(file, sha256)) replaceCopy(dir, file, bytes);
  return file;
}

/** The current uid, or undefined where the platform has none (Windows). */
function currentUid(): number | undefined {
  return process.getuid?.();
}

/**
 * Creates `dir` with mode 0700 if missing. An existing folder must be a real
 * directory owned by the user; a looser mode on our own folder is tightened.
 * @throws Error for a symlink, a non-directory or a folder someone else owns.
 */
function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { mode: PRIVATE_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(dir);
  const uid = currentUid();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(`${dir} is not a folder owned by you; remove it so hookmux can recreate it`);
  }
  // mkdir's mode is cut by the umask, and an older folder may predate this check.
  if ((stat.mode & MODE_BITS) !== PRIVATE_MODE) chmodSync(dir, PRIVATE_MODE);
}

/** A regular file (not a symlink) owned by the user, mode exactly 0700, whose bytes hash to `sha256`. */
function isTrustedCopy(file: string, sha256: string): boolean {
  try {
    const stat = lstatSync(file);
    const uid = currentUid();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid)) return false;
    if ((stat.mode & MODE_BITS) !== PRIVATE_MODE) return false;
    return sha256Hex(readFileSync(file)) === sha256;
  } catch {
    return false;
  }
}

/**
 * Writes a fresh copy next to `file` and renames it into place. The rename
 * replaces whatever sits at `file` (a symlink is replaced, not followed).
 */
function replaceCopy(dir: string, file: string, bytes: Buffer): void {
  const temp = join(dir, `.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // `wx` refuses a file planted under the temp name; the chmod undoes the umask.
    writeFileSync(temp, bytes, { mode: PRIVATE_MODE, flag: "wx" });
    chmodSync(temp, PRIVATE_MODE);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
