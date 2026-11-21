// The plugin scaffolds behind `hookmux new --template`: pure functions that
// return file contents, so the command only decides where to write them.

import type { CanonicalEvent } from "../../core/types.ts";
import { VERSION } from "../../version.ts";

export const TEMPLATES = ["prompt-context", "tool-guard", "session-note"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** The one event a template listens to; prompt-context takes any event. */
export const TEMPLATE_EVENT: Record<Exclude<TemplateName, "prompt-context">, CanonicalEvent> = {
  "tool-guard": "tool.before",
  "session-note": "session.start",
};

/** What each template does, in the words the generated repo README uses. */
export const TEMPLATE_SUMMARY: Record<TemplateName, string> = {
  "prompt-context": "adds guidance to the agent's context when a prompt mentions a topic",
  "tool-guard": "blocks a risky shell command before the agent runs it",
  "session-note": "gives the agent a short note, such as the current git branch, when a session starts",
};

export interface ScaffoldFile {
  /** Path inside the plugin folder. */
  path: string;
  content: string;
  /** File mode; scripts the plugin runs must be executable. */
  mode: number;
}

const FILE_MODE = 0o644;
const SCRIPT_MODE = 0o755;

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

function toolGuardManifest(id: string): string {
  return `# ${id}: blocks a risky shell command before the agent runs it.
# Every key, check kind and effect: run 'hookmux schema'.
schema = 1
id = "${id}"
version = "0.1.0"
description = "Blocks force pushes made through the shell tool."
requires_hookmux = ">=${VERSION}"
events = ["tool.before"]
# Plugins outside the guard phase run only on prompts the user typed, and tool events arrive with origin "unknown".
phase = "guard"
# Both must hold: a shell tool call whose command matches a risky pattern.
when = "is_shell and risky_command"

[checks.is_shell]
kind = "tool"
names = ["Bash"]

# Add the commands you want stopped. Use TOML literal strings ('...') for patterns.
[checks.risky_command]
kind = "regex"
field = "tool.input.command"
patterns = ['\\bgit\\s+push\\b.*\\s(--force|-f)(\\s|$)']

[[then]]
effect = "block"
reason = "Force pushes can overwrite other people's commits. Push without --force, or ask the user first."
`;
}

function toolGuardTests(id: string): string {
  return `# Cases for 'hookmux test ${id}'. expect is "fire" or "silent".
# On tool events, command sets the shell command the tool call carries.
[[case]]
event = "tool.before"
command = "git push --force origin main"
expect = "fire"

[[case]]
event = "tool.before"
command = "git status"
expect = "silent"
`;
}

function sessionNoteManifest(id: string): string {
  return `# ${id}: gives the agent a short note when a session starts.
# Every key, check kind and effect: run 'hookmux schema'.
schema = 1
id = "${id}"
version = "0.1.0"
description = "Tells the agent which git branch it is on when a session starts."
requires_hookmux = ">=${VERSION}"
events = ["session.start"]
# guard, route, enrich or observe; a note adds context, so it is an enrich plugin.
phase = "enrich"
# Only prompts have a user or system origin; session events arrive as "unknown".
origins = ["unknown"]
when = "has_note"

# note.sh runs in the agent's working folder. Exit 0 or print {"value": true, "evidence": "..."}
# to say yes; exit 1 for no. Evidence is quoted below as {evidence.has_note}.
[checks.has_note]
kind = "script"
command = "note.sh"

[[then]]
effect = "inject"
text = "You are on the git branch {evidence.has_note}."
`;
}

const NOTE_SCRIPT = `#!/bin/sh
# Prints the current git branch (or the short commit when HEAD is detached) as the note.
# Exits 1, so the plugin stays silent, outside a git checkout.
branch=$(git symbolic-ref --short -q HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null) || exit 1
# Quotes and backslashes would break the JSON below.
branch=$(printf '%s' "$branch" | tr -d '"\\\\')
[ -n "$branch" ] || exit 1
printf '{"value": true, "evidence": "%s"}\\n' "$branch"
`;

function sessionNoteTests(id: string): string {
  return `# Cases for 'hookmux test ${id} --run-scripts'. expect is "fire" or "silent".
# The first case runs note.sh in the folder you run the test from, so run it inside a git checkout.
[[case]]
event = "session.start"
expect = "fire"

# The root folder is not a git checkout.
[[case]]
event = "session.start"
cwd = "/"
expect = "silent"
`;
}

/** The files of one template, ready to write into <dir>/<id>/. */
export function scaffoldFiles(id: string, template: TemplateName, event: CanonicalEvent): ScaffoldFile[] {
  switch (template) {
    case "tool-guard":
      return [
        { path: "plugin.toml", content: toolGuardManifest(id), mode: FILE_MODE },
        { path: "tests.toml", content: toolGuardTests(id), mode: FILE_MODE },
      ];
    case "session-note":
      return [
        { path: "plugin.toml", content: sessionNoteManifest(id), mode: FILE_MODE },
        { path: "note.sh", content: NOTE_SCRIPT, mode: SCRIPT_MODE },
        { path: "tests.toml", content: sessionNoteTests(id), mode: FILE_MODE },
      ];
    case "prompt-context":
      return [
        { path: "plugin.toml", content: manifestTemplate(id, event), mode: FILE_MODE },
        { path: "tests.toml", content: testsTemplate(id, event), mode: FILE_MODE },
      ];
  }
}
