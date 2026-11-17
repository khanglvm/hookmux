// Installs the plugins shipped in this package's plugins/ folder. They ship with
// the engine, so `init` pins them in trust.json directly. It only ever pins
// content it copied from the package, and leaves alone any plugin with the same
// id that came from somewhere else, so `add --force <bundled id>` followed by
// `init` cannot activate unreviewed content.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { LoadDefaults } from "../load/manifest.ts";
import { hashPlugin, readTrust, writeTrust } from "../load/trust.ts";
import type { HomePaths } from "../runtime/paths.ts";
import { VERSION } from "../version.ts";
import { pluginFoldersIn } from "./discover.ts";
import { BUNDLED_SOURCE, readSources, writeSources } from "./records.ts";
import { discardStaged, placeStaged, stagePlugin } from "./stage.ts";

export interface BundledResult {
  id: string;
  status: "installed" | "unchanged" | "skipped" | "invalid";
  detail?: string;
}

/** Copies and pins every bundled plugin; returns one result per plugin folder found. */
export function installBundled(paths: HomePaths, pluginsDir: string, defaults: LoadDefaults): BundledResult[] {
  if (!existsSync(pluginsDir)) return [];
  const sources = readSources(paths.sources);
  const trust = readTrust(paths.trust);
  const results: BundledResult[] = [];
  for (const dir of pluginFoldersIn(pluginsDir)) {
    let staged: ReturnType<typeof stagePlugin>;
    try {
      staged = stagePlugin(dir, paths, defaults);
    } catch (error) {
      results.push({ id: basename(dir), status: "invalid", detail: (error as Error).message });
      continue;
    }
    const target = join(paths.plugins, staged.id);
    const origin = sources[staged.id]?.source;
    if (existsSync(target) && origin !== BUNDLED_SOURCE) {
      discardStaged(staged);
      results.push({
        id: staged.id,
        status: "skipped",
        detail: `an installed plugin from ${origin ?? "elsewhere"} uses this id`,
      });
      continue;
    }
    if (existsSync(target) && hashPlugin(target) === staged.hash && trust.plugins[staged.id]?.hash === staged.hash) {
      discardStaged(staged);
      results.push({ id: staged.id, status: "unchanged" });
      continue;
    }
    placeStaged(staged, paths, true);
    const now = new Date().toISOString();
    trust.plugins[staged.id] = { hash: staged.hash, capabilities: staged.capabilities, promotedAt: now };
    sources[staged.id] = { source: BUNDLED_SOURCE, ref: VERSION, commit: null, hash: staged.hash, addedAt: now };
    results.push({ id: staged.id, status: "installed" });
  }
  writeTrust(paths.trust, trust);
  writeSources(paths.sources, sources);
  return results;
}
