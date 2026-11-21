// CodeBuddy Code adapter, written from https://www.codebuddy.ai/docs/cli/hooks
// for CodeBuddy Code 2.185.0 (hooks shipped in 1.16.0, still marked beta).
// CodeBuddy takes Claude Code's hook contract and tool names; it blocks a
// prompt with continue:false and cannot block after a tool.

import { homedir } from "node:os";
import { join } from "node:path";
import { cells, type FeatureTable } from "../core/features.ts";
import { CANONICAL_EVENTS, type CanonicalEvent, type EffectKind } from "../core/types.ts";
import { claudeStyleAdapter } from "./claude-style.ts";
import type { HostAdapter } from "./types.ts";

/**
 * PostToolUse can only add context or replace the tool output; its decision "block"
 * is deprecated and has no effect ("PostToolUse Context Injection"). systemMessage
 * is a common field shown to the user only.
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["inject", "block", "notify"],
  "tool.after": ["inject", "notify"],
};

/**
 * Feature facts, from the hooks reference named at the top of this file.
 * - host.version: the documented payload has no version field.
 * - prompt.origin: nothing in a prompt payload marks its source.
 * - tool.file-path: Claude Code's tool names, so Write and Edit take file_path.
 * - block.prevents: continue:false and PreToolUse deny stop the action before it runs.
 * - block.reason-to-agent: a blocked prompt's reason "is shown to the user only" (see blockOutput below).
 * - block.suppress-prompt: no such key.
 * Unknown: markup, inline limits, pre-call context and who sees a pre-call reason. PostToolUse cannot block,
 * so block cells there are derived.
 */
const HOST_FEATURES: FeatureTable = {
  "host.version": cells(false, ...CANONICAL_EVENTS),
  "prompt.origin": cells(false, "prompt.submit"),
  "tool.file-path": cells(true, "tool.before", "tool.after"),
  "inject.markup": cells(null, ...CANONICAL_EVENTS),
  "inject.inline": cells(null, ...CANONICAL_EVENTS),
  "inject.before-call": cells(null, "tool.before"),
  "block.prevents": cells(true, "prompt.submit", "tool.before"),
  "block.reason-to-agent": { ...cells(false, "prompt.submit"), ...cells(null, "tool.before") },
  "block.suppress-prompt": cells(false, "prompt.submit"),
};

const FEATURE_NOTES: HostAdapter["featureNotes"] = {
  "block.reason-to-agent": "A blocked prompt's reason is shown to the user only.",
};

export const codebuddy = claudeStyleAdapter({
  id: "codebuddy",
  name: "CodeBuddy Code",
  supports: SUPPORTS,
  features: HOST_FEATURES,
  featureNotes: FEATURE_NOTES,
  // CodeBuddy documents no override for ~/.codebuddy; HOME is what homedir() reads.
  configDir: (env) => join(env.HOME || homedir(), ".codebuddy"),
  // UserPromptSubmit blocks with continue:false; decision "block" is deprecated there.
  // `reason` is an alias of stopReason and is shown to the user only.
  blockOutput: (_event, _native, reason) => ({ continue: false, reason }),
});
