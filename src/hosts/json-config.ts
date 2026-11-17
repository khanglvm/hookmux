// Edits a JSON hook config of the shape all three clients share:
// { "hooks": { "<NativeEvent>": [ { "matcher"?: "...", "hooks": [ { "type": "command", ... } ] } ] } }.
// Hub groups are appended after existing groups and found again by their
// command path, never by a marker key: Codex rejects unknown keys and keys its
// trust records by array position, so inserting anywhere else would un-trust
// the user's existing hooks.

import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import type { CanonicalEvent } from "../core/types.ts";
import { writeFileAtomic } from "../runtime/fsutil.ts";
import { type ConfigChange, type HubEntry, hubCommand, isHubCommand } from "./types.ts";

export interface JsonHookLayout {
  hostId: string;
  nativeEvents: Record<CanonicalEvent, string | null>;
  /** Builds one handler object; adapters add host-specific fields here. */
  handler(command: string, timeoutSec: number, event: CanonicalEvent): Record<string, unknown>;
  /** Matcher to set on the group for this event, or undefined for none. */
  matcher?(event: CanonicalEvent): string | undefined;
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

function hookTable(config: Json): Record<string, Group[]> {
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
    hooks = hookTable(readConfigJson(file));
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
  const config = readConfigJson(file);
  const hooks = hookTable(config);
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
    config.hooks = hooks;
    save(file, config, change);
  }
  return change;
}

export function uninstallEntries(file: string, launcher: string, layout: JsonHookLayout): ConfigChange {
  const change: ConfigChange = { file, changed: false, added: [], removed: [], notes: [] };
  if (!existsSync(file)) return change;
  const config = readConfigJson(file);
  const hooks = hookTable(config);
  for (const [canonical, native] of Object.entries(layout.nativeEvents) as [CanonicalEvent, string | null][]) {
    if (!native || !Array.isArray(hooks[native])) continue;
    const groups = hooks[native];
    const kept: Group[] = [];
    let removed = false;
    for (const group of groups) {
      if (!groupHasHub(group, launcher)) {
        kept.push(group);
        continue;
      }
      removed = true;
      const others = (group.hooks ?? []).filter((h) => !isHubCommand(h?.command, launcher));
      if (others.length > 0) kept.push({ ...group, hooks: others });
    }
    if (!removed) continue;
    const lastIndex = groups.findLastIndex((g) => groupHasHub(g, launcher));
    if (lastIndex < groups.length - 1) {
      change.notes.push(
        `${native}: entries after the hub entry moved up one place; ${layout.hostId} may ask to re-approve them`,
      );
    }
    if (kept.length > 0) hooks[native] = kept;
    else delete hooks[native];
    change.removed.push(canonical);
  }
  if (change.removed.length > 0) {
    if (Object.keys(hooks).length === 0) delete config.hooks;
    else config.hooks = hooks;
    save(file, config, change);
  }
  return change;
}
