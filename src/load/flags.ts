// Hub-owned plugin flags in ~/.hookmux/flags.json: which plugins run in shadow
// mode and which are switched off. The registry applies them after the user's
// overrides, so `hookmux add --shadow` and `hookmux disable` win over manifests.

import type { PluginSpec } from "../core/types.ts";
import { readJson, writeFileAtomic } from "../runtime/fsutil.ts";

export interface PluginFlags {
  shadow: string[];
  disabled: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Reads flags.json; a missing or corrupt file means no flags. */
export function readFlags(file: string): PluginFlags {
  const raw = readJson<Partial<PluginFlags> | null>(file, null);
  return { shadow: stringList(raw?.shadow), disabled: stringList(raw?.disabled) };
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
