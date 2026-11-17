// What the CLI knows about installed plugins. The registry only keeps specs for
// active plugins, but list, test and explain also need untrusted ones, so this
// module compiles those again (with the user's override and hub flags) for display.

import "../../checks/index.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginSpec } from "../../core/types.ts";
import { readSources, type SourceRecord } from "../../install/records.ts";
import { type HubConfig, readConfig } from "../../load/config.ts";
import { applyFlags, readFlags } from "../../load/flags.ts";
import { compileManifest, type LoadDefaults, PLUGIN_ID, readManifest } from "../../load/manifest.ts";
import { compileRegistry } from "../../load/registry.ts";
import { KNOWN_HOSTS, type Registry, type RegistryPlugin } from "../../load/snapshot.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { UsageError } from "./args.ts";

/** Status shown to people: registry status, with shadow and disabled split out of "active". */
export type DisplayStatus = "active" | "untrusted" | "invalid" | "shadow" | "disabled";

export interface PluginRow {
  id: string;
  dir: string;
  status: DisplayStatus;
  entry: RegistryPlugin;
  /** Compiled spec with flags applied; absent for invalid plugins. */
  spec?: PluginSpec;
  variants: Record<string, PluginSpec>;
  source?: SourceRecord;
}

export function loadDefaults(config: HubConfig): LoadDefaults {
  return { routeOrigins: config.settings.routeOrigins, knownHosts: KNOWN_HOSTS };
}

/** Compiles every installed plugin, trusted or not. */
export function inspectInstalled(paths: HomePaths): { registry: Registry; rows: PluginRow[] } {
  const registry = compileRegistry(paths);
  const config = readConfig(paths.config);
  const flags = readFlags(paths.flags);
  const sources = readSources(paths.sources);
  const rows = registry.plugins.map((entry): PluginRow => {
    const dir = join(paths.plugins, entry.id);
    const row: PluginRow = { id: entry.id, dir, status: entry.status, entry, variants: entry.variants ?? {} };
    if (sources[entry.id]) row.source = sources[entry.id];
    if (entry.base) row.spec = entry.base;
    else if (entry.status === "untrusted") {
      try {
        const compiled = compileManifest(readManifest(dir), dir, config.overrides[entry.id], loadDefaults(config));
        row.spec = applyFlags(compiled.base, flags);
        row.variants = Object.fromEntries(
          Object.entries(compiled.variants).map(([host, spec]) => [host, applyFlags(spec, flags)]),
        );
      } catch {
        // The registry compiled it a moment ago; a file changed in between. Show it without a spec.
      }
    }
    if (entry.status === "active" && row.spec) {
      if (!row.spec.enabled) row.status = "disabled";
      else if (row.spec.shadow) row.status = "shadow";
    }
    return row;
  });
  return { registry, rows };
}

/** The spec a host runs: its `[host.<id>]` variant when there is one. */
export function specFor(row: PluginRow, hostId: string): PluginSpec | undefined {
  const spec = row.variants[hostId] ?? row.spec;
  return spec && row.entry.fileHashes ? { ...spec, fileHashes: row.entry.fileHashes } : spec;
}

/**
 * Folder of an installed plugin.
 * @throws UsageError for a malformed id (which also keeps ids like "../x" out of paths).
 */
export function installedDir(paths: HomePaths, id: string): string {
  if (!PLUGIN_ID.test(id)) throw new UsageError(`'${id}' is not a valid plugin id`);
  return join(paths.plugins, id);
}

export function isInstalled(paths: HomePaths, id: string): boolean {
  return existsSync(installedDir(paths, id));
}
