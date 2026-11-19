// Writes and inspects ~/.hookmux/bin/hookmux-hook, the shell script every host
// runs. It holds two absolute paths (Node and the home root) inside single
// quotes, so a path containing a quote is refused rather than escaped.

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../runtime/fsutil.ts";
import type { HomePaths } from "../runtime/paths.ts";
import { stableNodePath } from "./node-path.ts";

const LAUNCHER_MODE = 0o755;
const NODE_LINE = /^NODE='([^']*)'$/m;
const ENGINE_LINE = /^ENGINE='([^']*)\/engine\/current\/hook\.mjs'$/m;

export interface LauncherInfo {
  exists: boolean;
  executable: boolean;
  /** Node binary recorded in the launcher, or null when unreadable. */
  node: string | null;
  /** Home root recorded in the launcher, or null when unreadable. */
  root: string | null;
}

/**
 * Fills the template's @NODE@ and @ROOT@ placeholders.
 * @throws Error when either path contains a single quote.
 */
export function renderLauncher(template: string, nodePath: string, root: string): string {
  for (const [label, value] of [
    ["Node path", nodePath],
    ["home folder", root],
  ] as const) {
    if (value.includes("'")) throw new Error(`${label} '${value}' contains a single quote; move it to a plain path`);
  }
  // Function replacers: a string replacement would expand `$&` or `$\`` inside a path.
  return template.replaceAll("@NODE@", () => nodePath).replaceAll("@ROOT@", () => root);
}

export function writeLauncher(paths: HomePaths, templateFile: string, nodePath: string = stableNodePath()): void {
  const text = renderLauncher(readFileSync(templateFile, "utf8"), nodePath, paths.root);
  writeFileAtomic(paths.launcher, text, LAUNCHER_MODE);
}

/** Rewrites only the recorded Node path of an existing launcher (doctor --fix). */
export function rerecordNode(paths: HomePaths, nodePath: string = stableNodePath()): void {
  const text = readFileSync(paths.launcher, "utf8");
  if (!NODE_LINE.test(text)) throw new Error(`${paths.launcher} has no NODE= line; run 'hookmux init' to rewrite it`);
  if (nodePath.includes("'")) throw new Error(`Node path '${nodePath}' contains a single quote`);
  writeFileAtomic(
    paths.launcher,
    text.replace(NODE_LINE, () => `NODE='${nodePath}'`),
    LAUNCHER_MODE,
  );
}

export function readLauncherInfo(paths: HomePaths): LauncherInfo {
  if (!existsSync(paths.launcher)) return { exists: false, executable: false, node: null, root: null };
  let executable = true;
  try {
    accessSync(paths.launcher, constants.X_OK);
  } catch {
    executable = false;
  }
  let text = "";
  try {
    text = readFileSync(paths.launcher, "utf8");
  } catch {
    // Unreadable: reported as no recorded paths.
  }
  return {
    exists: true,
    executable,
    node: NODE_LINE.exec(text)?.[1] ?? null,
    root: ENGINE_LINE.exec(text)?.[1] ?? null,
  };
}
