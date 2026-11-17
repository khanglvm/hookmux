// Claude Code adapter. Contract: https://code.claude.com/docs/en/hooks
// stdin carries session_id, transcript_path, cwd, hook_event_name and per-event
// fields (prompt, tool_name, tool_input, source). stdout JSON uses
// hookSpecificOutput.additionalContext, decision/reason and systemMessage.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinContext } from "../core/compose.ts";
import type { CanonicalEvent, EffectKind, HookEvent, HubResult, Origin } from "../core/types.ts";
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
        if (event.name === "prompt.submit" && result.block.suppressOriginalPrompt) out.suppressOriginalPrompt = true;
      }
    } else if (context) {
      out.hookSpecificOutput = { hookEventName: native, additionalContext: context };
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
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
