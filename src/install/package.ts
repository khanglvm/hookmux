// Finds the folders this hookmux package ships: the built engine, the launcher
// template, bundled plugins and the authoring skill. Bundled code lives in
// dist/chunks/ and source runs live in src/, so the root is found by walking up
// to the package.json named "hookmux" rather than by a fixed relative path.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../runtime/fsutil.ts";

const PACKAGE_NAME = "hookmux";

export interface PackageLayout {
  root: string;
  /** Built engine (hook.mjs, cli.mjs, chunks/); copied into the home folder by `init`. */
  dist: string;
  launcherTemplate: string;
  /** Bundled plugins, one folder each; may be missing. */
  plugins: string;
  /** The authoring skill folder; may be missing. */
  skill: string;
}

/**
 * Locates the package that contains `from` (default: this module).
 * @throws Error when no package.json named "hookmux" is found above it.
 */
export function packageLayout(from: string = import.meta.url): PackageLayout {
  let dir = dirname(fileURLToPath(from));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && readJson<{ name?: unknown }>(manifest, {}).name === PACKAGE_NAME) {
      return {
        root: dir,
        dist: join(dir, "dist"),
        launcherTemplate: join(dir, "launcher", "hookmux-hook.sh"),
        plugins: join(dir, "plugins"),
        skill: join(dir, "skills", "hookmux"),
      };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("cannot find the hookmux package folder; reinstall hookmux");
    dir = parent;
  }
}
