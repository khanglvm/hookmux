// Qwen Code adapter, written from docs/users/features/hooks.md and
// docs/users/configuration/settings.md in QwenLM/qwen-code (main at d193e52,
// release 0.28.0). Qwen Code takes Claude Code's hook contract; the
// differences are its config folder, its tool names and which prompts count
// as the user's.

import { homedir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent, EffectKind, Origin } from "../core/types.ts";
import { claudeStyleAdapter } from "./claude-style.ts";

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
  configDir: qwenDir,
  // UserPromptSubmit and PostToolUse read top-level decision "block" with reason.
  blockOutput: (_event, _native, reason) => ({ decision: "block", reason }),
  canonicalTools: CANONICAL_TOOLS,
  promptOrigin: originOf,
  // Skills are global state under QWEN_HOME (settings.md, QWEN_HOME row).
  skillsDir: (env) => join(qwenDir(env), "skills"),
  sampleShellTool: "run_shell_command",
  samplePromptFields: (prompt) => ({ submitted_prompt: prompt }),
});
