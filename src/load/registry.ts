// Compiles every installed plugin into a Registry: validated, merged with
// overrides and checked against its trust pin. Imported lazily by the hook
// (only when the saved registry is stale) and directly by the CLI.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginSpec } from "../core/types.ts";
import { readSources, type SourceStore } from "../install/records.ts";
import type { HomePaths } from "../runtime/paths.ts";
import { VERSION } from "../version.ts";
import { cardFactsOf } from "./card-facts.ts";
import { readConfig } from "./config.ts";
import { applyFlags, type FlagsRead, readFlags } from "./flags.ts";
import {
  type CompiledPlugin,
  compileManifest,
  MANIFEST_FILE,
  ManifestError,
  PLUGIN_ID,
  type RawManifest,
  readManifestText,
} from "./manifest.ts";
import {
  KNOWN_HOSTS,
  REGISTRY_FORMAT,
  type Registry,
  type RegistryPlugin,
  type SourceStamp,
  stamp,
} from "./snapshot.ts";
import {
  capabilitiesOf,
  fileHashesOf,
  hashFiles,
  isDeclarativeOnly,
  readPluginFiles,
  readTrust,
  type TrustEntry,
  uncoveredCapabilities,
} from "./trust.ts";

export function compileRegistry(paths: HomePaths): Registry {
  const config = readConfig(paths.config);
  const trust = readTrust(paths.trust);
  const flags = readFlags(paths.flags);
  const records = readSources(paths.sources);
  // sources.json feeds the approval card, so a change to it must rebuild the snapshot.
  const sources: SourceStamp[] = [
    stamp(paths.config),
    stamp(paths.trust),
    stamp(paths.flags),
    stamp(paths.sources),
    stamp(paths.plugins),
  ];
  const plugins: RegistryPlugin[] = [];

  const ids = existsSync(paths.plugins)
    ? readdirSync(paths.plugins, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  for (const id of ids) {
    const dir = join(paths.plugins, id);
    plugins.push(compileOne({ id, dir, config, flags, pinned: trust.plugins[id], record: records[id], sources }));
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

interface CompileInput {
  id: string;
  dir: string;
  config: ReturnType<typeof readConfig>;
  flags: FlagsRead;
  pinned: TrustEntry | undefined;
  record: SourceStore[string] | undefined;
  sources: SourceStamp[];
}

function compileOne({ id, dir, config, flags, pinned, record, sources }: CompileInput): RegistryPlugin {
  const entry: RegistryPlugin = { id, status: "invalid", warnings: [], capabilities: [] };
  try {
    // Every file is read once: the trust hash, the per-file hashes and the parsed
    // manifest all come from these bytes, so an edit between steps cannot slip in.
    const read = readPluginFiles(dir);
    for (const d of read.dirs) sources.push(stamp(d));
    for (const f of read.paths) sources.push(stamp(f));
    if (!PLUGIN_ID.test(id)) throw new Error("folder name is not a valid plugin id");
    // A corrupt flags file could hide a `disable`, so no plugin runs until it is fixed.
    if (flags.problem) throw new Error(flags.problem);
    const manifest = read.files.find((f) => f.rel === MANIFEST_FILE);
    if (!manifest) throw new Error(`no ${MANIFEST_FILE}`);
    const raw = readManifestText(dir, manifest.bytes.toString("utf8"));
    if (raw.id !== id) throw new Error(`manifest id '${String(raw.id)}' does not match folder '${id}'`);
    const compiled = compileManifest(raw, dir, config.overrides[id], {
      routeOrigins: config.settings.routeOrigins,
      knownHosts: KNOWN_HOSTS,
    });
    entry.warnings = compiled.warnings;
    entry.phase = guardOnAnyLayer(raw, compiled) ? "guard" : compiled.base.phase;
    entry.hash = hashFiles(read.files);
    entry.fileHashes = fileHashesOf(read.files);
    // Capabilities of what would actually run: the manifest with config.toml overrides
    // (merged by compileManifest) and hub flags applied.
    const flagged = (spec: PluginSpec) => applyFlags(spec, flags);
    const base = flagged(compiled.base);
    const variants = Object.fromEntries(Object.entries(compiled.variants).map(([host, spec]) => [host, flagged(spec)]));
    entry.capabilities = capabilitiesOf(base, Object.values(variants));
    entry.card = cardFactsOf({ id, base, variants: Object.values(variants), source: record });
    const decision = trustDecision({
      id,
      hash: entry.hash,
      capabilities: entry.capabilities,
      pinned,
      autoTrustDeclarative: config.settings.autoTrustDeclarative,
    });
    // An unpromoted plugin flagged shadow (`add --shadow`) may run in shadow mode so its
    // decisions show in the log before anyone approves it. It never reaches the agent,
    // and plugins with scripts stay off entirely, because that would run unreviewed code.
    const shadowPreview = !decision.trusted && flags.shadow.includes(id) && !entry.capabilities.includes("script");
    if (!decision.trusted && !shadowPreview) {
      entry.status = "untrusted";
      entry.problem = decision.problem;
      return entry;
    }
    entry.status = "active";
    entry.trusted = decision.trusted;
    if (shadowPreview) entry.problem = "not promoted yet; running in shadow only";
    // Hub flags come last, after the user's overrides, so `disable` and `--shadow` always hold.
    const finish = (spec: PluginSpec) => (shadowPreview ? { ...spec, shadow: true } : spec);
    entry.base = finish(base);
    entry.variants = Object.fromEntries(Object.entries(variants).map(([host, spec]) => [host, finish(spec)]));
  } catch (error) {
    entry.problem = error instanceof ManifestError ? error.problems.join("; ") : (error as Error).message;
    if (!flags.problem && !existsSync(join(dir, MANIFEST_FILE))) entry.problem = `no ${MANIFEST_FILE}`;
  }
  return entry;
}

/**
 * Security: a config.toml override can change phase without promote, so a plugin that is a guard in its
 * manifest, in one of its `[host.<id>]` tables or on any compiled host stays a guard for HOOKMUX_DISABLE and the
 * off notice.
 */
function guardOnAnyLayer(raw: RawManifest, compiled: CompiledPlugin): boolean {
  const rawHosts = raw.host !== null && typeof raw.host === "object" ? Object.values(raw.host) : [];
  const phases = [
    raw.phase,
    ...rawHosts.map((h) => (h !== null && typeof h === "object" ? (h as RawManifest).phase : undefined)),
    compiled.base.phase,
    ...Object.values(compiled.variants).map((v) => v.phase),
  ];
  return phases.includes("guard");
}

/**
 * Trusted when the pin matches the content and approved every capability the
 * effective spec has, or when auto-trust covers a declarative plugin. A config
 * override can add a block effect, an event or a script check without touching
 * the plugin folder, so a matching hash alone is not enough.
 */
function trustDecision(input: {
  id: string;
  hash: string;
  capabilities: string[];
  pinned: TrustEntry | undefined;
  autoTrustDeclarative: boolean;
}): { trusted: true } | { trusted: false; problem: string } {
  const { id, hash, capabilities, pinned, autoTrustDeclarative } = input;
  if (autoTrustDeclarative && isDeclarativeOnly(capabilities)) return { trusted: true };
  if (!pinned) return { trusted: false, problem: "not promoted yet" };
  if (pinned.hash !== hash) return { trusted: false, problem: "content changed since promote" };
  const added = uncoveredCapabilities(capabilities, pinned.capabilities);
  if (added.length === 0) return { trusted: true };
  return { trusted: false, problem: `config override adds ${added.join(", ")}; run hookmux promote ${id}` };
}
