// Shared contract between host adapters, the engine, checks and effects.
// Adapters turn a host payload into a HookEvent; the engine turns plugins plus
// that event into a HubResult; the adapter renders the result for the host.

import type { FeatureFacts } from "./features.ts";

/** Hook points that hookmux exposes to plugins, whatever the host calls them. */
export const CANONICAL_EVENTS = ["prompt.submit", "session.start", "tool.before", "tool.after"] as const;
export type CanonicalEvent = (typeof CANONICAL_EVENTS)[number];

/** Plugin ids: also folder and state-file names, so they never hold a path separator. */
export const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Who produced a prompt. Route plugins only fire on "user" by default. */
export type Origin = "user" | "system" | "unknown";

export const PHASES = ["guard", "route", "enrich", "observe"] as const;
export type Phase = (typeof PHASES)[number];

export type EffectKind = "inject" | "block" | "notify";

/** Read-only description of the agent client running this hook. */
export interface HostContext {
  /** Stable adapter id, such as "claude-code", "codex" or "gemini-cli"; src/hosts/index.ts lists them all. */
  id: string;
  name: string;
  /** Host version when the payload or environment reveals it; never guessed. */
  version: string | null;
  adapterContract: 1;
  nativeEvent: string;
  canonicalEvent: CanonicalEvent;
  /** Effects this host can perform on this event. */
  supports: EffectKind[];
  /** What this host does and does not do on this event; see src/core/features.ts. */
  features: FeatureFacts;
  limits: { contextChars: number };
}

export interface ToolCall {
  /** Host's own tool name, e.g. "run_shell_command". */
  name: string;
  /** hookmux's portable name, e.g. "Bash", "Write", "Edit", "Read", or the host name when unmapped. */
  canonicalName: string;
  input: unknown;
}

export interface HookEvent {
  name: CanonicalEvent;
  host: HostContext;
  sessionId: string;
  cwd: string;
  origin: Origin;
  prompt?: string;
  /**
   * The text the person submitted, on clients that report it apart from `prompt`, which can carry
   * expansions (pasted or referenced files, command bodies) the agent may have written. A relayed
   * approval reads this when it is present.
   */
  submittedPrompt?: string;
  tool?: ToolCall;
  /** Session start reason when the host reports one ("startup", "resume", "clear"). */
  source?: string;
  /** The host's original payload. Passed to scripts only when they opt in. */
  raw: unknown;
}

/** Kleene three-valued truth: null means unknown (error, timeout, not run). */
export type Tri = boolean | null;

/** A check result. Boolean checks give Tri; score checks give a number in [0, 1] or null. */
export interface Signal {
  value: Tri | number;
  /** Matched text or other non-model detail, usable in templates. */
  evidence?: string;
  error?: string;
  ms?: number;
}

/** Effects an author may name as a fallback; block is never one, so a fallback cannot add a block. */
export type Fallback = ("inject" | "notify")[];

export interface InjectEffect {
  effect: "inject";
  text: string;
  /** Tried in order where the host cannot inject; absent keeps the engine's own fallback. */
  fallback?: Fallback;
}
export interface BlockEffect {
  effect: "block";
  reason: string;
  suppressOriginalPrompt?: boolean;
  /** Tried in order where the host cannot block; absent means a notice, then dropped. */
  fallback?: Fallback;
}
export interface NotifyEffect {
  effect: "notify";
  text: string;
  /** Tried in order where the host cannot notify; absent means dropped. */
  fallback?: Fallback;
}
export type EffectSpec = InjectEffect | BlockEffect | NotifyEffect;

export interface CheckSpec {
  kind: string;
  [option: string]: unknown;
}

/** A validated plugin, after overrides and the per-host table have been merged. */
export interface PluginSpec {
  id: string;
  version: string;
  description: string;
  /** Absolute folder of the hub-owned copy; scripts resolve against it. */
  dir: string;
  events: CanonicalEvent[];
  /** Hosts this plugin is limited to; empty means every host. */
  hosts: string[];
  phase: Phase;
  /** Lower runs first inside a phase. */
  priority: number;
  enabled: boolean;
  /** Evaluate and log, but contribute nothing to the output. */
  shadow: boolean;
  origins: Origin[];
  checks: Record<string, CheckSpec>;
  when: string;
  /** Used when `when` stays unknown because a check failed or timed out. */
  whenDegraded?: string;
  effects: EffectSpec[];
  dedupe: "none" | "session";
  /** Plugins sharing a group: only the first that fires contributes. */
  exclusive?: string;
  params: Record<string, string>;
  /** SHA-256 per file in the plugin folder, from the registry; scripts are re-verified against it. */
  fileHashes?: Record<string, string>;
}

export type PluginOutcome = "fire" | "silent" | "unknown" | "error" | "skipped";

export interface PluginTrace {
  id: string;
  outcome: PluginOutcome;
  /** Why a plugin was skipped or its output dropped. */
  note?: string;
  shadow: boolean;
  signals: Record<string, Signal>;
  ms: number;
}

export interface HubResult {
  block?: { reason: string; suppressOriginalPrompt: boolean; pluginId: string };
  context: { pluginId: string; text: string }[];
  notices: { pluginId: string; text: string }[];
  trace: PluginTrace[];
  errors: string[];
}

export function emptyResult(): HubResult {
  return { context: [], notices: [], trace: [], errors: [] };
}
