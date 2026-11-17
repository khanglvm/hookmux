// Reference text for `hookmux schema`: what each manifest key and effect means.
// The authoring skill's references are generated from that command, so keep
// these entries in step with src/load/manifest.ts (a test checks the key list).

export const MANIFEST_KEY_DOCS: Record<string, string> = {
  schema: "manifest format version; must be 1",
  id: "plugin id: lowercase letters, digits and dashes, max 64; must match the folder name",
  version: 'plugin version string, default "0.0.0"',
  description: "one line shown by list and add",
  requires_hookmux: 'hookmux versions this plugin needs, e.g. ">=0.1.0"',
  events: "canonical events the plugin listens to (see events)",
  hosts: "host ids the plugin is limited to; omit for every host",
  phase: "guard, route (default), enrich or observe; phases run in that order",
  priority: "integer, default 100; lower runs first within a phase",
  enabled: "true (default) or false",
  shadow: "true evaluates and logs the plugin but withholds its output",
  origins:
    'who produced the prompt: "user", "system", "unknown"; guards default to all, others to config route_origins',
  dedupe: '"none" (default) or "session": fire at most once per session',
  exclusive: "group name; only the first plugin of a group that fires contributes",
  on_error: 'only "open" is accepted, and it changes nothing: hookmux always fails open, so "block" is rejected',
  when: "boolean expression over check names: and, or, not, parentheses, score comparisons such as s >= 0.7",
  when_degraded: "fallback expression used when `when` stays unknown (a check failed or timed out)",
  params: "table of strings, numbers or booleans available to templates",
  checks: "table of named checks: [checks.<name>] with a kind and that kind's options",
  then: "list of effects: [[then]] tables, applied in order when the plugin fires",
  host: "per-host overrides: [host.<id>] tables merged over the plugin for that host",
};

export const EFFECT_DOCS: Record<string, { summary: string; fields: Record<string, string> }> = {
  inject: { summary: "add text to the agent's context", fields: { text: "text to add, max 4000 characters" } },
  block: {
    summary: "stop the prompt or tool call; needs a rule-backed check to agree unless config allows otherwise",
    fields: {
      reason: "text shown to the user and the agent, max 4000 characters",
      suppress_original_prompt: "prompt.submit only: true hides the blocked prompt",
    },
  },
  notify: { summary: "show a message to the user without changing the context", fields: { text: "message text" } },
};
