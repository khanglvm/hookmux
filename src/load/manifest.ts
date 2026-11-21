// Reads a plugin.toml, merges the per-host tables and user overrides, and
// validates the result into PluginSpec values. Runs at compile time only
// (add, promote, or when the hook finds the registry stale), never per check.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getCheck } from "../checks/registry.ts";
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  type CheckSpec,
  type EffectKind,
  type EffectSpec,
  type Fallback,
  type Origin,
  PHASES,
  type Phase,
  PLUGIN_ID,
  type PluginSpec,
} from "../core/types.ts";
import { evalExprShape } from "./shape.ts";

export const MANIFEST_FILE = "plugin.toml";
export const MANIFEST_SCHEMA = 1;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 4000;

export { PLUGIN_ID };

const ORIGINS: readonly Origin[] = ["user", "system", "unknown"];
export const ON_ERROR_PROBLEM = "hookmux always fails open; remove on_error";

/** Top-level manifest keys; `hookmux schema` documents each one. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "schema",
  "id",
  "version",
  "description",
  "events",
  "hosts",
  "phase",
  "priority",
  "enabled",
  "shadow",
  "origins",
  "dedupe",
  "exclusive",
  "on_error",
  "when",
  "when_degraded",
  "params",
  "checks",
  "then",
  "host",
  "requires_hookmux",
]);

export type RawManifest = Record<string, unknown>;

export interface LoadDefaults {
  /** Origins for non-guard plugins that do not set `origins`. */
  routeOrigins: Origin[];
  /** Host ids this engine has adapters for; other `[host.<id>]` tables are ignored with a warning. */
  knownHosts: string[];
}

export interface CompiledPlugin {
  base: PluginSpec;
  /** Specs for hosts whose `[host.<id>]` table changes something. */
  variants: Record<string, PluginSpec>;
  warnings: string[];
}

export class ManifestError extends Error {
  readonly file: string;
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.join("; ")}`);
    this.file = file;
    this.problems = problems;
  }
}

/** Reads and parses a manifest file, refusing oversized or group/world-writable files. */
export function readManifest(dir: string): RawManifest {
  return readManifestText(dir, () => readFileSync(join(dir, MANIFEST_FILE), "utf8"));
}

/**
 * Parses manifest text the caller already read, after the same size, mode and
 * owner checks as readManifest, so the registry can hash and parse one set of bytes.
 * `text` is a string or a reader called only once the checks pass.
 */
export function readManifestText(dir: string, text: string | (() => string)): RawManifest {
  const file = join(dir, MANIFEST_FILE);
  const stat = statSync(file);
  if (stat.size > MAX_MANIFEST_BYTES) throw new ManifestError(file, [`larger than ${MAX_MANIFEST_BYTES} bytes`]);
  if (process.platform !== "win32") {
    if ((stat.mode & 0o022) !== 0) throw new ManifestError(file, ["writable by group or others; run chmod go-w"]);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ManifestError(file, ["not owned by the current user"]);
    }
  }
  const source = typeof text === "string" ? text : text();
  if (Buffer.byteLength(source) > MAX_MANIFEST_BYTES) {
    throw new ManifestError(file, [`larger than ${MAX_MANIFEST_BYTES} bytes`]);
  }
  try {
    return parseToml(source) as RawManifest;
  } catch (error) {
    throw new ManifestError(file, [`invalid TOML: ${(error as Error).message}`]);
  }
}

/** Deep-merges plain tables; arrays and scalars in `top` replace those in `base`. */
export function mergeTables(base: RawManifest, top: RawManifest | undefined): RawManifest {
  if (!top) return base;
  const out: RawManifest = { ...base };
  for (const [key, value] of Object.entries(top)) {
    const current = out[key];
    out[key] = isTable(current) && isTable(value) ? mergeTables(current, value) : value;
  }
  return out;
}

function isTable(value: unknown): value is RawManifest {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Validates a manifest with the user's override applied.
 * Merge order, lowest first: plugin, plugin `[host.<id>]`, user override, user override `[host.<id>]`.
 */
export function compileManifest(
  raw: RawManifest,
  dir: string,
  override: RawManifest | undefined,
  defaults: LoadDefaults,
): CompiledPlugin {
  const file = join(dir, MANIFEST_FILE);
  const warnings: string[] = [];
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key '${key}' ignored`);
  if (raw.schema !== MANIFEST_SCHEMA) throw new ManifestError(file, [`schema must be ${MANIFEST_SCHEMA}`]);

  const pluginHosts = isTable(raw.host) ? raw.host : {};
  const overrideHosts = isTable(override?.host) ? override.host : {};
  const strip = (m: RawManifest | undefined) => {
    if (!m) return undefined;
    const { host: _host, ...rest } = m;
    return rest;
  };
  const baseRaw = mergeTables(strip(raw) as RawManifest, strip(override));
  const base = toSpec(baseRaw, dir, defaults, file);

  const variants: Record<string, PluginSpec> = {};
  for (const hostId of new Set([...Object.keys(pluginHosts), ...Object.keys(overrideHosts)])) {
    if (!defaults.knownHosts.includes(hostId)) {
      warnings.push(`[host.${hostId}] ignored: no adapter for '${hostId}' in this version`);
      continue;
    }
    const layered = mergeTables(
      mergeTables(mergeTables(strip(raw) as RawManifest, asTable(pluginHosts[hostId])), strip(override)),
      asTable(overrideHosts[hostId]),
    );
    variants[hostId] = toSpec(layered, dir, defaults, `${file} [host.${hostId}]`);
  }
  return { base, variants, warnings };
}

function asTable(value: unknown): RawManifest | undefined {
  return isTable(value) ? value : undefined;
}

function toSpec(m: RawManifest, dir: string, defaults: LoadDefaults, where: string): PluginSpec {
  const problems: string[] = [];
  const str = (key: string, fallback?: string): string => {
    const v = m[key] ?? fallback;
    if (typeof v !== "string") {
      problems.push(`${key} must be a string`);
      return "";
    }
    return v;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const v = m[key] ?? fallback;
    if (typeof v !== "boolean") problems.push(`${key} must be true or false`);
    return v === true;
  };

  const id = str("id");
  if (id && !PLUGIN_ID.test(id)) problems.push("id must be lowercase letters, digits and dashes (max 64)");
  const phase = str("phase", "route") as Phase;
  if (!PHASES.includes(phase)) problems.push(`phase must be one of ${PHASES.join(", ")}`);
  const events = stringArray(m.events, "events", problems) as CanonicalEvent[];
  for (const e of events) if (!CANONICAL_EVENTS.includes(e)) problems.push(`unknown event '${e}'`);
  if (events.length === 0) problems.push("events must list at least one event");
  const priority = m.priority ?? 100;
  if (typeof priority !== "number" || !Number.isInteger(priority)) problems.push("priority must be an integer");
  const origins = (
    m.origins === undefined
      ? phase === "guard"
        ? [...ORIGINS]
        : defaults.routeOrigins
      : stringArray(m.origins, "origins", problems)
  ) as Origin[];
  for (const o of origins) if (!ORIGINS.includes(o)) problems.push(`unknown origin '${o}'`);
  const dedupe = str("dedupe", "none");
  if (dedupe !== "none" && dedupe !== "session") problems.push("dedupe must be 'none' or 'session'");
  // Product rule: an error never blocks the agent, so "open" is the only accepted value
  // and it changes nothing. Older manifests that say "block" must drop the key.
  if (m.on_error !== undefined && m.on_error !== "open") problems.push(ON_ERROR_PROBLEM);

  const checks = readChecks(m.checks, problems);
  const when = str("when");
  const whenDegraded = m.when_degraded === undefined ? undefined : str("when_degraded");
  for (const [label, source] of [
    ["when", when],
    ["when_degraded", whenDegraded],
  ] as const) {
    if (source !== undefined && source !== "") problems.push(...evalExprShape(label, source, checks));
  }
  const effects = readEffects(m.then, problems);
  const params = readParams(m.params, problems);

  if (problems.length > 0) throw new ManifestError(where, problems);
  return {
    id,
    version: typeof m.version === "string" ? m.version : "0.0.0",
    description: typeof m.description === "string" ? m.description : "",
    dir,
    events,
    hosts: m.hosts === undefined ? [] : stringArray(m.hosts, "hosts", []),
    phase,
    priority: priority as number,
    enabled: bool("enabled", true),
    shadow: bool("shadow", false),
    origins,
    checks,
    when,
    ...(whenDegraded ? { whenDegraded } : {}),
    effects,
    dedupe: dedupe as PluginSpec["dedupe"],
    ...(typeof m.exclusive === "string" ? { exclusive: m.exclusive } : {}),
    params,
  };
}

function stringArray(value: unknown, label: string, problems: string[]): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    problems.push(`${label} must be a list of strings`);
    return [];
  }
  return value as string[];
}

function readChecks(value: unknown, problems: string[]): Record<string, CheckSpec> {
  if (value === undefined) return {};
  if (!isTable(value)) {
    problems.push("checks must be a table");
    return {};
  }
  const out: Record<string, CheckSpec> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) problems.push(`check name '${name}' must be lowercase snake_case`);
    if (!isTable(spec) || typeof spec.kind !== "string") {
      problems.push(`checks.${name} needs a kind`);
      continue;
    }
    const kind = getCheck(spec.kind);
    if (!kind) {
      problems.push(`checks.${name}: unknown kind '${spec.kind}'`);
      continue;
    }
    for (const p of kind.validate(spec as CheckSpec)) problems.push(`checks.${name}: ${p}`);
    out[name] = spec as CheckSpec;
  }
  return out;
}

function readEffects(value: unknown, problems: string[]): EffectSpec[] {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("needs at least one [[then]] effect");
    return [];
  }
  const out: EffectSpec[] = [];
  for (const [i, e] of value.entries()) {
    const at = `then[${i}]`;
    if (!isTable(e)) {
      problems.push(`${at} must be a table`);
      continue;
    }
    const text = e.effect === "block" ? e.reason : e.text;
    if (typeof text !== "string" || text.trim() === "") {
      problems.push(`${at} needs ${e.effect === "block" ? "reason" : "text"}`);
      continue;
    }
    if (text.length > MAX_TEXT_CHARS) problems.push(`${at} text longer than ${MAX_TEXT_CHARS} chars`);
    const fallback = e.fallback === undefined ? {} : { fallback: readFallback(e.fallback, e.effect, at, problems) };
    if (e.effect === "inject" || e.effect === "notify") out.push({ effect: e.effect, text, ...fallback });
    else if (e.effect === "block") {
      out.push({
        effect: "block",
        reason: text,
        suppressOriginalPrompt: e.suppress_original_prompt === true,
        ...fallback,
      });
    } else problems.push(`${at}: unknown effect '${String(e.effect)}'`);
  }
  return out;
}

const FALLBACK_KINDS: readonly string[] = ["inject", "notify"];

/**
 * A fallback lists the effects to try where the host cannot perform this one.
 * Only inject and notify are allowed, so a fallback can never add a block, and
 * an effect never lists itself or repeats an entry.
 */
function readFallback(value: unknown, own: unknown, at: string, problems: string[]): Fallback {
  if (!Array.isArray(value)) {
    problems.push(`${at}.fallback must be a list such as ["inject", "notify"]`);
    return [];
  }
  const out: Fallback = [];
  for (const item of value) {
    if (item === "block") problems.push(`${at}.fallback cannot contain 'block': a fallback never adds a block`);
    else if (typeof item !== "string" || !FALLBACK_KINDS.includes(item)) {
      problems.push(`${at}.fallback: unknown effect '${String(item)}' (use inject or notify)`);
    } else if (item === (own as EffectKind)) problems.push(`${at}.fallback lists the effect's own kind '${item}'`);
    else if (out.includes(item as Fallback[number])) problems.push(`${at}.fallback lists '${item}' twice`);
    else out.push(item as Fallback[number]);
  }
  return out;
}

function readParams(value: unknown, problems: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!isTable(value)) {
    problems.push("params must be a table");
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else problems.push(`params.${k} must be a string, number or boolean`);
  }
  return out;
}
