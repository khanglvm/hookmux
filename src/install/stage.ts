// Copies a plugin from its source into a staging folder next to plugins/,
// tightens file modes, validates the copy and then renames it into place. Only
// the files the trust hash covers are copied (no symlinks, no .git), so the
// hub-owned copy is exactly what `promote` later pins.

import "../checks/index.ts";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type CompiledPlugin, compileManifest, type LoadDefaults, PLUGIN_ID, readManifest } from "../load/manifest.ts";
import { capabilitiesOf, hashPlugin, listPluginFiles } from "../load/trust.ts";
import type { HomePaths } from "../runtime/paths.ts";

/** Group and other write bits; a hub copy never keeps them. */
const SHARED_WRITE = 0o022;
const DIR_MODE = 0o755;

export interface StagedPlugin {
  id: string;
  /** Staging folder holding the validated copy. */
  dir: string;
  compiled: CompiledPlugin;
  capabilities: string[];
  hash: string;
  /** Relative file paths, sorted. */
  files: string[];
}

export class PluginExistsError extends Error {}

/**
 * Copies and validates one plugin folder.
 * @throws Error (ManifestError for manifest problems) when the plugin has links,
 * is too large, or does not compile; nothing is left in the staging folder.
 */
export function stagePlugin(sourceDir: string, paths: HomePaths, defaults: LoadDefaults): StagedPlugin {
  const { files } = listPluginFiles(sourceDir);
  mkdirSync(paths.staging, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(paths.staging, "add-"));
  try {
    chmodSync(dir, DIR_MODE);
    const relFiles = files.map((f) => relative(sourceDir, f));
    for (const rel of relFiles) copyPrivate(join(sourceDir, rel), join(dir, rel), dir);
    const raw = readManifest(dir);
    if (typeof raw.id !== "string" || !PLUGIN_ID.test(raw.id)) {
      throw new Error("id must be lowercase letters, digits and dashes (max 64)");
    }
    const compiled = compileManifest(raw, dir, undefined, defaults);
    return {
      id: raw.id,
      dir,
      compiled,
      capabilities: capabilitiesOf(compiled.base, Object.values(compiled.variants)),
      hash: hashPlugin(dir),
      files: relFiles,
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Copies one file, dropping group/other write and keeping the owner's read and execute bits. */
function copyPrivate(from: string, to: string, root: string): void {
  const parent = dirname(to);
  mkdirSync(parent, { recursive: true });
  for (let d = parent; d !== root; d = dirname(d)) chmodSync(d, DIR_MODE);
  copyFileSync(from, to);
  const mode = (lstatSync(from).mode & 0o777 & ~SHARED_WRITE) | 0o600;
  chmodSync(to, mode);
  if ((lstatSync(to).mode & SHARED_WRITE) !== 0)
    throw new Error(`${relative(root, to)} is still group or world writable`);
}

/**
 * Moves a staged plugin to plugins/<id>/.
 * @throws PluginExistsError when the id is taken and `force` is false.
 */
export function placeStaged(staged: StagedPlugin, paths: HomePaths, force: boolean): string {
  const target = join(paths.plugins, staged.id);
  mkdirSync(paths.plugins, { recursive: true, mode: 0o700 });
  if (existsSync(target)) {
    if (!force) {
      discardStaged(staged);
      throw new PluginExistsError(`plugin '${staged.id}' is already installed`);
    }
    const old = join(paths.staging, `old-${staged.id}-${process.pid}`);
    renameSync(target, old);
    renameSync(staged.dir, target);
    rmSync(old, { recursive: true, force: true });
  } else renameSync(staged.dir, target);
  return target;
}

export function discardStaged(staged: StagedPlugin): void {
  rmSync(staged.dir, { recursive: true, force: true });
}
