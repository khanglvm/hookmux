// Context checks that read the event itself rather than its text: host, origin,
// tool, cwd_glob and path_exists. All tier 0 and rule-backed.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type FeatureId, isFeatureId } from "../core/features.ts";
import type { CheckSpec, Tri } from "../core/types.ts";
import { registerCheck } from "./registry.ts";

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v !== "");
}

function requireList(spec: CheckSpec, key: string, problems: string[], optional = false): void {
  if (optional && spec[key] === undefined) return;
  if (!stringList(spec[key])) problems.push(`${key} must be a non-empty list of strings`);
}

/** Compares dotted numeric versions; "1.10" > "1.9". Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

const VERSION_RANGE = /^(<=|>=|<|>|=)?\s*(\d+(?:\.\d+)*)$/;

/** Space-separated constraints, all of which must hold: ">=0.40 <1". */
export function satisfiesRange(version: string, range: string): boolean {
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const m = VERSION_RANGE.exec(part);
      if (!m) return false;
      const cmp = compareVersions(version, m[2] as string);
      switch (m[1] ?? "=") {
        case "<":
          return cmp < 0;
        case "<=":
          return cmp <= 0;
        case ">":
          return cmp > 0;
        case ">=":
          return cmp >= 0;
        default:
          return cmp === 0;
      }
    });
}

/** Three-valued AND: one false decides, otherwise one unknown leaves it unknown. */
function allOf(parts: Tri[]): Tri {
  if (parts.includes(false)) return false;
  return parts.includes(null) ? null : true;
}

/** Unknown feature ids are rejected so a typo cannot read as "unknown on every host". */
function featureProblems(spec: CheckSpec, key: "features" | "lacks", problems: string[]): void {
  requireList(spec, key, problems, true);
  if (!stringList(spec[key])) return;
  for (const id of spec[key] as string[]) if (!isFeatureId(id)) problems.push(`${key}: unknown feature '${id}'`);
}

/** The feature ids named in both `features` and `lacks`, which no host can satisfy. */
function contradictions(spec: CheckSpec): string[] {
  if (!stringList(spec.features) || !stringList(spec.lacks)) return [];
  return spec.features.filter((id) => (spec.lacks as string[]).includes(id));
}

registerCheck({
  kind: "host",
  summary:
    "True when the agent client matches: its id, a version range, the effects it supports on this event, or the features it has (features) or lacks (lacks). Unknown version or feature gives unknown.",
  options: {
    id: `list of host ids, e.g. ["codex"]`,
    version: `range such as ">=0.40" or ">=1.2 <2"`,
    supports: "list of effects that must be supported here",
    features: `list of feature ids that must all be yes here, e.g. ["inject.markup"]; unknown gives unknown`,
    lacks: `list of feature ids that must all be no here, e.g. ["block.prevents"]; unknown gives unknown`,
  },
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems: string[] = [];
    const keys = ["id", "version", "supports", "features", "lacks"] as const;
    if (keys.every((k) => spec[k] === undefined)) {
      problems.push(`host check needs at least one of ${keys.join(", ")}`);
    }
    requireList(spec, "id", problems, true);
    requireList(spec, "supports", problems, true);
    featureProblems(spec, "features", problems);
    featureProblems(spec, "lacks", problems);
    for (const id of contradictions(spec)) problems.push(`${id} is in both features and lacks`);
    if (spec.version !== undefined) {
      const ok =
        typeof spec.version === "string" &&
        spec.version
          .trim()
          .split(/\s+/)
          .every((p) => VERSION_RANGE.test(p));
      if (!ok) problems.push("version must be a range like '>=0.40' or '>=1.2 <2'");
    }
    return problems;
  },
  run(spec, ctx) {
    const host = ctx.event.host;
    const parts: Tri[] = [];
    if (spec.id !== undefined) parts.push((spec.id as string[]).includes(host.id));
    if (spec.supports !== undefined) {
      parts.push((spec.supports as string[]).every((e) => host.supports.includes(e as never)));
    }
    // An unknown host version leaves the check unknown instead of guessing.
    if (spec.version !== undefined) {
      parts.push(host.version === null ? null : satisfiesRange(host.version, spec.version as string));
    }
    // A feature the event has no value for reads as unknown, like an undeclared one.
    const fact = (id: string): Tri => host.features[id as FeatureId] ?? null;
    for (const id of (spec.features as string[] | undefined) ?? []) parts.push(fact(id));
    for (const id of (spec.lacks as string[] | undefined) ?? []) {
      const value = fact(id);
      parts.push(value === null ? null : !value);
    }
    return { value: allOf(parts) };
  },
});

registerCheck({
  kind: "origin",
  summary: "True when the prompt origin is one of the listed values.",
  options: { is: `list of "user", "system", "unknown"` },
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems: string[] = [];
    requireList(spec, "is", problems);
    return problems;
  },
  run(spec, ctx) {
    return { value: (spec.is as string[]).includes(ctx.event.origin) };
  },
});

registerCheck({
  kind: "tool",
  summary: "True when the tool call names one of these tools (canonical or host name).",
  options: { names: `list such as ["Bash", "Write"]` },
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems: string[] = [];
    requireList(spec, "names", problems);
    return problems;
  },
  run(spec, ctx) {
    const tool = ctx.event.tool;
    if (!tool) return { value: false };
    const names = spec.names as string[];
    return { value: names.includes(tool.canonicalName) || names.includes(tool.name), evidence: tool.canonicalName };
  },
});

/** Converts a glob (`*`, `**`, `?`) into an anchored RegExp over "/"-separated paths. */
export function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function expandHome(pattern: string): string {
  return pattern.startsWith("~/") ? `${process.env.HOME ?? ""}${pattern.slice(1)}` : pattern;
}

registerCheck({
  kind: "cwd_glob",
  summary: "True when the working folder matches one of the globs.",
  options: { patterns: "globs with *, ** and ?; ~/ expands to home" },
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems: string[] = [];
    requireList(spec, "patterns", problems);
    return problems;
  },
  run(spec, ctx) {
    const cwd = ctx.event.cwd.replaceAll("\\", "/");
    const hit = (spec.patterns as string[]).find((p) => globToRegex(expandHome(p)).test(cwd));
    return hit ? { value: true, evidence: hit } : { value: false };
  },
});

registerCheck({
  kind: "path_exists",
  summary: "True when any (or all) paths exist, relative to the working folder.",
  options: { paths: "list of paths", match: `"any" (default) or "all"` },
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems: string[] = [];
    requireList(spec, "paths", problems);
    if (spec.match !== undefined && spec.match !== "any" && spec.match !== "all") {
      problems.push("match must be 'any' or 'all'");
    }
    return problems;
  },
  run(spec, ctx) {
    const paths = (spec.paths as string[]).map((p) => {
      const expanded = expandHome(p);
      return isAbsolute(expanded) ? expanded : resolve(ctx.event.cwd, expanded);
    });
    const found = paths.filter((p) => existsSync(p));
    const ok = spec.match === "all" ? found.length === paths.length : found.length > 0;
    return ok ? { value: true, evidence: found[0] ?? "" } : { value: false };
  },
});
