// Plans what a plugin does on each host: for every host it allows, every event it
// listens to there and every effect, the effect hookmux will really perform
// (through resolveEffect, the function the engine itself uses) and the host
// features that make that outcome weaker than written. Pure; the commands that
// print it live in src/commands/.

import { resolveEffect } from "./compose.ts";
import { FEATURES, type FeatureHost, type FeatureId, featuresFor } from "./features.ts";
import type { CanonicalEvent, EffectKind, EffectSpec, PluginSpec, Tri } from "./types.ts";

export interface CompatCaveat {
  feature: FeatureId;
  /** no or unknown; a feature that is yes is never a caveat. */
  value: false | null;
  note: string;
}

export interface CompatRow {
  host: string;
  event: CanonicalEvent;
  /** Position of the effect in the plugin's `[[then]]` list. */
  index: number;
  effect: EffectKind;
  /** works: as written. fallback: another effect stands in. dropped: nothing happens. */
  outcome: "works" | "fallback" | "dropped";
  as: EffectKind | null;
  via: "native" | "engine" | "author";
  note?: string;
  caveats: CompatCaveat[];
}

export type CompatHost = FeatureHost & { id: string };

/** The base spec and per-host variants of a compiled plugin. */
export interface CompiledSpecs {
  base: PluginSpec;
  variants: Record<string, PluginSpec>;
}

const TOOL_FILE_PATH_FIELD = "tool.input.file_path";

function caveatFor(feature: FeatureId, value: Tri): CompatCaveat | undefined {
  if (value === true) return undefined;
  const note = FEATURES.find((f) => f.id === feature)?.caveat ?? feature;
  return { feature, value, note };
}

/** Features about what the plugin reads, not what it does: checks and origins that lean on host facts. */
function inputFeatures(spec: PluginSpec, event: CanonicalEvent): FeatureId[] {
  const checks = Object.values(spec.checks);
  const out: FeatureId[] = [];
  if (checks.some((c) => c.kind === "host" && c.version !== undefined)) out.push("host.version");
  if (event === "prompt.submit" && spec.origins.length === 1 && spec.origins[0] === "user") out.push("prompt.origin");
  if (checks.some((c) => typeof c.field === "string" && c.field.startsWith(TOOL_FILE_PATH_FIELD))) {
    out.push("tool.file-path");
  }
  return out;
}

/** True when the feature can change what this effect does; a caveat that cannot bite is noise. */
function matters(feature: FeatureId, effect: EffectSpec): boolean {
  if (feature === "block.suppress-prompt") return effect.effect === "block" && effect.suppressOriginalPrompt === true;
  if (feature === "inject.markup") return /[<>]/.test(effect.effect === "block" ? effect.reason : effect.text);
  return true;
}

/** Features about the effect that is performed, such as how the model sees injected context. */
function effectFeatures(performed: EffectKind, effect: EffectSpec, facts: Record<string, Tri>): FeatureId[] {
  return FEATURES.filter((f) => f.effect === performed && f.id in facts)
    .map((f) => f.id as FeatureId)
    .filter((id) => matters(id, effect));
}

function rowsFor(spec: PluginSpec, host: CompatHost, event: CanonicalEvent): CompatRow[] {
  const facts = featuresFor(host, event);
  const supports = new Set(host.supports[event]);
  const input = inputFeatures(spec, event);
  return spec.effects.map((effect, index) => {
    const resolved = resolveEffect(effect.effect, effect.fallback, supports);
    const ids = [...input, ...(resolved.as ? effectFeatures(resolved.as, effect, facts) : [])];
    const caveats = ids.flatMap((id) => caveatFor(id, facts[id] ?? null) ?? []);
    const outcome = resolved.as === null ? "dropped" : resolved.via === "native" ? "works" : "fallback";
    return {
      host: host.id,
      event,
      index,
      effect: effect.effect,
      outcome,
      as: resolved.as,
      via: resolved.via,
      ...(resolved.note ? { note: resolved.note } : {}),
      caveats,
    };
  });
}

/**
 * One row per host the plugin allows, event it listens to there and effect.
 * A host with a `[host.<id>]` table is planned from that variant, as the hook does.
 * A host that has no native name for an event gets no rows for it.
 */
export function planPlugin(compiled: CompiledSpecs, hosts: readonly CompatHost[]): CompatRow[] {
  return hosts.flatMap((host) => {
    const spec = compiled.variants[host.id] ?? compiled.base;
    if (spec.hosts.length > 0 && !spec.hosts.includes(host.id)) return [];
    return spec.events.filter((e) => host.nativeEvents[e] !== null).flatMap((e) => rowsFor(spec, host, e));
  });
}

/** True for a row that needs no mention: the effect works as written and nothing is no or unknown. */
export function isPlain(row: CompatRow): boolean {
  return row.outcome === "works" && row.caveats.length === 0;
}
