// opencode adapter, written against opencode-ai 1.19.6 (npm `latest`, tag
// v1.19.6, commit f4e363c). opencode has no command hooks: it loads JS plugins
// from its global plugin folder, so hookmux installs a generated shim there
// (launcher/opencode-plugin.js) instead of writing a hub entry into a host
// config. That shim speaks hookmux's own payload and answer shapes over the
// launcher's stdin/stdout, built from packages/opencode/src/plugin/index.ts,
// packages/opencode/src/session/prompt.ts and packages/opencode/src/session/
// tools.ts in a local v1.19.6 clone (paths below are relative to that repo).

import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinContext } from "../core/compose.ts";
import { cells, type FeatureTable } from "../core/features.ts";
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  type EffectKind,
  type HookEvent,
  type HubResult,
} from "../core/types.ts";
import { packageLayout } from "../install/package.ts";
import { writeFileAtomic } from "../runtime/fsutil.ts";
import { type HostIdentity, parseHostPayload } from "./event.ts";
import { ConfigEditError } from "./json-config.ts";
import type { ConfigChange, HostAdapter, HostConfigEditor, HubEntry } from "./types.ts";

const ID = "opencode";

/**
 * opencode's own hook names. `session.start` has no dedicated hook: the shim
 * uses the generic `event` hook and reacts to `session.created`
 * (plugin/index.ts:250-260; session/session.ts parentID marks a subagent).
 */
const NATIVE: Record<CanonicalEvent, string | null> = {
  "prompt.submit": "chat.message",
  "session.start": "event",
  "tool.before": "tool.execute.before",
  "tool.after": "tool.execute.after",
};

/**
 * `chat.message` has no documented block field (session/prompt.ts:999-1008),
 * so a plugin can only add context or notify there. `event` has no `output`
 * (plugin/src/index.ts Hooks type), so the shim holds any inject and delivers
 * it as a synthetic part on that session's first `chat.message`.
 * `tool.execute.before` denies by throwing (the documented `.env` example in
 * plugins.mdx) but never reads `output.args` for context from hookmux's side.
 * `tool.execute.after` returns `output.output` verbatim, so added context is
 * appended to it; throwing there is undocumented, so hookmux offers no block.
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["block", "notify"],
  "tool.after": ["inject", "notify"],
};

/** No cap is documented for the shim's own context string; kept at the other hosts' budget. */
const CONTEXT_CHARS = 10_000;

/** Built-in tool ids (shell/id.ts, write.ts, edit.ts, read.ts, apply_patch.ts). Others pass through. */
const CANONICAL_TOOLS: Readonly<Record<string, string>> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  apply_patch: "Edit",
};

/**
 * Feature facts, from the same v1.19.6 sources:
 * - host.version: the shim's payload carries no client version.
 * - prompt.origin: the shim marks prompts in sessions created with a parentID
 *   (subagents, session/session.ts) as "system".
 * - tool.file-path: write, edit and read take filePath, which the adapter copies to
 *   file_path; apply_patch carries only patchText (tool/apply_patch.ts).
 * - block.prevents, block.reason-to-agent: the throw in tool.execute.before runs before
 *   item.execute (session/tools.ts). In a live run of opencode 1.19.6 the blocked command
 *   did not run and the model received the block reason as the tool result.
 * Everything else stays unknown until a run against the real client settles it.
 */
const HOST_FEATURES: FeatureTable = {
  "host.version": cells(false, ...CANONICAL_EVENTS),
  "prompt.origin": cells(true, "prompt.submit"),
  "tool.file-path": cells(false, "tool.before", "tool.after"),
  "inject.markup": cells(null, "prompt.submit", "session.start", "tool.after"),
  "inject.inline": cells(null, "prompt.submit", "session.start", "tool.after"),
  "inject.before-call": {},
  "block.prevents": cells(true, "tool.before"),
  "block.reason-to-agent": cells(true, "tool.before"),
  "block.suppress-prompt": {},
};

const FEATURE_NOTES: HostAdapter["featureNotes"] = {
  "tool.file-path": "apply_patch edits carry patch text, not a file path.",
};

/**
 * The shim tracks `parentID` on `session.created` (session/session.ts) and
 * sends it as `origin` on every prompt in that session; a payload missing it
 * (an older shim, or a hand-built sample) falls back to the usual default.
 */
function originOf(payload: Record<string, unknown>, prompt: string | undefined): "user" | "system" | "unknown" {
  if (payload.origin === "system" || payload.origin === "user") return payload.origin;
  return prompt === undefined ? "unknown" : "user";
}

/** Copies `filePath` to `file_path` on the canonical tool input; `raw` keeps the shim's own field names. */
function withFilePath(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (typeof record.filePath !== "string" || "file_path" in record) return input;
  return { ...record, file_path: record.filePath };
}

const HOST: HostIdentity = {
  id: ID,
  name: "opencode",
  nativeEvents: NATIVE,
  supports: SUPPORTS,
  contextChars: CONTEXT_CHARS,
  features: HOST_FEATURES,
  featureNotes: FEATURE_NOTES,
};

/** The answer shape the shim applies: a plain object with only what the event supports, or "". */
function renderOpencode(result: HubResult, event: HookEvent): string {
  const supports = SUPPORTS[event.name];
  const out: Record<string, string> = {};
  if (result.notices.length > 0 && supports.includes("notify"))
    out.notice = result.notices.map((n) => n.text).join("\n");
  const context = joinContext(result);
  if (result.block && supports.includes("block")) out.block = result.block.reason;
  else if (context && supports.includes("inject")) out.context = context;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

function sampleFor(event: CanonicalEvent, prompt: string): Record<string, unknown> {
  const base = { session_id: "hookmux-doctor", cwd: process.cwd(), hook_event_name: NATIVE[event] };
  if (event === "prompt.submit") return { ...base, prompt, origin: "user" };
  if (event === "session.start") return base;
  const tool = { ...base, tool_name: "bash", tool_input: { command: "echo ok" } };
  return event === "tool.before" ? tool : { ...tool, tool_response: "ok\n" };
}

/**
 * First line of every file hookmux writes at `config.file()`; must match
 * `launcher/opencode-plugin.js`'s own first line exactly, since `readMeta`
 * below only trusts a file that starts with it.
 */
const MARKER = "// hookmux generated this opencode plugin; `hookmux sync` rewrites it.";
const LAUNCHER_LINE = /^const LAUNCHER = (".*");$/m;
const EVENTS_LINE = /^const EVENTS = (\[.*\]);$/m;

interface PluginMeta {
  launcher: string;
  events: CanonicalEvent[];
}

/** Reads back what a hookmux-written plugin file declares, or null when it is not one. */
function readMeta(file: string): PluginMeta | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  if (!text.startsWith(MARKER)) return null;
  const launcher = LAUNCHER_LINE.exec(text)?.[1];
  const events = EVENTS_LINE.exec(text)?.[1];
  if (launcher === undefined || events === undefined) return null;
  try {
    return { launcher: JSON.parse(launcher) as string, events: JSON.parse(events) as CanonicalEvent[] };
  } catch {
    // A damaged file hookmux wrote: still ours, so install rewrites it, but it names no
    // launcher, so uninstall leaves it and installed() reports no events.
    return { launcher: "", events: [] };
  }
}

/** `$XDG_CONFIG_HOME` is read transparently by opencode's `xdg-basedir`; `$OPENCODE_CONFIG_DIR` only adds an extra dir and never replaces this one. */
function opencodeConfigDir(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "opencode");
}

/**
 * Fills in the template's placeholders. Each one sits inside a quoted string
 * in the checked-in file (`"@LAUNCHER_JSON@"`) so the file parses as plain JS
 * on its own; the quotes are replaced along with the token.
 */
function renderPlugin(template: string, launcher: string, events: CanonicalEvent[], timeoutSec: number): string {
  return template
    .replaceAll('"@LAUNCHER_JSON@"', () => JSON.stringify(launcher))
    .replaceAll('"@EVENTS_JSON@"', () => JSON.stringify(events))
    .replaceAll('"@TIMEOUT_MS@"', () => String(timeoutSec * 1000));
}

function opencodePluginEditor(): HostConfigEditor {
  const file = (env: NodeJS.ProcessEnv = process.env) => join(opencodeConfigDir(env), "plugins", "hookmux.js");
  return {
    file,
    detect: (env = process.env) => existsSync(opencodeConfigDir(env)),
    installed(launcher, env = process.env) {
      const meta = readMeta(file(env));
      return meta && meta.launcher === launcher ? meta.events : [];
    },
    install(entry: HubEntry, env = process.env) {
      const target = file(env);
      const change: ConfigChange = { file: target, changed: false, added: [], removed: [], notes: [] };
      const existing = readMeta(target);
      if (existing === null && existsSync(target)) {
        throw new ConfigEditError(
          `${target} exists and was not written by hookmux; move it aside before installing here`,
        );
      }
      // With no events this is doctor's probe, which only validates: it must not write.
      if (entry.events.length === 0) return change;
      const already = existing?.launcher === entry.launcher ? existing.events : [];
      const added = CANONICAL_EVENTS.filter((e) => entry.events.includes(e) && !already.includes(e));
      const union = CANONICAL_EVENTS.filter((e) => already.includes(e) || added.includes(e));
      const templateFile = join(packageLayout().root, "launcher", "opencode-plugin.js");
      const text = renderPlugin(readFileSync(templateFile, "utf8"), entry.launcher, union, entry.timeoutSec);
      // The shim's logic lives in this file, not behind the launcher, so a newer
      // template or a changed timeout is written even when no event is added.
      if (existing !== null && readFileSync(target, "utf8") === text) return change;
      writeFileAtomic(target, text);
      change.changed = true;
      change.added = added;
      return change;
    },
    uninstall(launcher, env = process.env) {
      const target = file(env);
      const change: ConfigChange = { file: target, changed: false, added: [], removed: [], notes: [] };
      const meta = readMeta(target);
      if (!meta || meta.launcher !== launcher) return change;
      rmSync(target, { force: true });
      change.changed = true;
      change.removed = meta.events;
      return change;
    },
  };
}

export const opencode: HostAdapter = {
  ...HOST,
  contractVersion: 1,

  // Neither the hook env nor the shim's payload carries a version (§6 of the
  // research pass), so version stays null.
  parse(event, payload) {
    const parsed = parseHostPayload(HOST, event, payload, {
      promptOrigin: originOf,
      canonicalTool: (name) => CANONICAL_TOOLS[name] ?? name,
    });
    if (parsed?.tool) parsed.tool.input = withFilePath(parsed.tool.input);
    return parsed;
  },

  render: renderOpencode,
  sample: (event, prompt = "hookmux doctor check") => sampleFor(event, prompt),
  config: opencodePluginEditor(),
  // opencode loads skills only from sources a config file declares (core/src/skill.ts,
  // core/src/config/v2-compat.ts:155-160), not from a scanned folder under its config
  // dir, so hookmux has nowhere to point its skill at yet.
};
