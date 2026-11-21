// Qwen Code adapter, written from docs/users/features/hooks.md and
// docs/users/configuration/settings.md in QwenLM/qwen-code (main at d193e52,
// release 0.28.0). Qwen Code takes Claude Code's hook contract; the
// differences are its config folder, its tool names and which prompts count
// as the user's.

import { homedir } from "node:os";
import { join } from "node:path";
import { cells, type FeatureTable } from "../core/features.ts";
import { CANONICAL_EVENTS, type CanonicalEvent, type EffectKind, type Origin } from "../core/types.ts";
import { claudeStyleAdapter } from "./claude-style.ts";
import type { HostAdapter } from "./types.ts";

/**
 * PreToolUse additionalContext is appended to that call's tool result, and PostToolUse
 * reads decision "block" with a reason (hooks.md, "PreToolUse" and "PostToolUse").
 * SessionStart output has no decision. systemMessage is a common field on every event.
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["inject", "block", "notify"],
  "tool.after": ["inject", "block", "notify"],
};

/**
 * Feature facts, from hooks.md and tool-names.ts at the release named at the top of this file.
 * - host.version: the documented payload has no version field.
 * - prompt.origin: submitted_prompt marks a real submission (see originOf).
 * - tool.file-path: write_file and edit take file_path (CANONICAL_TOOLS).
 * - inject.markup: < and > in added context are escaped (hooks.md).
 * - inject.before-call: PreToolUse additionalContext is appended to the tool result, not shown first.
 * - block.prevents: UserPromptSubmit and PreToolUse block first; PostToolUse "block" follows the tool.
 * - block.suppress-prompt: no such key in the hook output.
 * Unknown: inline limits and who sees a block reason.
 */
const HOST_FEATURES: FeatureTable = {
  "host.version": cells(false, ...CANONICAL_EVENTS),
  "prompt.origin": cells(true, "prompt.submit"),
  "tool.file-path": cells(true, "tool.before", "tool.after"),
  "inject.markup": cells(false, ...CANONICAL_EVENTS),
  "inject.inline": cells(null, ...CANONICAL_EVENTS),
  "inject.before-call": cells(false, "tool.before"),
  "block.prevents": { ...cells(true, "prompt.submit", "tool.before"), ...cells(false, "tool.after") },
  "block.reason-to-agent": cells(null, "prompt.submit", "tool.before", "tool.after"),
  "block.suppress-prompt": cells(false, "prompt.submit"),
};

const FEATURE_NOTES: HostAdapter["featureNotes"] = {
  "inject.before-call": "Context added before a tool call is appended to that call's result.",
  "inject.markup": "< and > in added context are escaped.",
};

/** Built-in tool names from packages/core/src/tools/tool-names.ts. Others pass through. */
const CANONICAL_TOOLS: Readonly<Record<string, string>> = {
  run_shell_command: "Bash",
  write_file: "Write",
  edit: "Edit",
  read_file: "Read",
};

/** QWEN_HOME replaces ~/.qwen itself; an empty value counts as unset (settings.md, environment variables). */
function qwenDir(env: NodeJS.ProcessEnv): string {
  return env.QWEN_HOME || join(homedir(), ".qwen");
}

/**
 * UserPromptSubmit also fires for tool results and other continuation sends, where
 * `prompt` is model-bound text. Qwen adds `submitted_prompt` only at a real
 * submission (TUI input, first headless query, a declared ACP turn), so its absence
 * marks the send as the system's. Vim-mode input and undeclared ACP clients also
 * omit it and are treated the same way. `prompt` stays the checked text, because it
 * carries expanded pastes that `submitted_prompt` keeps as placeholders.
 */
function originOf(payload: Record<string, unknown>, prompt: string | undefined): Origin {
  if (prompt === undefined) return "unknown";
  return typeof payload.submitted_prompt === "string" ? "user" : "system";
}

export const qwenCode = claudeStyleAdapter({
  id: "qwen-code",
  name: "Qwen Code",
  supports: SUPPORTS,
  features: HOST_FEATURES,
  featureNotes: FEATURE_NOTES,
  configDir: qwenDir,
  // UserPromptSubmit and PostToolUse read top-level decision "block" with reason.
  blockOutput: (_event, _native, reason) => ({ decision: "block", reason }),
  canonicalTools: CANONICAL_TOOLS,
  // hooks.md, "PreToolUse" > "Output Options": permissionDecision "ask" pauses and asks the user, and
  // "no permission rule, approval mode (including YOLO), or PermissionRequest hook can approve the call
  // instead"; headless runs and ACP deny it. "Replacing the tool input" says updatedInput replaces the
  // whole input, which is why the full input is sent back. Read from the docs at the release above and
  // not yet run against a live client.
  confirmOutput: (native, reason, input) => ({
    hookSpecificOutput: {
      hookEventName: native,
      permissionDecision: "ask",
      permissionDecisionReason: reason,
      updatedInput: input,
    },
  }),
  promptOrigin: originOf,
  // hooks.md, "UserPromptSubmit": submitted_prompt is the captured submission, while prompt is the
  // model-bound text with pastes, files and command bodies expanded. A relayed approval reads the former.
  submittedPrompt: (payload) => (typeof payload.submitted_prompt === "string" ? payload.submitted_prompt : undefined),
  // Skills are global state under QWEN_HOME (settings.md, QWEN_HOME row).
  skillsDir: (env) => join(qwenDir(env), "skills"),
  sampleShellTool: "run_shell_command",
  samplePromptFields: (prompt) => ({ submitted_prompt: prompt }),
});
