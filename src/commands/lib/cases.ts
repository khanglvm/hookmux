// Reads a plugin's tests.toml: a list of [[case]] tables, each a prompt (or
// other event input) and whether the plugin should fire. Pure apart from parsing,
// so problems are returned, never thrown.

import { parse as parseToml } from "smol-toml";
import { CANONICAL_EVENTS, type CanonicalEvent } from "../../core/types.ts";
import { DEFAULT_HOST } from "./run.ts";

export const TESTS_FILE = "tests.toml";

export interface TestCase {
  prompt: string;
  expect: "fire" | "silent";
  host: string;
  event: CanonicalEvent;
  cwd?: string;
}

/** Field docs for `hookmux schema` and the authoring skill. */
export const CASE_FIELDS: Record<string, string> = {
  prompt: "prompt text (required for prompt.submit)",
  expect: '"fire" or "silent"',
  host: `host id, default "${DEFAULT_HOST}"`,
  event: 'canonical event, default "prompt.submit"',
  cwd: "working folder the event reports, default the current folder",
};

export function parseCases(text: string, knownHosts: string[]): { cases: TestCase[]; problems: string[] } {
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    return { cases: [], problems: [`invalid TOML: ${(error as Error).message}`] };
  }
  const list = raw.case;
  if (!Array.isArray(list) || list.length === 0) return { cases: [], problems: ["needs at least one [[case]]"] };
  const cases: TestCase[] = [];
  const problems: string[] = [];
  list.forEach((entry, i) => {
    const result = readCase(entry, knownHosts);
    if (typeof result === "string") problems.push(`case ${i + 1}: ${result}`);
    else cases.push(result);
  });
  return { cases, problems };
}

/** One case, or the reason it is invalid. */
function readCase(entry: unknown, knownHosts: string[]): TestCase | string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return "must be a table";
  const c = entry as Record<string, unknown>;
  const event = c.event ?? "prompt.submit";
  if (typeof event !== "string" || !CANONICAL_EVENTS.includes(event as CanonicalEvent)) {
    return `unknown event '${String(event)}'`;
  }
  if (c.expect !== "fire" && c.expect !== "silent") return 'expect must be "fire" or "silent"';
  if (c.prompt !== undefined && typeof c.prompt !== "string") return "prompt must be a string";
  if (event === "prompt.submit" && typeof c.prompt !== "string") return "prompt.submit cases need a prompt";
  const host = c.host ?? DEFAULT_HOST;
  if (typeof host !== "string" || !knownHosts.includes(host)) return `unknown host '${String(host)}'`;
  if (c.cwd !== undefined && typeof c.cwd !== "string") return "cwd must be a string";
  return {
    prompt: (c.prompt as string | undefined) ?? "",
    expect: c.expect,
    host,
    event: event as CanonicalEvent,
    ...(c.cwd !== undefined ? { cwd: c.cwd as string } : {}),
  };
}
