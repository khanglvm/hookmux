// Qoder CLI adapter, written from https://docs.qoder.com/cli/hooks for Qoder
// CLI 1.1.94. Qoder takes Claude Code's hook contract and Claude Code's tool
// names; it blocks a prompt with decision "deny" and cannot block after a tool.

import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent, EffectKind } from "../core/types.ts";
import { claudeStyleAdapter } from "./claude-style.ts";

/**
 * Exit 2 blocks only UserPromptSubmit and PreToolUse among these events (the event
 * table in "Hook events"). PostToolUse takes additionalContext and no decision.
 * systemMessage is a common field shown to the user only.
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["inject", "block", "notify"],
  "tool.after": ["inject", "notify"],
};

/**
 * QODER_CONFIG_DIR selects the user data directory in place of ~/.qoder
 * (/cli/sdk/session-control, "User data directory"). The docs do not say outright
 * that settings.json moves with it; this follows Claude Code's CLAUDE_CONFIG_DIR.
 */
function qoderDir(env: NodeJS.ProcessEnv): string {
  return env.QODER_CONFIG_DIR || join(homedir(), ".qoder");
}

export const qoder = claudeStyleAdapter({
  id: "qoder",
  name: "Qoder CLI",
  supports: SUPPORTS,
  configDir: qoderDir,
  // Top-level decision takes "allow" or "deny"; "deny" acts as exit 2 ("Common stdout JSON fields").
  blockOutput: (_event, _native, reason) => ({ decision: "deny", reason }),
});
