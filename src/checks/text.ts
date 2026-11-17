// Picks the text a pattern check reads from the event, and validates patterns.
// The text is capped before matching so a slow pattern cannot stall the hook on a
// huge prompt or tool payload (JavaScript regexes backtrack; there is no RE2 here).

import type { HookEvent } from "../core/types.ts";
import { hasNestedRepetition } from "./redos.ts";

/** Characters of input a pattern check sees. Longer input is cut, not rejected. */
export const MAX_MATCH_CHARS = 8000;
export const MAX_PATTERN_CHARS = 300;
export const MAX_PATTERNS = 200;

/**
 * Field paths a check can read: "prompt" (default), "cwd", "tool.name",
 * "tool.input" (the whole input as JSON) or "tool.input.<key>[.<key>...]".
 */
export function readField(event: HookEvent, field: string | undefined): string | null {
  const path = field ?? "prompt";
  let value: unknown;
  if (path === "prompt") value = event.prompt;
  else if (path === "cwd") value = event.cwd;
  else if (path === "tool.name") value = event.tool?.canonicalName;
  else if (path === "tool.input") value = event.tool?.input;
  else if (path.startsWith("tool.input.")) value = dig(event.tool?.input, path.slice("tool.input.".length).split("."));
  else return null;
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value : safeJson(value);
  return text.length > MAX_MATCH_CHARS ? text.slice(0, MAX_MATCH_CHARS) : text;
}

export function isKnownField(field: unknown): boolean {
  if (field === undefined) return true;
  if (typeof field !== "string") return false;
  return ["prompt", "cwd", "tool.name", "tool.input"].includes(field) || /^tool\.input(\.[A-Za-z0-9_-]+)+$/.test(field);
}

function dig(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Validates and compiles a list of regex sources; collects problems instead of throwing. */
export function compilePatterns(raw: unknown, flags: string, label: string, problems: string[]): RegExp[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push(`${label} must be a non-empty list of patterns`);
    return [];
  }
  if (raw.length > MAX_PATTERNS) problems.push(`${label} has more than ${MAX_PATTERNS} patterns`);
  const out: RegExp[] = [];
  for (const source of raw) {
    if (typeof source !== "string" || source.length === 0) {
      problems.push(`${label} contains a non-string or empty pattern`);
      continue;
    }
    if (source.length > MAX_PATTERN_CHARS) {
      problems.push(`${label} pattern longer than ${MAX_PATTERN_CHARS} chars`);
      continue;
    }
    // A heuristic for catastrophic backtracking; the launcher's watchdog is what
    // actually bounds a hook run that a slow pattern stalls.
    if (hasNestedRepetition(source)) {
      problems.push(
        `${label} pattern /${source}/ repeats a group that already repeats (like (a+)+), which can hang on some input; rewrite it without the nesting`,
      );
      continue;
    }
    try {
      out.push(new RegExp(source, flags));
    } catch (error) {
      problems.push(`${label} pattern /${source}/ is invalid: ${(error as Error).message}`);
    }
  }
  return out;
}

export function regexFlags(raw: unknown, problems: string[]): string {
  if (raw === undefined) return "iu";
  if (typeof raw !== "string" || !/^[imsu]*$/.test(raw)) {
    problems.push("flags may only contain i, m, s, u");
    return "iu";
  }
  return raw;
}

/** Shortens evidence so a template cannot pour a whole prompt into context. */
export function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
