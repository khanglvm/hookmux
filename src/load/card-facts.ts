// Builds the facts the approval card needs from a compiled plugin and its
// source record. Kept apart from src/core/card.ts, which stays pure and never
// reads manifests or the check registry.

import { getCheck } from "../checks/registry.ts";
import type { CardFacts, CardTier } from "../core/card.ts";
import type { CanonicalEvent, PluginSpec } from "../core/types.ts";
import type { SourceRecord } from "../install/records.ts";

export interface CardInput {
  id: string;
  base: PluginSpec;
  variants: PluginSpec[];
  /** Absent for a folder placed in plugins/ by hand. */
  source?: Pick<SourceRecord, "source" | "ref" | "commit"> | undefined;
}

/** Merges the base spec and every host variant: the card shows what the plugin can do anywhere. */
export function cardFactsOf({ id, base, variants, source }: CardInput): CardFacts {
  const specs = [base, ...variants];
  const events = new Set<CanonicalEvent>();
  const scripts = new Set<string>();
  const providers = new Set<string>();
  let tier: CardTier = 0;
  for (const spec of specs) {
    for (const e of spec.events) events.add(e);
    for (const check of Object.values(spec.checks)) {
      const kind = getCheck(check.kind);
      if (kind?.modelBacked) tier = 2;
      else if (kind?.tier === 1 && tier < 1) tier = 1;
      if (check.kind === "script" && typeof check.command === "string") scripts.add(check.command);
      if (kind?.modelBacked && typeof check.provider === "string") providers.add(check.provider);
    }
  }
  return {
    id,
    version: base.version,
    description: base.description,
    source: source?.source ?? null,
    ref: source?.ref ?? null,
    commit: source?.commit ?? null,
    events: [...events],
    scripts: [...scripts].sort(),
    modelProviders: [...providers].sort(),
    tier,
  };
}
