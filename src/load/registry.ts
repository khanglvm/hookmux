// Compiles every installed plugin into a Registry: validated, merged with
// overrides and checked against its trust pin. Imported lazily by the hook
// (only when the saved registry is stale) and directly by the CLI.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { HomePaths } from "../runtime/paths.ts";
import { VERSION } from "../version.ts";
import { readConfig } from "./config.ts";
import { applyFlags, type PluginFlags, readFlags } from "./flags.ts";
import { compileManifest, MANIFEST_FILE, ManifestError, PLUGIN_ID, readManifest } from "./manifest.ts";
import {
  KNOWN_HOSTS,
  REGISTRY_FORMAT,
  type Registry,
  type RegistryPlugin,
  type SourceStamp,
  stamp,
} from "./snapshot.ts";
import { capabilitiesOf, hashPlugin, isDeclarativeOnly, listPluginFiles, readTrust } from "./trust.ts";

export function compileRegistry(paths: HomePaths): Registry {
  const config = readConfig(paths.config);
  const trust = readTrust(paths.trust);
  const flags = readFlags(paths.flags);
  const sources: SourceStamp[] = [stamp(paths.config), stamp(paths.trust), stamp(paths.flags), stamp(paths.plugins)];
  const plugins: RegistryPlugin[] = [];

  const ids = existsSync(paths.plugins)
    ? readdirSync(paths.plugins, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  for (const id of ids) {
    const dir = join(paths.plugins, id);
    plugins.push(compileOne(id, dir, config, flags, trust.plugins[id]?.hash, sources));
  }
  return {
    format: REGISTRY_FORMAT,
    engine: VERSION,
    builtAt: new Date().toISOString(),
    sources,
    settings: config.settings,
    providers: config.providers,
    plugins,
    problems: config.problems,
  };
}

function compileOne(
  id: string,
  dir: string,
  config: ReturnType<typeof readConfig>,
  flags: PluginFlags,
  pinned: string | undefined,
  sources: SourceStamp[],
): RegistryPlugin {
  const entry: RegistryPlugin = { id, status: "invalid", warnings: [], capabilities: [] };
  try {
    const listing = listPluginFiles(dir);
    for (const d of listing.dirs) sources.push(stamp(d));
    for (const f of listing.files) sources.push(stamp(f));
    if (!PLUGIN_ID.test(id)) throw new Error("folder name is not a valid plugin id");
    const raw = readManifest(dir);
    if (raw.id !== id) throw new Error(`manifest id '${String(raw.id)}' does not match folder '${id}'`);
    const compiled = compileManifest(raw, dir, config.overrides[id], {
      routeOrigins: config.settings.routeOrigins,
      knownHosts: KNOWN_HOSTS,
    });
    entry.warnings = compiled.warnings;
    entry.capabilities = capabilitiesOf(compiled.base, Object.values(compiled.variants));
    entry.hash = hashPlugin(dir);
    entry.fileHashes = Object.fromEntries(
      listing.files.map((f) => [relative(dir, f), createHash("sha256").update(readFileSync(f)).digest("hex")]),
    );
    const autoTrusted = config.settings.autoTrustDeclarative && isDeclarativeOnly(entry.capabilities);
    if (pinned !== entry.hash && !autoTrusted) {
      entry.status = "untrusted";
      entry.problem = pinned ? "content changed since promote" : "not promoted yet";
      return entry;
    }
    entry.status = "active";
    // Hub flags come last, after the user's overrides, so `disable` and `--shadow` always hold.
    entry.base = applyFlags(compiled.base, flags);
    entry.variants = Object.fromEntries(
      Object.entries(compiled.variants).map(([host, spec]) => [host, applyFlags(spec, flags)]),
    );
  } catch (error) {
    entry.problem = error instanceof ManifestError ? error.problems.join("; ") : (error as Error).message;
    if (!existsSync(join(dir, MANIFEST_FILE))) entry.problem = `no ${MANIFEST_FILE}`;
  }
  return entry;
}
