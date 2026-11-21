// What a plugin author may want to know about an agent client beyond the effects
// it supports: a fixed vocabulary of yes/no/unknown facts, declared per host and
// event by each adapter. The `host` check reads them; `validate`, `test` and
// `schema` report them. Unknown (null) is a real value: a fact an adapter cannot
// cite stays unknown instead of being guessed.

import type { CanonicalEvent, EffectKind, Tri } from "./types.ts";

export interface FeatureDef {
  id: string;
  /** What "yes" means, in one sentence. */
  meaning: string;
  /** Events the feature is about; on any other event its value is unknown. */
  events: readonly CanonicalEvent[];
  /** Set when the feature qualifies an effect: it is no wherever the host cannot perform that effect. */
  effect?: EffectKind;
  /** What goes wrong for a plugin when the value is no or unknown; shown in compatibility reports. */
  caveat: string;
}

const ALL_EVENTS = ["prompt.submit", "session.start", "tool.before", "tool.after"] as const;
const PROMPT = ["prompt.submit"] as const;
const TOOLS = ["tool.before", "tool.after"] as const;
const BLOCKING = ["prompt.submit", "tool.before", "tool.after"] as const;

const DEFINITIONS = [
  {
    id: "host.version",
    meaning: "The payload reports the client version",
    events: ALL_EVENTS,
    caveat: "the client reports no version, so a version range is unknown",
  },
  {
    id: "prompt.origin",
    meaning: "hookmux can tell user prompts from system or agent sends",
    events: PROMPT,
    caveat: "system and agent sends look like user prompts",
  },
  {
    id: "tool.file-path",
    meaning: "Every file-edit tool carries tool_input.file_path",
    events: TOOLS,
    caveat: "some file edits carry no file_path to match on",
  },
  {
    id: "inject.markup",
    meaning: "< and > in added context reach the model unescaped",
    events: ALL_EVENTS,
    effect: "inject",
    caveat: "markup in added context may be escaped",
  },
  {
    id: "inject.inline",
    meaning: "All added context up to the context limit is shown inline",
    events: ALL_EVENTS,
    effect: "inject",
    caveat: "long added context may be moved out of the prompt",
  },
  {
    id: "inject.before-call",
    meaning: "The model sees added context before the tool runs",
    events: ["tool.before"],
    effect: "inject",
    caveat: "added context may reach the model only with the tool result",
  },
  {
    id: "block.prevents",
    meaning: "A block stops the action before it happens",
    events: BLOCKING,
    effect: "block",
    caveat: "the tool already ran",
  },
  {
    id: "block.reason-to-agent",
    meaning: "The agent sees the block reason",
    events: BLOCKING,
    effect: "block",
    caveat: "the agent may not see the block reason",
  },
  {
    id: "block.suppress-prompt",
    meaning: "suppress_original_prompt is honoured",
    events: PROMPT,
    effect: "block",
    caveat: "the blocked prompt may stay in the history",
  },
] as const satisfies readonly FeatureDef[];

export type FeatureId = (typeof DEFINITIONS)[number]["id"];

export const FEATURES: readonly FeatureDef[] = DEFINITIONS;

/** What an adapter declares: for each feature, a value per event it applies to. */
export type FeatureTable = Record<FeatureId, Partial<Record<CanonicalEvent, Tri>>>;

/** The facts about one host on one event. A feature that does not apply here is absent, and reads as unknown. */
export type FeatureFacts = Partial<Record<FeatureId, Tri>>;

/** The parts of an adapter that decide its facts. */
export interface FeatureHost {
  nativeEvents: Record<CanonicalEvent, string | null>;
  supports: Record<CanonicalEvent, EffectKind[]>;
  features: FeatureTable;
}

export function isFeatureId(id: string): id is FeatureId {
  return FEATURES.some((f) => f.id === id);
}

/** The same value on each listed event; keeps adapter tables short. */
export function cells(value: Tri, ...events: CanonicalEvent[]): Partial<Record<CanonicalEvent, Tri>> {
  return Object.fromEntries(events.map((e) => [e, value]));
}

/**
 * True when an adapter must state this (feature, event) pair: the event exists on
 * the host and any effect the feature qualifies is supported there. Elsewhere the
 * value is derived (no for an unsupported effect) or not applicable.
 */
export function isDeclared(host: FeatureHost, feature: FeatureDef, event: CanonicalEvent): boolean {
  if (!feature.events.includes(event) || host.nativeEvents[event] === null) return false;
  return feature.effect === undefined || host.supports[event].includes(feature.effect);
}

/** Resolves every applicable feature for `event`, adding the derived no for effects the host cannot perform. */
export function featuresFor(host: FeatureHost, event: CanonicalEvent): FeatureFacts {
  const facts: FeatureFacts = {};
  if (host.nativeEvents[event] === null) return facts;
  for (const feature of FEATURES) {
    if (!feature.events.includes(event)) continue;
    const id = feature.id as FeatureId;
    facts[id] = isDeclared(host, feature, event) ? (host.features[id][event] ?? null) : false;
  }
  return facts;
}
