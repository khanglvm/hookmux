// Qoder CLI adapter, written from https://docs.qoder.com/cli/hooks for Qoder
// CLI 1.1.94. Qoder takes Claude Code's hook contract and Claude Code's tool
// names; it blocks a prompt with decision "deny" and cannot block after a tool.

import { homedir } from "node:os";
import { join } from "node:path";
import { cells, type FeatureTable } from "../core/features.ts";
import { CANONICAL_EVENTS, type CanonicalEvent, type EffectKind } from "../core/types.ts";
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
 * Feature facts, from the hooks documentation named at the top of this file.
 * - host.version: the documented payload has no version field.
 * - prompt.origin: nothing in a prompt payload marks its source.
 * - tool.file-path: Claude Code's tool names, so Write and Edit take file_path.
 * - block.prevents: exit 2 and decision "deny" stop UserPromptSubmit and PreToolUse before they run.
 * - block.suppress-prompt: no such key.
 * Unknown: markup, inline limits, pre-call context and who sees a block reason. PostToolUse cannot block,
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
  "block.reason-to-agent": cells(null, "prompt.submit", "tool.before"),
  "block.suppress-prompt": cells(false, "prompt.submit"),
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
  features: HOST_FEATURES,
  configDir: qoderDir,
  // Top-level decision takes "allow" or "deny"; "deny" acts as exit 2 ("Common stdout JSON fields").
  blockOutput: (_event, _native, reason) => ({ decision: "deny", reason }),
});
