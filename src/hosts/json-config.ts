// Edits a JSON hook config of the shape all three clients share:
// { "hooks": { "<NativeEvent>": [ { "matcher"?: "...", "hooks": [ { "type": "command", ... } ] } ] } }.
// Hub groups are appended after existing groups and found again by their
// command path, never by a marker key: Codex rejects unknown keys and keys its
// trust records by array position, so inserting anywhere else would un-trust
// the user's existing hooks.

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import type { CanonicalEvent } from "../core/types.ts";
import { writeFileAtomic } from "../runtime/fsutil.ts";
import { hubCommand, isHubCommand } from "./hub-command.ts";
import type { ConfigChange, HubEntry } from "./types.ts";

export interface JsonHookLayout {
  hostId: string;
  nativeEvents: Record<CanonicalEvent, string | null>;
  /** Builds one handler object; adapters add host-specific fields here. */
  handler(command: string, timeoutSec: number, event: CanonicalEvent): Record<string, unknown>;
  /** Matcher to set on the group for this event, or undefined for none. */
  matcher?(event: CanonicalEvent): string | undefined;
  /**
   * Validates the whole parsed file before anything is changed. Throws
   * ConfigEditError when the host could not load the file as it stands.
   */
  checkRoot?(config: Record<string, unknown>, file: string): void;
  /**
   * Keep every group's index on uninstall: a removed hub group that has groups
   * after it becomes `{"hooks": []}` instead of being deleted. For hosts that key
   * hook approval by position (Codex), so later user hooks keep their approval.
   */
  preserveGroupPositions?: boolean;
  /**
   * The event map is the file's root object instead of its `hooks` key, as in
   * Factory Droid's hooks.json. Other root keys (such as `hooksDisabled`) are kept.
   */
  rootTable?: boolean;
}

type Json = Record<string, unknown>;
type Group = { matcher?: string; hooks?: Json[] } & Json;

export class ConfigEditError extends Error {}

function readConfigJson(file: string): Json {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigEditError(`${file} is not valid JSON (${(error as Error).message}); fix it first`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigEditError(`${file} must contain a JSON object`);
  }
  return parsed as Json;
}

/** Reads the config and runs the layout's root check, so no caller can skip it. */
function readChecked(file: string, layout: JsonHookLayout): Json {
  const config = readConfigJson(file);
  layout.checkRoot?.(config, file);
  return config;
}

function hookTable(config: Json, layout: JsonHookLayout): Record<string, Group[]> {
  if (layout.rootTable) return config as Record<string, Group[]>;
  const hooks = config.hooks;
  if (hooks === undefined) return {};
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new ConfigEditError("'hooks' is not an object; fix it first");
  }
  return hooks as Record<string, Group[]>;
}

function groupHasHub(group: Group, launcher: string): boolean {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => isHubCommand(h?.command, launcher));
}

export function installedEvents(file: string, launcher: string, layout: JsonHookLayout): CanonicalEvent[] {
  let hooks: Record<string, Group[]>;
  try {
    hooks = hookTable(readChecked(file, layout), layout);
  } catch {
    return [];
  }
  const out: CanonicalEvent[] = [];
  for (const [canonical, native] of Object.entries(layout.nativeEvents) as [CanonicalEvent, string | null][]) {
    if (native && Array.isArray(hooks[native]) && hooks[native].some((g) => groupHasHub(g, launcher)))
      out.push(canonical);
  }
  return out;
}

/**
 * Native event names that have an entry list in the file; empty when the file is missing.
 * @throws ConfigEditError when the file exists but is not a config hookmux can edit.
 */
export function readEventNames(file: string, layout: JsonHookLayout): Set<string> {
  const hooks = hookTable(readChecked(file, layout), layout);
  return new Set(Object.keys(hooks).filter((name) => Array.isArray(hooks[name])));
}

function save(file: string, config: Json, change: ConfigChange): void {
  if (existsSync(file)) {
    change.backup = `${file}.hookmux.bak`;
    copyFileSync(file, change.backup);
  }
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, mode);
  change.changed = true;
}

export function installEntries(file: string, entry: HubEntry, layout: JsonHookLayout): ConfigChange {
  const config = readChecked(file, layout);
  const hooks = hookTable(config, layout);
  const change: ConfigChange = { file, changed: false, added: [], removed: [], notes: [] };
  for (const event of entry.events) {
    const native = layout.nativeEvents[event];
    if (!native) {
      change.notes.push(`${layout.hostId} has no ${event} event; skipped`);
      continue;
    }
    const groups = Array.isArray(hooks[native]) ? hooks[native] : [];
    if (groups.some((g) => groupHasHub(g, entry.launcher))) continue;
    const group: Group = {};
    const matcher = layout.matcher?.(event);
    if (matcher !== undefined) group.matcher = matcher;
    group.hooks = [layout.handler(hubCommand(entry.launcher, layout.hostId, event), entry.timeoutSec, event)];
    hooks[native] = [...groups, group];
    change.added.push(event);
  }
  if (change.added.length > 0) {
    if (!layout.rootTable) config.hooks = hooks;
    save(file, config, change);
  }
  return change;
}

export function uninstallEntries(file: string, launcher: string, layout: JsonHookLayout): ConfigChange {
  const change: ConfigChange = { file, changed: false, added: [], removed: [], notes: [] };
  if (!existsSync(file)) return change;
  const config = readChecked(file, layout);
  const hooks = hookTable(config, layout);
  for (const [canonical, native] of Object.entries(layout.nativeEvents) as [CanonicalEvent, string | null][]) {
    if (!native || !Array.isArray(hooks[native])) continue;
    const groups = hooks[native];
    if (!groups.some((g) => groupHasHub(g, launcher))) continue;
    const kept = withoutHub(groups, launcher, layout.preserveGroupPositions === true);
    const lastIndex = groups.findLastIndex((g) => groupHasHub(g, launcher));
    if (!layout.preserveGroupPositions && lastIndex < groups.length - 1) {
      change.notes.push(
        `${native}: entries after the hub entry moved up one place; ${layout.hostId} may ask to re-approve them`,
      );
    }
    if (kept.length > 0) hooks[native] = kept;
    else delete hooks[native];
    change.removed.push(canonical);
  }
  if (change.removed.length > 0) {
    // A root event map was edited in place, so only a `hooks` key needs writing back.
    if (!layout.rootTable) {
      if (Object.keys(hooks).length === 0) delete config.hooks;
      else config.hooks = hooks;
    }
    save(file, config, change);
  }
  return change;
}

/** Marks a removed hub group whose slot is kept; replaced by `{"hooks": []}` on output. */
const PLACEHOLDER = Symbol("removed hub group");

/**
 * The groups with hub handlers removed. A group left with no handler is dropped,
 * or, when `preserve` is set and a group follows it, kept as an empty placeholder
 * so later groups keep their index. Placeholders left trailing are trimmed; the
 * user's own empty groups are never touched.
 */
function withoutHub(groups: Group[], launcher: string, preserve: boolean): Group[] {
  const kept: (Group | typeof PLACEHOLDER)[] = [];
  for (const group of groups) {
    if (!groupHasHub(group, launcher)) {
      kept.push(group);
      continue;
    }
    const others = (group.hooks ?? []).filter((h) => !isHubCommand(h?.command, launcher));
    if (others.length > 0) kept.push({ ...group, hooks: others });
    else if (preserve) kept.push(PLACEHOLDER);
  }
  while (kept.at(-1) === PLACEHOLDER) kept.pop();
  return kept.map((g) => (g === PLACEHOLDER ? { hooks: [] } : g));
}
