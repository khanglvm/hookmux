// Gemini CLI adapter, written against v0.68.0. Docs: docs/hooks/reference.md in
// google-gemini/gemini-cli. Source paths below are relative to packages/ in that repo.
// Gemini turns non-JSON stdout into a user-visible systemMessage, a warning on
// exit 1, and a deny on any other non-zero exit (core/src/hooks/hookRunner.ts:455,
// 537-560), so render prints one JSON object or nothing.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinContext } from "../core/compose.ts";
import { cells, type FeatureTable } from "../core/features.ts";
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  type EffectKind,
  type HookEvent,
  type HubResult,
} from "../core/types.ts";
import { type HostIdentity, parseHostPayload } from "./event.ts";
import { installEntries, installedEvents, type JsonHookLayout, uninstallEntries } from "./json-config.ts";
import type { HostAdapter } from "./types.ts";

const ID = "gemini-cli";

const NATIVE: Record<CanonicalEvent, string | null> = {
  "prompt.submit": "BeforeAgent",
  "session.start": "SessionStart",
  "tool.before": "BeforeTool",
  "tool.after": "AfterTool",
};

/**
 * systemMessage reaches the UI on every event (core/src/hooks/hookEventHandler.ts:462-470).
 * BeforeAgent reads stop, deny and additionalContext (core/src/core/client.ts:196-219).
 * SessionStart reads neither continue nor decision, so it cannot block
 * (cli/src/gemini.tsx:954-975). BeforeTool never reads additionalContext
 * (core/src/scheduler/hook-utils.ts:50-80). AfterTool reads deny and
 * additionalContext (core/src/core/coreToolHookTriggers.ts:207-237).
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["block", "notify"],
  "tool.after": ["inject", "block", "notify"],
};

/**
 * Feature facts, from the Gemini CLI source named at the top of this file.
 * - host.version: no version in the payload (core/src/hooks/types.ts:141-147).
 * - prompt.origin: every BeforeAgent prompt counts as the user's (see parse).
 * - inject.markup: < and > are escaped (core/src/hooks/types.ts:263-277).
 * - inject.inline: no output cap (core/src/hooks/hookRunner.ts:424-431).
 * - block.prevents: BeforeAgent and BeforeTool deny first (core/src/core/client.ts:196-219;
 *   core/src/scheduler/hook-utils.ts:50-80); AfterTool denies after the tool ran
 *   (core/src/core/coreToolHookTriggers.ts:207-237).
 * - block.suppress-prompt: decision "deny" drops the prompt from history (core/src/core/client.ts:965-981).
 * Unknown: file_path in every edit tool, and who sees a block reason. BeforeTool cannot inject, so the
 * inject.before-call cell is derived.
 */
const HOST_FEATURES: FeatureTable = {
  "host.version": cells(false, ...CANONICAL_EVENTS),
  "prompt.origin": cells(false, "prompt.submit"),
  "tool.file-path": cells(null, "tool.before", "tool.after"),
  "inject.markup": cells(false, "prompt.submit", "session.start", "tool.after"),
  "inject.inline": cells(true, "prompt.submit", "session.start", "tool.after"),
  "inject.before-call": {},
  "block.prevents": { ...cells(true, "prompt.submit", "tool.before"), ...cells(false, "tool.after") },
  "block.reason-to-agent": cells(null, "prompt.submit", "tool.before", "tool.after"),
  "block.suppress-prompt": cells(true, "prompt.submit"),
};

const FEATURE_NOTES: HostAdapter["featureNotes"] = {
  "inject.markup": "< and > are escaped and the context is wrapped in hook_context tags.",
};

/** Gemini sets no output cap (core/src/hooks/hookRunner.ts:424-431); hookmux keeps the Claude-sized budget. */
const CONTEXT_CHARS = 10_000;

const MS_PER_SECOND = 1000;

/** Names the entry for /hooks enable|disable and hooksConfig.disabled (core/src/hooks/types.ts:121-125). */
const HANDLER_NAME = "hookmux";

/** Built-in tool names (core/src/tools/definitions/base-declarations.ts:30-65). MCP and other tools pass through. */
const CANONICAL_TOOLS: Readonly<Record<string, string>> = {
  run_shell_command: "Bash",
  write_file: "Write",
  replace: "Edit",
  read_file: "Read",
  glob: "Glob",
  grep_search: "Grep",
  list_directory: "LS",
};

/**
 * In an untrusted folder Gemini loads no settings hooks at all, user-level ones
 * included (core/src/hooks/hookRegistry.ts:172-187).
 */
const TRUST_NOTE = "Gemini CLI runs these hooks only in folders you have marked as trusted";

/** GEMINI_CLI_HOME replaces the home dir that holds .gemini (core/src/utils/paths.ts:22-28; core/src/config/storage.ts:78-80). */
function geminiDir(env: NodeJS.ProcessEnv): string {
  return join(env.GEMINI_CLI_HOME || homedir(), ".gemini");
}

// Gemini strips comments from settings.json before parsing (cli/src/config/settings.ts:958).
// json-config refuses a file with comments as invalid JSON, so it never drops them.
const layout: JsonHookLayout = {
  hostId: ID,
  nativeEvents: NATIVE,
  // timeout is in milliseconds (core/src/hooks/hookRunner.ts:36, 313).
  handler: (command, timeoutSec) => ({
    type: "command",
    name: HANDLER_NAME,
    command,
    timeout: timeoutSec * MS_PER_SECOND,
  }),
};

/**
 * BeforeAgent: decision "deny" drops the message from history, while
 * continue:false keeps it (core/src/core/client.ts:965-981). Tool events deny with
 * decision plus reason; continue:false there would stop the whole agent loop
 * (core/src/scheduler/hook-utils.ts:54-71; core/src/core/coreToolHookTriggers.ts:195-217).
 */
function blockOutput(event: CanonicalEvent, reason: string, suppressOriginalPrompt: boolean): Record<string, unknown> {
  if (event === "prompt.submit" && !suppressOriginalPrompt) return { continue: false, stopReason: reason };
  return { decision: "deny", reason };
}

const HOST: HostIdentity = {
  id: ID,
  name: "Gemini CLI",
  nativeEvents: NATIVE,
  supports: SUPPORTS,
  contextChars: CONTEXT_CHARS,
  features: HOST_FEATURES,
  featureNotes: FEATURE_NOTES,
};

export const geminiCli: HostAdapter = {
  ...HOST,
  contractVersion: 1,

  // The payload carries no version and the hook env adds none (core/src/hooks/types.ts:141-147;
  // core/src/hooks/hookRunner.ts:347-356), so version stays null. BeforeAgent also re-fires
  // with an AfterAgent retry reason as its prompt (core/src/core/client.ts:1052-1058), with
  // no field that marks it, so every prompt counts as the user's.
  parse(event, payload) {
    return parseHostPayload(HOST, event, payload, {
      promptOrigin: (_payload, prompt) => (prompt === undefined ? "unknown" : "user"),
      canonicalTool: (name) => CANONICAL_TOOLS[name] ?? name,
    });
  },

  render(result: HubResult, event: HookEvent): string {
    const supports = SUPPORTS[event.name];
    const out: Record<string, unknown> = {};
    if (result.notices.length > 0 && supports.includes("notify")) {
      out.systemMessage = result.notices.map((n) => n.text).join("\n");
    }
    const context = joinContext(result);
    if (result.block && supports.includes("block")) {
      Object.assign(out, blockOutput(event.name, result.block.reason, result.block.suppressOriginalPrompt));
    } else if (context && supports.includes("inject")) {
      // Gemini escapes < and > in additionalContext to &lt; and &gt; before the model
      // sees it (core/src/hooks/types.ts:263-277), so markup arrives as text.
      out.hookSpecificOutput = { hookEventName: NATIVE[event.name], additionalContext: context };
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
  },

  // Field sets follow the input types (core/src/hooks/types.ts:141-147, 498-503, 518-524, 547-549, 616-618).
  sample(event, prompt = "hookmux doctor check") {
    const base = {
      session_id: "hookmux-doctor",
      transcript_path: "",
      cwd: process.cwd(),
      hook_event_name: NATIVE[event],
      timestamp: new Date().toISOString(),
    };
    if (event === "prompt.submit") return { ...base, prompt };
    if (event === "session.start") return { ...base, source: "startup" };
    const tool = { ...base, tool_name: "run_shell_command", tool_input: { command: "echo ok" } };
    return event === "tool.before" ? tool : { ...tool, tool_response: { llmContent: "ok", returnDisplay: "ok" } };
  },

  config: {
    file: (env = process.env) => join(geminiDir(env), "settings.json"),
    detect: (env = process.env) => existsSync(geminiDir(env)),
    installed(launcher, env = process.env) {
      return installedEvents(this.file(env), launcher, layout);
    },
    install(entry, env = process.env) {
      const change = installEntries(this.file(env), entry, layout);
      change.notes.push(TRUST_NOTE);
      return change;
    },
    uninstall(launcher, env = process.env) {
      return uninstallEntries(this.file(env), launcher, layout);
    },
  },
  // Gemini loads user skills from ~/.gemini/skills (core/src/config/storage.ts:142-143;
  // core/src/skills/skillManager.ts:72).
  skills: { global: join(geminiDir(process.env), "skills") },
};
