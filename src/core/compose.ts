// Turns the plugins that fired into one HubResult: phase and priority order,
// block wins, exclusive groups, host support fallbacks and the context budget.

import { getCheck } from "../checks/registry.ts";
import type { EngineSettings } from "./engine.ts";
import { renderTemplate } from "./template.ts";
import { type HookEvent, type HubResult, PHASES, type PluginSpec, type PluginTrace } from "./types.ts";

const CONTEXT_SEPARATOR = "\n\n";

export function orderPlugins(plugins: PluginSpec[]): PluginSpec[] {
  return [...plugins].sort(
    (a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.priority - b.priority || a.id.localeCompare(b.id),
  );
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
        if (settings.blockRequiresRule && !hasRuleYes(plugin, signals)) {
          note(plugin.id, "block dropped: no rule-backed check agreed");
          continue;
        }
        if (supports.has("block")) {
          result.block = {
            reason: text,
            suppressOriginalPrompt: effect.suppressOriginalPrompt === true,
            pluginId: plugin.id,
          };
        } else if (supports.has("notify")) {
          note(plugin.id, "host cannot block here; shown as a notice");
          result.notices.push({ pluginId: plugin.id, text });
        } else note(plugin.id, "host cannot block or notify here; dropped");
      } else if (effect.effect === "inject") {
        if (!supports.has("inject")) {
          note(plugin.id, "host cannot add context here; dropped");
          continue;
        }
        const cost = text.length + (result.context.length > 0 ? CONTEXT_SEPARATOR.length : 0);
        if (used + cost > budget) {
          note(plugin.id, `over context budget (${budget} chars); dropped`);
          continue;
        }
        used += cost;
        result.context.push({ pluginId: plugin.id, text });
      } else if (effect.effect === "notify") {
        if (supports.has("notify")) result.notices.push({ pluginId: plugin.id, text });
        else note(plugin.id, "host cannot notify here; dropped");
      }
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
