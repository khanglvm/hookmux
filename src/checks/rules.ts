// Pattern checks: regex, keywords and regex_groups. All tier 0, all rule-backed.

import type { CheckSpec, Signal } from "../core/types.ts";
import { registerCheck } from "./registry.ts";
import { clip, compilePatterns, isKnownField, readField, regexFlags } from "./text.ts";

function fieldProblems(spec: CheckSpec): string[] {
  return isKnownField(spec.field) ? [] : [`field '${String(spec.field)}' is not a known event field`];
}

function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

function matchAll(patterns: RegExp[], text: string, mode: unknown): Signal {
  if (mode === "all") {
    const hits = patterns.map((re) => re.exec(text)?.[0] ?? null);
    const ok = hits.every((h) => h !== null);
    return ok ? { value: true, evidence: clip(hits.join(" ")) } : { value: false };
  }
  const hit = firstMatch(patterns, text);
  return hit === null ? { value: false } : { value: true, evidence: clip(hit) };
}

registerCheck({
  kind: "regex",
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems = fieldProblems(spec);
    compilePatterns(spec.patterns, regexFlags(spec.flags, problems), "patterns", problems);
    if (spec.match !== undefined && spec.match !== "any" && spec.match !== "all") {
      problems.push("match must be 'any' or 'all'");
    }
    return problems;
  },
  run(spec, ctx) {
    const text = readField(ctx.event, spec.field as string | undefined);
    if (text === null) return { value: false };
    const patterns = compilePatterns(spec.patterns, regexFlags(spec.flags, []), "patterns", []);
    return matchAll(patterns, text, spec.match);
  },
});

/** Escapes a literal word for use inside a RegExp. */
function escapeRegex(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function keywordPatterns(spec: CheckSpec, problems: string[]): RegExp[] {
  const words = spec.words;
  if (!Array.isArray(words) || words.length === 0 || words.some((w) => typeof w !== "string" || w === "")) {
    problems.push("words must be a non-empty list of strings");
    return [];
  }
  // Unicode-aware word edges, so Vietnamese and other non-ASCII words match whole.
  const wholeWord = spec.whole_word !== false;
  const sources = (words as string[]).map((w) =>
    wholeWord ? `(?<![\\p{L}\\p{N}_])${escapeRegex(w)}(?![\\p{L}\\p{N}_])` : escapeRegex(w),
  );
  const flags = spec.case_sensitive === true ? "u" : "iu";
  return compilePatterns(sources, flags, "words", problems);
}

registerCheck({
  kind: "keywords",
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems = fieldProblems(spec);
    keywordPatterns(spec, problems);
    return problems;
  },
  run(spec, ctx) {
    const text = readField(ctx.event, spec.field as string | undefined);
    if (text === null) return { value: false };
    return matchAll(keywordPatterns(spec, []), text, spec.match);
  },
});

/**
 * Named groups of patterns plus combinations that fire. The check is true when
 * every group of at least one combination matches. This is the autotrigger model.
 */
registerCheck({
  kind: "regex_groups",
  tier: 0,
  output: "bool",
  modelBacked: false,
  validate(spec) {
    const problems = fieldProblems(spec);
    const groups = spec.groups;
    if (groups === null || typeof groups !== "object" || Array.isArray(groups)) {
      return [...problems, "groups must be a table of pattern lists"];
    }
    const flags = regexFlags(spec.flags, problems);
    for (const [name, patterns] of Object.entries(groups)) compilePatterns(patterns, flags, `groups.${name}`, problems);
    const combos = spec.fire_when;
    if (!Array.isArray(combos) || combos.length === 0) {
      problems.push("fire_when must be a non-empty list of group-name lists");
    } else {
      for (const combo of combos) {
        if (!Array.isArray(combo) || combo.length === 0) {
          problems.push("each fire_when entry must be a non-empty list");
          continue;
        }
        for (const name of combo) {
          if (typeof name !== "string" || !(name in groups)) problems.push(`fire_when names unknown group '${name}'`);
        }
      }
    }
    return problems;
  },
  run(spec, ctx) {
    const text = readField(ctx.event, spec.field as string | undefined);
    if (text === null) return { value: false };
    const flags = regexFlags(spec.flags, []);
    const hits = new Map<string, string>();
    for (const [name, patterns] of Object.entries(spec.groups as Record<string, unknown>)) {
      const hit = firstMatch(compilePatterns(patterns, flags, name, []), text);
      if (hit !== null) hits.set(name, hit);
    }
    for (const combo of spec.fire_when as string[][]) {
      if (combo.every((name) => hits.has(name))) {
        return { value: true, evidence: clip(combo.map((name) => hits.get(name)).join(" + ")) };
      }
    }
    return { value: false };
  },
});
