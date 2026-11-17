// Hub-owned plugin flags in ~/.hookmux/flags.json: which plugins run in shadow
// mode and which are switched off. The registry applies them after the user's
// overrides, so `hookmux add --shadow` and `hookmux disable` win over manifests.

import { readFileSync } from "node:fs";
import type { PluginSpec } from "../core/types.ts";
import { writeFileAtomic } from "../runtime/fsutil.ts";

export interface PluginFlags {
  shadow: string[];
  disabled: string[];
}

export interface FlagsRead extends PluginFlags {
  /**
   * Set when flags.json exists but cannot be read or is not valid flags JSON.
   * The lists are then empty, so callers must not act on them as if no plugin
   * were disabled: the registry marks every plugin invalid instead.
   */
  problem?: string;
}

export const FLAGS_PROBLEM = "flags.json is unreadable; fix or delete it";

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Reads flags.json. A missing file means no flags; anything else unusable sets `problem`. */
export function readFlags(file: string): FlagsRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { shadow: [], disabled: [] };
    return { shadow: [], disabled: [], problem: FLAGS_PROBLEM };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { shadow: [], disabled: [], problem: FLAGS_PROBLEM };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { shadow: [], disabled: [], problem: FLAGS_PROBLEM };
  }
  const { shadow = [], disabled = [] } = raw as Record<string, unknown>;
  if (!isStringList(shadow) || !isStringList(disabled)) return { shadow: [], disabled: [], problem: FLAGS_PROBLEM };
  return { shadow, disabled };
}

/**
 * Reads flags.json before changing it.
 * @throws Error when the file is unreadable, so a rewrite cannot replace a
 * corrupt file with empty lists and switch disabled plugins back on.
 */
export function readFlagsForUpdate(file: string): PluginFlags {
  const flags = readFlags(file);
  if (flags.problem) throw new Error(`${file}: ${flags.problem}`);
  return { shadow: flags.shadow, disabled: flags.disabled };
}

export function writeFlags(file: string, flags: PluginFlags): void {
  const clean = { shadow: [...new Set(flags.shadow)].sort(), disabled: [...new Set(flags.disabled)].sort() };
  writeFileAtomic(file, `${JSON.stringify(clean, null, 2)}\n`);
}

/** Returns the spec with this plugin's flags applied; the input is not changed. */
export function applyFlags(spec: PluginSpec, flags: PluginFlags): PluginSpec {
  const shadow = flags.shadow.includes(spec.id);
  const disabled = flags.disabled.includes(spec.id);
  if (!shadow && !disabled) return spec;
  return { ...spec, shadow: spec.shadow || shadow, enabled: spec.enabled && !disabled };
}
