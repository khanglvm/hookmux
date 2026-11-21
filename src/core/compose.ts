// Turns the plugins that fired into one HubResult: phase and priority order,
// block wins, exclusive groups, host support fallbacks and the context budget.

import { getCheck } from "../checks/registry.ts";
import type { EngineSettings } from "./engine.ts";
import { renderTemplate } from "./template.ts";
import {
  type EffectKind,
  type Fallback,
  type HookEvent,
  type HubResult,
  PHASES,
  type PluginSpec,
  type PluginTrace,
} from "./types.ts";

const CONTEXT_SEPARATOR = "\n\n";

export function orderPlugins(plugins: PluginSpec[]): PluginSpec[] {
  return [...plugins].sort(
    (a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.priority - b.priority || a.id.localeCompare(b.id),
  );
}

/** What one effect becomes on one host and event. */
export interface ResolvedEffect {
  /** The effect that is performed; null when the effect is dropped. */
  as: EffectKind | null;
  /** native: the host does it as written. engine: hookmux's own fallback. author: the plugin's `fallback` list. */
  via: "native" | "engine" | "author";
  /** Why the effect was changed or dropped; absent when it runs as written. */
  note?: string;
}

const EFFECT_VERB: Record<EffectKind, string> = { inject: "add context", block: "block", notify: "notify" };

/**
 * Decides what an effect becomes where the host may not support it. With a
 * `fallback` list the first supported entry wins, and an empty list drops the
 * effect. Without one: a block becomes a notice where the host can notify, and
 * everything else is dropped. The hook, `validate`, `test` and `explain` all call
 * this, so reports match what the engine does.
 */
export function resolveEffect(
  kind: EffectKind,
  fallback: Fallback | undefined,
  supports: ReadonlySet<EffectKind>,
): ResolvedEffect {
  const can = (e: EffectKind) => supports.has(e);
  if (can(kind)) return { as: kind, via: "native" };
  const verb = EFFECT_VERB[kind];
  if (fallback !== undefined) {
    const chosen = fallback.find(can);
    if (chosen) return { as: chosen, via: "author", note: `host cannot ${verb} here; fallback ${chosen}` };
    return { as: null, via: "author", note: `host cannot ${verb} here; no listed fallback works; dropped` };
  }
  if (kind !== "block") return { as: null, via: "engine", note: `host cannot ${verb} here; dropped` };
  if (can("notify")) return { as: "notify", via: "engine", note: "host cannot block here; shown as a notice" };
  return { as: null, via: "engine", note: "host cannot block or notify here; dropped" };
}

export function compose(
  event: HookEvent,
  fired: PluginSpec[],
  traces: PluginTrace[],
  settings: EngineSettings,
): HubResult {
  const result: HubResult = { context: [], notices: [], trace: traces, errors: [] };
  const byId = new Map(traces.map((t) => [t.id, t]));
  const note = (id: string, text: string) => {
    const t = byId.get(id);
    if (t) t.note = t.note ? `${t.note}; ${text}` : text;
  };
  const supports = new Set(event.host.supports);
  const claimed = new Set<string>();
  const budget = Math.min(settings.contextBudget, event.host.limits.contextChars);
  let used = 0;

  for (const plugin of orderPlugins(fired)) {
    if (plugin.shadow) {
      note(plugin.id, "shadow: output withheld");
      continue;
    }
    if (plugin.exclusive) {
      if (claimed.has(plugin.exclusive)) {
        note(plugin.id, `exclusive group '${plugin.exclusive}' already taken`);
        continue;
      }
      claimed.add(plugin.exclusive);
    }
    const signals = byId.get(plugin.id)?.signals ?? {};
    for (const effect of plugin.effects) {
      const text = renderTemplate(effect.effect === "block" ? effect.reason : effect.text, plugin, event, signals);
      if (effect.effect === "block") {
        if (result.block) continue;
        // A block dropped for lacking a rule never falls back to a weaker effect.
        if (settings.blockRequiresRule && !hasRuleYes(plugin, signals)) {
          note(plugin.id, "block dropped: no rule-backed check agreed");
          continue;
        }
      }
      const resolved = resolveEffect(effect.effect, effect.fallback, supports);
      if (resolved.note) note(plugin.id, resolved.note);
      if (resolved.as === "block" && effect.effect === "block") {
        result.block = {
          reason: text,
          suppressOriginalPrompt: effect.suppressOriginalPrompt === true,
          pluginId: plugin.id,
        };
      } else if (resolved.as === "inject") {
        // An inject reached by fallback counts against the budget like any other.
        const cost = text.length + (result.context.length > 0 ? CONTEXT_SEPARATOR.length : 0);
        if (used + cost > budget) {
          note(plugin.id, `over context budget (${budget} chars); dropped`);
          continue;
        }
        used += cost;
        result.context.push({ pluginId: plugin.id, text });
      } else if (resolved.as === "notify") result.notices.push({ pluginId: plugin.id, text });
    }
  }
  return result;
}

export function joinContext(result: HubResult): string {
  return result.context.map((c) => c.text).join(CONTEXT_SEPARATOR);
}

/** True when some check that is not model-backed returned true for this plugin. */
function hasRuleYes(plugin: PluginSpec, signals: PluginTrace["signals"]): boolean {
  return Object.entries(signals).some(([name, s]) => {
    const spec = plugin.checks[name];
    return s.value === true && spec !== undefined && getCheck(spec.kind)?.modelBacked === false;
  });
}
