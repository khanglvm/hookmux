// CodeBuddy Code adapter, written from https://www.codebuddy.ai/docs/cli/hooks
// for CodeBuddy Code 2.185.0 (hooks shipped in 1.16.0, still marked beta).
// CodeBuddy takes Claude Code's hook contract and tool names; it blocks a
// prompt with continue:false and cannot block after a tool.

import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent, EffectKind } from "../core/types.ts";
import { claudeStyleAdapter } from "./claude-style.ts";

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

export const codebuddy = claudeStyleAdapter({
  id: "codebuddy",
  name: "CodeBuddy Code",
  supports: SUPPORTS,
  // CodeBuddy documents no override for ~/.codebuddy; HOME is what homedir() reads.
  configDir: (env) => join(env.HOME || homedir(), ".codebuddy"),
  // UserPromptSubmit blocks with continue:false; decision "block" is deprecated there.
  // `reason` is an alias of stopReason and is shown to the user only.
  blockOutput: (_event, _native, reason) => ({ continue: false, reason }),
});
