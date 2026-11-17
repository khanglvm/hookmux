// Fills `{...}` placeholders in inject, notify and block text.
// Only a fixed set of variables exists. Model-backed checks never provide
// evidence, so model output can never become free text in the agent's context.

import { getCheck } from "../checks/registry.ts";
import type { HookEvent, PluginSpec, Signal } from "./types.ts";

const PLACEHOLDER = /\{(params|host|event|evidence)\.([A-Za-z0-9_-]+)\}/g;

export function renderTemplate(
  text: string,
  plugin: PluginSpec,
  event: HookEvent,
  signals: Readonly<Record<string, Signal>>,
): string {
  return text.replace(PLACEHOLDER, (whole, scope: string, key: string) => {
    switch (scope) {
      case "params":
        return plugin.params[key] ?? whole;
      case "host":
        if (key === "id") return event.host.id;
        if (key === "name") return event.host.name;
        if (key === "version") return event.host.version ?? "unknown";
        return whole;
      case "event":
        if (key === "cwd") return event.cwd;
        if (key === "name") return event.name;
        return whole;
      case "evidence": {
        const spec = plugin.checks[key];
        if (!spec || getCheck(spec.kind)?.modelBacked !== false) return "";
        return signals[key]?.evidence ?? "";
      }
      default:
        return whole;
    }
  });
}
