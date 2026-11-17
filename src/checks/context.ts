// Context checks that read the event itself rather than its text: host, origin,
// tool, cwd_glob and path_exists. All tier 0 and rule-backed.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { CheckSpec } from "../core/types.ts";
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

registerCheck({
  kind: "host",
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems: string[] = [];
    if (spec.id === undefined && spec.version === undefined && spec.supports === undefined) {
      problems.push("host check needs at least one of id, version, supports");
    }
    requireList(spec, "id", problems, true);
    requireList(spec, "supports", problems, true);
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
    if (spec.id !== undefined && !(spec.id as string[]).includes(host.id)) return { value: false };
    if (spec.supports !== undefined && !(spec.supports as string[]).every((e) => host.supports.includes(e as never))) {
      return { value: false };
    }
    if (spec.version !== undefined) {
      // An unknown host version leaves the check unknown instead of guessing.
      if (host.version === null) return { value: null };
      return { value: satisfiesRange(host.version, spec.version as string) };
    }
    return { value: true };
  },
});

registerCheck({
  kind: "origin",
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
