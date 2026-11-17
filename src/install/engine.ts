// Installs the engine into ~/.hookmux/engine/<version>/ and points
// engine/current at it. The launcher runs engine/current/hook.mjs, so the switch
// is a single symlink rename: a hook that starts mid-update sees either the old
// engine or the new one, never a half-copied folder.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import type { HomePaths } from "../runtime/paths.ts";

export const ENGINE_ENTRY = "hook.mjs";
/** Earlier engine versions kept for a quick rollback; older ones are deleted. */
const KEEP_PREVIOUS = 2;
const CURRENT = "current";

export interface EngineInstall {
  version: string;
  dir: string;
  /** False when the same build was already installed. */
  copied: boolean;
  pruned: string[];
}

export interface EngineStatus {
  /** engine/current exists and resolves to a folder with hook.mjs. */
  ok: boolean;
  /** Version folder engine/current points at, or null when it is missing or broken. */
  version: string | null;
  problem?: string;
}

/**
 * Copies `distDir` into engine/<version>/ (replacing a different build of the same
 * version), repoints engine/current and prunes old versions.
 * @throws Error when `distDir` has no built engine.
 */
export function installEngine(paths: HomePaths, distDir: string, version: string): EngineInstall {
  if (!existsSync(join(distDir, ENGINE_ENTRY))) {
    throw new Error(`no engine build at ${distDir}; run 'pnpm build' in the hookmux package`);
  }
  mkdirSync(paths.engineRoot, { recursive: true, mode: 0o700 });
  const target = join(paths.engineRoot, version);
  const copied = treeDigest(distDir) !== treeDigest(target);
  if (copied) replaceFolder(distDir, target);
  pointCurrent(paths, version);
  return { version, dir: target, copied, pruned: pruneEngines(paths, version) };
}

export function engineStatus(paths: HomePaths): EngineStatus {
  let link: string;
  try {
    link = readlinkSync(paths.engineCurrent);
  } catch {
    const problem = existsSync(paths.engineCurrent) ? "engine/current is not a symlink" : "engine/current is missing";
    return { ok: false, version: null, problem };
  }
  try {
    const version = basename(realpathSync(paths.engineCurrent));
    if (!existsSync(join(paths.engineCurrent, ENGINE_ENTRY))) {
      return { ok: false, version, problem: `engine ${version} has no ${ENGINE_ENTRY}` };
    }
    return { ok: true, version };
  } catch {
    return { ok: false, version: null, problem: `engine/current points at missing '${link}'` };
  }
}

/** Copies into a temp folder, then swaps it in, so the target is never half-written. */
function replaceFolder(source: string, target: string): void {
  const temp = `${target}.tmp-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  cpSync(source, temp, { recursive: true });
  if (existsSync(target)) renameSync(target, old);
  renameSync(temp, target);
  rmSync(old, { recursive: true, force: true });
}

function pointCurrent(paths: HomePaths, version: string): void {
  const temp = `${paths.engineCurrent}.tmp-${process.pid}`;
  rmSync(temp, { force: true });
  // Relative target, so the home folder can be moved without breaking the link.
  symlinkSync(version, temp);
  try {
    if (lstatSync(paths.engineCurrent).isDirectory()) rmSync(paths.engineCurrent, { recursive: true });
  } catch {
    // Nothing there yet.
  }
  renameSync(temp, paths.engineCurrent);
}

/** Deletes leftovers of interrupted installs and all but the newest earlier versions. */
function pruneEngines(paths: HomePaths, active: string): string[] {
  const entries = readdirSync(paths.engineRoot, { withFileTypes: true }).filter(
    (d) => d.name !== CURRENT && d.name !== active,
  );
  const leftovers = entries.filter((d) => /\.(tmp|old)-\d+$/.test(d.name));
  const versions = entries
    .filter((d) => d.isDirectory() && !leftovers.includes(d))
    .map((d) => ({ name: d.name, mtime: statSync(join(paths.engineRoot, d.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const doomed = [...leftovers.map((d) => d.name), ...versions.slice(KEEP_PREVIOUS).map((v) => v.name)];
  for (const name of doomed) rmSync(join(paths.engineRoot, name), { recursive: true, force: true });
  return doomed;
}

/** Hash of every file's relative path and bytes; "" when the folder is missing. */
function treeDigest(dir: string): string {
  if (!existsSync(dir)) return "";
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(`${relative(dir, full)}\0`).update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest("hex");
}
