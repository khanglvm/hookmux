// The compiled registry as the hook sees it: types, reading, the staleness
// check and host selection. Compiling lives in registry.ts and is imported only
// when the saved registry is stale, so the TOML parser stays off the hot path.

import { statSync } from "node:fs";
import type { ProviderSettings } from "../checks/registry.ts";
import type { Phase, PluginSpec } from "../core/types.ts";
import { readJson, writeFileAtomic } from "../runtime/fsutil.ts";
import type { HomePaths } from "../runtime/paths.ts";
import { VERSION } from "../version.ts";
import type { HubSettings } from "./config.ts";

export const REGISTRY_FORMAT = 4;
export const KNOWN_HOSTS = ["claude-code", "codex", "gemini-cli"];

export interface SourceStamp {
  path: string;
  /** -1 when the path did not exist at compile time. */
  mtimeMs: number;
  size: number;
}

export type PluginStatus = "active" | "untrusted" | "invalid";

export interface RegistryPlugin {
  id: string;
  status: PluginStatus;
  problem?: string;
  warnings: string[];
  capabilities: string[];
  /** True when promote (or auto-trust) approved this content and capabilities; shadow previews are not. */
  trusted?: boolean;
  hash?: string;
  /** SHA-256 per file (relative path), so scripts can be re-verified right before they run. */
  fileHashes?: Record<string, string>;
  base?: PluginSpec;
  variants?: Record<string, PluginSpec>;
  /** "guard" when the manifest or any host makes it one, else the base phase; kept for untrusted plugins too. */
  phase?: Phase;
}

export interface Registry {
  format: number;
  engine: string;
  builtAt: string;
  sources: SourceStamp[];
  settings: HubSettings;
  providers: Record<string, ProviderSettings>;
  plugins: RegistryPlugin[];
  problems: string[];
}

export function stamp(path: string): SourceStamp {
  try {
    const s = statSync(path);
    return { path, mtimeMs: s.mtimeMs, size: s.isDirectory() ? 0 : s.size };
  } catch {
    return { path, mtimeMs: -1, size: 0 };
  }
}

/** True when any recorded source changed, appeared or disappeared since compile. */
export function isStale(registry: Registry): boolean {
  if (registry.format !== REGISTRY_FORMAT || registry.engine !== VERSION) return true;
  for (const source of registry.sources) {
    const now = stamp(source.path);
    if (now.mtimeMs !== source.mtimeMs || now.size !== source.size) return true;
  }
  return false;
}

export function saveRegistry(paths: HomePaths, registry: Registry): void {
  writeFileAtomic(paths.registry, JSON.stringify(registry));
}

/** Reads the saved registry; null when missing, corrupt or from another format. */
export function readRegistry(paths: HomePaths): Registry | null {
  const registry = readJson<Registry | null>(paths.registry, null);
  return registry && registry.format === REGISTRY_FORMAT && Array.isArray(registry.plugins) ? registry : null;
}

/** The registry the hook should use: saved if fresh, otherwise rebuilt and saved. */
export async function loadRegistry(paths: HomePaths): Promise<Registry> {
  const saved = readRegistry(paths);
  if (saved && !isStale(saved)) return saved;
  const { compileRegistry } = await import("./registry.ts");
  const fresh = compileRegistry(paths);
  try {
    saveRegistry(paths, fresh);
  } catch {
    // A read-only home still works; the next run recompiles again.
  }
  return fresh;
}

/**
 * Active plugin specs for one host, with that host's variant when it has one.
 * `guardsOnly` keeps only plugins whose registry phase is guard, even where a host variant runs one as another phase.
 */
export function activeSpecs(registry: Registry, hostId: string, guardsOnly = false): PluginSpec[] {
  const out: PluginSpec[] = [];
  for (const p of registry.plugins) {
    if (p.status !== "active" || !p.base) continue;
    if (guardsOnly && p.phase !== "guard") continue;
    const spec = p.variants?.[hostId] ?? p.base;
    out.push(p.fileHashes ? { ...spec, fileHashes: p.fileHashes } : spec);
  }
  return out;
}
