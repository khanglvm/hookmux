// The check-kind registry. Each kind validates its options at compile time and
// produces a Signal at hook time. Kinds register themselves from their own file,
// so adding a kind never touches the engine.

import type { CheckSpec, HookEvent, PluginSpec, Signal } from "../core/types.ts";

/**
 * Cost tier, which decides evaluation order:
 * 0 = in-process and synchronous, 1 = subprocess, 2 = model call.
 */
export type Tier = 0 | 1 | 2;

export interface CheckContext {
  event: HookEvent;
  plugin: PluginSpec;
  /** Aborted when the hub deadline is reached. */
  signal: AbortSignal;
  /** Milliseconds left before the hub deadline. */
  remainingMs: () => number;
  settings: RuntimeSettings;
}

/** Hub-wide settings a check may need at run time (compiled from config). */
export interface RuntimeSettings {
  providers: Record<string, ProviderSettings>;
}

export interface ProviderSettings {
  kind: string;
  url: string;
  model?: string;
  timeoutMs?: number;
  /** Name of an environment variable that holds the API key; the key itself is never stored. */
  apiKeyEnv?: string;
}

export interface CheckKind {
  kind: string;
  tier: Tier;
  output: "bool" | "score";
  /** True when a model decides the value. Model-backed checks cannot justify a block on their own. */
  modelBacked: boolean;
  /** Returns human-readable problems; empty means valid. */
  validate(spec: CheckSpec): string[];
  run(spec: CheckSpec, ctx: CheckContext): Signal | Promise<Signal>;
}

const kinds = new Map<string, CheckKind>();

export function registerCheck(kind: CheckKind): void {
  kinds.set(kind.kind, kind);
}

export function getCheck(kind: string): CheckKind | undefined {
  return kinds.get(kind);
}

export function listChecks(): CheckKind[] {
  return [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}
