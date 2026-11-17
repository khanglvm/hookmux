// `hookmux new <id>`: scaffold a commented plugin.toml and a tests.toml that
// pass `hookmux test` as written, so authors start from something that works.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CANONICAL_EVENTS, type CanonicalEvent } from "../core/types.ts";
import { PLUGIN_ID } from "../load/manifest.ts";
import { VERSION } from "../version.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { detail, say } from "./lib/output.ts";
import { validatePlugin } from "./validate.ts";

export const usage = `Usage: hookmux new <id> [--dir <path>] [--event <event>]

Creates <dir>/<id>/ with plugin.toml and tests.toml.

  --dir <path>     parent folder (default: the current folder)
  --event <event>  ${CANONICAL_EVENTS.join(", ")} (default prompt.submit)`;

/** Prompt plugins match the prompt; other events have no prompt, so the scaffold matches the working folder. */
function checkBlock(event: CanonicalEvent): string {
  if (event === "prompt.submit") {
    return `[checks.mentions_topic]
kind = "keywords"
words = ["example topic", "another phrase"]`;
  }
  return `# ${event} has no prompt, so this example matches the working folder.
# For tool events, field = "tool.name" or "tool.input.<key>" reads the tool call.
[checks.mentions_topic]
kind = "keywords"
words = ["example-project"]
field = "cwd"`;
}

export function manifestTemplate(id: string, event: CanonicalEvent): string {
  const prompt = event === "prompt.submit";
  return `# ${id}: say in a line or two what this plugin adds and when.
# Every key, check kind and effect: run 'hookmux schema'.
schema = 1
id = "${id}"
version = "0.1.0"
description = "One line on what this plugin does."
requires_hookmux = ">=${VERSION}"
events = ["${event}"]
# guard, route, enrich or observe; lower priority runs first within a phase.
phase = "${prompt ? "route" : "enrich"}"
${prompt ? "" : '# Only prompts have a user or system origin; other events arrive as "unknown".\norigins = ["unknown"]\n'}# "session" fires at most once per session; "none" fires on every match.
dedupe = "session"
# Boolean expression over the checks below, with and, or, not and parentheses.
when = "mentions_topic"

${checkBlock(event)}

# inject adds text to the agent's context; block and notify are the other effects.
[[then]]
effect = "inject"
text = "Replace this with the guidance the agent should see."
`;
}

export function testsTemplate(id: string, event: CanonicalEvent): string {
  const head = `# Cases for 'hookmux test ${id}'. expect is "fire" or "silent".
# Optional per case: host (default claude-code), event, cwd.`;
  if (event === "prompt.submit") {
    return `${head}
[[case]]
prompt = "tell me about the example topic"
expect = "fire"

[[case]]
prompt = "rename this variable"
expect = "silent"
`;
  }
  return `${head}
[[case]]
event = "${event}"
cwd = "/work/example-project"
expect = "fire"

[[case]]
event = "${event}"
cwd = "/work/other"
expect = "silent"
`;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { dir: { type: "string" }, event: { type: "string" } }, usage, 1);
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the new plugin, e.g. hookmux new my-plugin");
  if (!PLUGIN_ID.test(id)) throw new UsageError(`'${id}' is not a valid id: use lowercase letters, digits and dashes`);
  const event = (parsed.values.event ?? "prompt.submit") as CanonicalEvent;
  if (!CANONICAL_EVENTS.includes(event)) throw new UsageError(`unknown event '${event}'`);
  const dir = join(resolve(parsed.values.dir ?? "."), id);
  if (existsSync(dir)) {
    say("fail", `${dir} already exists`, `pick another id or --dir`);
    return 1;
  }
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(join(dir, "plugin.toml"), manifestTemplate(id, event), { mode: 0o644 });
  writeFileSync(join(dir, "tests.toml"), testsTemplate(id, event), { mode: 0o644 });
  const report = validatePlugin(dir);
  if (!report.ok) {
    say("fail", `scaffold does not validate: ${report.problems.join("; ")}`, "report this as a hookmux bug");
    return 1;
  }
  say("ok", `created ${dir}`);
  detail(`edit plugin.toml and tests.toml, then: hookmux test ${dir}`);
  detail(`install it: hookmux add ${dir}`);
  return 0;
}
