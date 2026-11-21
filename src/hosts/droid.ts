// Factory Droid adapter, written from https://docs.factory.ai/reference/hooks-reference
// for Droid CLI 1.16.0. Droid takes Claude Code's hook contract with its own
// tool names, and reads user hooks from two files in ~/.factory: hooks.json,
// keyed directly by event, and the `hooks` key of settings.json. An event in
// hooks.json replaces the same event in settings.json, so hookmux adds each
// event to whichever file already defines it and never shadows a user hook.
// While hooks.json is absent Droid reads the legacy hooks/hooks.json instead,
// so hookmux never creates hooks.json next to a legacy file.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cells, type FeatureTable } from "../core/features.ts";
import { CANONICAL_EVENTS, type CanonicalEvent, type EffectKind } from "../core/types.ts";
import { CLAUDE_EVENTS, claudeLayout, claudeStyleAdapter } from "./claude-style.ts";
import { ConfigEditError, installEntries, installedEvents, readEventNames, uninstallEntries } from "./json-config.ts";
import type { ConfigChange, HostAdapter, HostConfigEditor, HubEntry } from "./types.ts";

/**
 * PreToolUse additionalContext "does not reach the model" ("PreToolUse control").
 * PostToolUse decision "block" sends the reason back after the tool ran, and
 * SessionStart cannot block ("Control by event"). systemMessage shows on every event.
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["block", "notify"],
  "tool.after": ["inject", "block", "notify"],
};

/**
 * Feature facts, from the hooks reference named at the top of this file.
 * - host.version: the documented payload has no version field.
 * - prompt.origin: nothing in a prompt payload marks its source.
 * - tool.file-path: ApplyPatch input has no file_path (CANONICAL_TOOLS).
 * - block.prevents: UserPromptSubmit and PreToolUse block first; PostToolUse "block" follows the tool.
 * - block.reason-to-agent: a PostToolUse block sends the reason to the agent ("Control by event").
 * - block.suppress-prompt: no such key; a blocked prompt is handed back unsent.
 * Unknown: markup and inline limits, and who sees a prompt or pre-call reason. PreToolUse cannot inject,
 * so inject.before-call is derived.
 */
const HOST_FEATURES: FeatureTable = {
  "host.version": cells(false, ...CANONICAL_EVENTS),
  "prompt.origin": cells(false, "prompt.submit"),
  "tool.file-path": cells(false, "tool.before", "tool.after"),
  "inject.markup": cells(null, "prompt.submit", "session.start", "tool.after"),
  "inject.inline": cells(null, "prompt.submit", "session.start", "tool.after"),
  "inject.before-call": {},
  "block.prevents": { ...cells(true, "prompt.submit", "tool.before"), ...cells(false, "tool.after") },
  "block.reason-to-agent": { ...cells(null, "prompt.submit", "tool.before"), ...cells(true, "tool.after") },
  "block.suppress-prompt": cells(false, "prompt.submit"),
};

const FEATURE_NOTES: HostAdapter["featureNotes"] = {
  "tool.file-path": "ApplyPatch input has no file_path.",
};

/**
 * Hook input always carries Droid's own tool names, even when a matcher used the
 * Claude Code alias ("Matchers"). ApplyPatch edits files with no file_path in its input.
 */
const CANONICAL_TOOLS: Readonly<Record<string, string>> = {
  Execute: "Bash",
  Create: "Write",
  ApplyPatch: "Edit",
};

/** Droid documents no override for its user settings folder; HOME is what homedir() reads. */
const factoryDir = (env: NodeJS.ProcessEnv = process.env) => join(env.HOME || homedir(), ".factory");

const rootLayout = claudeLayout("droid", true);
const settingsLayout = claudeLayout("droid");

interface DroidFiles {
  hooksJson: string;
  settingsJson: string;
  /** The root-keyed file Droid reads: hooks.json, or legacy hooks/hooks.json while hooks.json is absent. */
  activeRoot: string;
}

function files(dir: string): DroidFiles {
  const hooksJson = join(dir, "hooks.json");
  const legacy = join(dir, "hooks", "hooks.json");
  const activeRoot = !existsSync(hooksJson) && existsSync(legacy) ? legacy : hooksJson;
  return { hooksJson, settingsJson: join(dir, "settings.json"), activeRoot };
}

/**
 * Event names each file defines. Reads both files strictly, so a file hookmux
 * cannot parse stops an install or uninstall before either file is written,
 * instead of being read as "no events" and shadowed.
 * @throws ConfigEditError when either file is not a JSON object hookmux can edit.
 */
function definedEvents(f: DroidFiles): { root: Set<string>; settings: Set<string> } {
  return { root: readEventNames(f.activeRoot, rootLayout), settings: readEventNames(f.settingsJson, settingsLayout) };
}

/** Events to add to settings.json: those it already defines and the active root file does not. */
function settingsOwned(f: DroidFiles, events: CanonicalEvent[]): CanonicalEvent[] {
  const defined = definedEvents(f);
  return events.filter((e) => !defined.root.has(CLAUDE_EVENTS[e]) && defined.settings.has(CLAUDE_EVENTS[e]));
}

/** One change report for both files; `file` names each file that was written. */
function merge(a: ConfigChange, b: ConfigChange): ConfigChange {
  const written = [a, b].filter((c) => c.changed);
  return {
    file: written.length > 0 ? written.map((c) => c.file).join(", ") : a.file,
    changed: written.length > 0,
    ...(written[0]?.backup ? { backup: written[0].backup } : {}),
    added: [...a.added, ...b.added],
    removed: [...a.removed, ...b.removed],
    notes: [...a.notes, ...b.notes],
  };
}

const config: HostConfigEditor = {
  file: (env) => files(factoryDir(env)).hooksJson,
  detect: (env) => existsSync(factoryDir(env)),
  installed(launcher, env) {
    const f = files(factoryDir(env));
    // A settings.json entry for an event the root file defines never runs, so it does not count.
    let shadowed: Set<string>;
    try {
      shadowed = readEventNames(f.activeRoot, rootLayout);
    } catch {
      shadowed = new Set();
    }
    const found = new Set([
      ...installedEvents(f.activeRoot, launcher, rootLayout),
      ...installedEvents(f.settingsJson, launcher, settingsLayout).filter((e) => !shadowed.has(CLAUDE_EVENTS[e])),
    ]);
    return (Object.keys(CLAUDE_EVENTS) as CanonicalEvent[]).filter((e) => found.has(e));
  },
  install(entry: HubEntry, env) {
    const f = files(factoryDir(env));
    const toSettings = settingsOwned(f, entry.events);
    const toRoot = entry.events.filter((e) => !toSettings.includes(e));
    if (toRoot.length > 0 && f.activeRoot !== f.hooksJson) {
      throw new ConfigEditError(
        `${f.activeRoot} is Droid's legacy hooks file, and Droid stops reading it once hooks.json exists; ` +
          "save any hook from Droid's /hooks screen once to migrate it, then run hookmux sync",
      );
    }
    // Both calls also run with no events, which validates the file without writing it.
    return merge(
      installEntries(f.activeRoot, { ...entry, events: toRoot }, rootLayout),
      installEntries(f.settingsJson, { ...entry, events: toSettings }, settingsLayout),
    );
  },
  uninstall(launcher, env) {
    const f = files(factoryDir(env));
    // Validate both files it writes first, so a bad settings.json stops this before hooks.json is written.
    readEventNames(f.hooksJson, rootLayout);
    readEventNames(f.settingsJson, settingsLayout);
    return merge(
      uninstallEntries(f.hooksJson, launcher, rootLayout),
      uninstallEntries(f.settingsJson, launcher, settingsLayout),
    );
  },
};

export const droid = claudeStyleAdapter({
  id: "droid",
  name: "Factory Droid",
  supports: SUPPORTS,
  features: HOST_FEATURES,
  featureNotes: FEATURE_NOTES,
  configDir: factoryDir,
  // UserPromptSubmit and PostToolUse read decision "block" with reason; a blocked prompt is handed back unsent.
  blockOutput: (_event, _native, reason) => ({ decision: "block", reason }),
  canonicalTools: CANONICAL_TOOLS,
  config,
  sampleShellTool: "Execute",
});
