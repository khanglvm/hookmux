// Shared pieces for commands that run the engine in-process (`test`, `explain`):
// building an event from a host's own sample payload, engine settings from the
// registry, and one-line signal summaries.

import "../../checks/index.ts";
import { listChecks, registerCheck } from "../../checks/registry.ts";
import type { EngineSettings } from "../../core/engine.ts";
import type { CanonicalEvent, HookEvent, PluginOutcome, Signal } from "../../core/types.ts";
import { ADAPTERS, getAdapter } from "../../hosts/index.ts";
import type { HostAdapter } from "../../hosts/types.ts";
import type { Registry } from "../../load/snapshot.ts";
import { UsageError } from "./args.ts";
import { clip, type Status } from "./output.ts";

/** Host used when a command or test case names none. */
export const DEFAULT_HOST = "claude-code";
export const STUBBED_MODEL_ERROR = "model check not run (stubbed; pass --live to call the model)";

/** @throws UsageError naming the known hosts when `id` has no adapter. */
export function adapterOrUsage(id: string): HostAdapter {
  const adapter = getAdapter(id);
  if (!adapter) throw new UsageError(`unknown host '${id}'; known hosts: ${Object.keys(ADAPTERS).join(", ")}`);
  return adapter;
}

/** Builds the event the hook would see, from the adapter's own sample payload. */
export function sampleEvent(adapter: HostAdapter, event: CanonicalEvent, prompt: string, cwd?: string): HookEvent {
  const parsed = adapter.parse(event, adapter.sample(event, prompt), process.env);
  if (!parsed) throw new Error(`${adapter.id} could not parse its own ${event} sample`);
  return cwd ? { ...parsed, cwd } : parsed;
}

export function engineSettings(registry: Registry): EngineSettings {
  return {
    deadlineMs: registry.settings.deadlineMs,
    blockRequiresRule: registry.settings.blockRequiresRule,
    contextBudget: registry.settings.contextBudget,
    runtime: { providers: registry.providers },
  };
}

/**
 * Replaces every model-backed check kind, in this process only, with one that
 * returns unknown, so tests stay offline and deterministic unless `--live`.
 */
export function stubModelChecks(): void {
  for (const kind of listChecks()) {
    if (!kind.modelBacked) continue;
    registerCheck({ ...kind, run: () => ({ value: null, error: STUBBED_MODEL_ERROR }) });
  }
}

/** `name=value` pairs with evidence or error, for one-line display. */
export function formatSignals(signals: Record<string, Signal>): string {
  return Object.entries(signals)
    .map(([name, s]) => {
      const value = s.value === null ? "unknown" : String(s.value);
      const extra = s.error ? ` (${clip(s.error, 50)})` : s.evidence ? ` ("${clip(s.evidence, 30)}")` : "";
      return `${name}=${value}${extra}`;
    })
    .join("  ");
}

/** Status mark for a plugin outcome: fired or silent is fine, unknown is a warning, error a problem. */
export function outcomeStatus(outcome: PluginOutcome): Status {
  if (outcome === "fire") return "ok";
  if (outcome === "silent") return "info";
  if (outcome === "error") return "fail";
  return "warn";
}
