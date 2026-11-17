// Finds plugin folders inside a source: the root itself, plugins/*, hookmux/*
// and skills/*/hookmux. Only real folders and real plugin.toml files count;
// symlinks are skipped here and refused later when the plugin is staged.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE } from "../load/manifest.ts";

function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasManifest(dir: string): boolean {
  try {
    return lstatSync(join(dir, MANIFEST_FILE)).isFile();
  } catch {
    return false;
  }
}

function childDirs(dir: string): string[] {
  if (!isRealDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(dir, d.name))
    .sort();
}

/** Direct child folders of `dir` that hold a plugin.toml (bundled plugins). */
export function pluginFoldersIn(dir: string): string[] {
  return childDirs(dir).filter(hasManifest);
}

/** Plugin folders under `root`, in a stable order. */
export function discoverPlugins(root: string): string[] {
  const candidates = [
    root,
    ...childDirs(join(root, "plugins")),
    ...childDirs(join(root, "hookmux")),
    ...childDirs(join(root, "skills")).map((d) => join(d, "hookmux")),
  ];
  return [...new Set(candidates.filter((d) => isRealDir(d) && hasManifest(d)))];
}
