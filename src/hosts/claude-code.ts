// Claude Code adapter. Contract: https://code.claude.com/docs/en/hooks
// stdin carries session_id, transcript_path, cwd, hook_event_name and per-event
// fields (prompt, tool_name, tool_input, source). stdout JSON uses
// hookSpecificOutput.additionalContext, decision/reason and systemMessage.

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
  type Origin,
} from "../core/types.ts";
import { type HostIdentity, parseHostPayload } from "./event.ts";
import { installEntries, installedEvents, type JsonHookLayout, uninstallEntries } from "./json-config.ts";
import type { HostAdapter } from "./types.ts";

const ID = "claude-code";

const NATIVE: Record<CanonicalEvent, string | null> = {
  "prompt.submit": "UserPromptSubmit",
  "session.start": "SessionStart",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
};

const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["inject", "block", "notify"],
  "tool.after": ["inject", "block", "notify"],
};

/**
 * Feature facts, from the hooks reference (https://code.claude.com/docs/en/hooks) unless noted.
 * - host.version: the payload has no version field.
 * - prompt.origin: the <task-notification> wrapper marks system prompts (SYSTEM_PROMPT_PREFIXES).
 * - tool.file-path: Write and Edit take tool_input.file_path.
 * - inject.markup and inject.inline: additionalContext arrives as written, up to CONTEXT_CHARS.
 * - inject.before-call: PreToolUse additionalContext is added before the call runs.
 * - block.prevents: UserPromptSubmit and PreToolUse block first; PostToolUse "block" follows the tool.
 * - block.reason-to-agent: PreToolUse and PostToolUse reasons reach Claude; a blocked prompt's reason is for the user.
 * - block.suppress-prompt: hookSpecificOutput.suppressOriginalPrompt ("What a blocked prompt leaves behind").
 */
const HOST_FEATURES: FeatureTable = {
  "host.version": cells(false, ...CANONICAL_EVENTS),
  "prompt.origin": cells(true, "prompt.submit"),
  "tool.file-path": cells(true, "tool.before", "tool.after"),
  "inject.markup": cells(true, ...CANONICAL_EVENTS),
  "inject.inline": cells(true, ...CANONICAL_EVENTS),
  "inject.before-call": cells(true, "tool.before"),
  "block.prevents": { ...cells(true, "prompt.submit", "tool.before"), ...cells(false, "tool.after") },
  "block.reason-to-agent": { ...cells(false, "prompt.submit"), ...cells(true, "tool.before", "tool.after") },
  "block.suppress-prompt": cells(true, "prompt.submit"),
};

const FEATURE_NOTES: HostAdapter["featureNotes"] = {
  "block.reason-to-agent": "On a prompt the reason is shown to the user only.",
};

/** Claude Code caps hook context at 10,000 characters. */
const CONTEXT_CHARS = 10_000;

/**
 * Background-task notifications arrive as UserPromptSubmit with this wrapper.
 * Heuristic, observed in practice rather than documented.
 */
const SYSTEM_PROMPT_PREFIXES = ["<task-notification>"];

function configDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

const layout: JsonHookLayout = {
  hostId: ID,
  nativeEvents: NATIVE,
  handler: (command, timeoutSec) => ({ type: "command", command, timeout: timeoutSec }),
};

function originOf(prompt: string | undefined): Origin {
  if (prompt === undefined) return "unknown";
  const head = prompt.trimStart();
  return SYSTEM_PROMPT_PREFIXES.some((p) => head.startsWith(p)) ? "system" : "user";
}

const HOST: HostIdentity = {
  id: ID,
  name: "Claude Code",
  nativeEvents: NATIVE,
  supports: SUPPORTS,
  contextChars: CONTEXT_CHARS,
  features: HOST_FEATURES,
  featureNotes: FEATURE_NOTES,
};

export const claudeCode: HostAdapter = {
  ...HOST,
  contractVersion: 1,

  parse(event, payload) {
    return parseHostPayload(HOST, event, payload, {
      promptOrigin: (_payload, prompt) => originOf(prompt),
      canonicalTool: (name) => name,
    });
  },

  render(result: HubResult, event: HookEvent): string {
    const native = NATIVE[event.name] as string;
    const out: Record<string, unknown> = {};
    const context = joinContext(result);
    if (result.notices.length > 0) out.systemMessage = result.notices.map((n) => n.text).join("\n");
    if (result.block) {
      if (event.name === "tool.before") {
        out.hookSpecificOutput = {
          hookEventName: native,
          permissionDecision: "deny",
          permissionDecisionReason: result.block.reason,
        };
      } else {
        out.decision = "block";
        out.reason = result.block.reason;
        // suppressOriginalPrompt must sit inside hookSpecificOutput, next to the event name
        // (https://code.claude.com/docs/en/hooks.md, "What a blocked prompt leaves behind").
        if (event.name === "prompt.submit" && result.block.suppressOriginalPrompt) {
          out.hookSpecificOutput = { hookEventName: native, suppressOriginalPrompt: true };
        }
      }
    } else if (context) {
      out.hookSpecificOutput = { hookEventName: native, additionalContext: context };
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
  },

  // permissionDecision "ask" shows the permission prompt with updatedInput as the call to approve
  // (https://code.claude.com/docs/en/hooks.md, PreToolUse decision control). Claude Code 2.1.327
  // honours it under bypassPermissions too, and refuses the call where no prompt can be shown.
  confirm(_event, ask) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: NATIVE["tool.before"],
        permissionDecision: "ask",
        permissionDecisionReason: ask.reason,
        updatedInput: ask.input,
      },
    });
  },

  sample(event, prompt = "hookmux doctor check") {
    const base = {
      session_id: "hookmux-doctor",
      transcript_path: "",
      cwd: process.cwd(),
      hook_event_name: NATIVE[event],
    };
    if (event === "prompt.submit") return { ...base, prompt, permission_mode: "default" };
    if (event === "session.start") return { ...base, source: "startup" };
    if (event === "tool.before") return { ...base, tool_name: "Bash", tool_input: { command: "echo ok" } };
    return { ...base, tool_name: "Bash", tool_input: { command: "echo ok" }, tool_response: { stdout: "ok" } };
  },

  config: {
    file: (env = process.env) => join(configDir(env), "settings.json"),
    detect: (env = process.env) => existsSync(configDir(env)),
    installed(launcher, env = process.env) {
      return installedEvents(this.file(env), launcher, layout);
    },
    install(entry, env = process.env) {
      return installEntries(this.file(env), entry, layout);
    },
    uninstall(launcher, env = process.env) {
      return uninstallEntries(this.file(env), launcher, layout);
    },
  },
  skills: { global: join(configDir(process.env), "skills") },
};
