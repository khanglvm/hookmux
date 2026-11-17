// Codex adapter, written against codex-cli 0.167.1 (tag rust-v0.167.1).
// Docs: https://developers.openai.com/codex/hooks. Source paths below are
// relative to codex-rs/ in the openai/codex repo.
// Codex reads hook stdout into per-event structs marked deny_unknown_fields, so
// render emits only the keys those structs declare: one stray key voids the
// whole output and the hook counts as failed.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { joinContext } from "../core/compose.ts";
import type { CanonicalEvent, EffectKind, HookEvent, HubResult, Origin } from "../core/types.ts";
import { type HostIdentity, parseHostPayload } from "./event.ts";
import {
  ConfigEditError,
  installEntries,
  installedEvents,
  type JsonHookLayout,
  uninstallEntries,
} from "./json-config.ts";
import type { HostAdapter } from "./types.ts";

const ID = "codex";

const NATIVE: Record<CanonicalEvent, string | null> = {
  "prompt.submit": "UserPromptSubmit",
  "session.start": "SessionStart",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
};

/**
 * Every output struct flattens the universal fields, so systemMessage (shown as
 * a UI warning) works on all four events (hooks/src/schema.rs:91-100; read at
 * hooks/src/events/user_prompt_submit.rs:164, session_start.rs:258,
 * pre_tool_use.rs:224, post_tool_use.rs:198). Each hookSpecificOutput carries
 * additionalContext (schema.rs:232-256, 399-404, 445-450). SessionStart has no
 * decision field; its only control is continue:false, which aborts the session
 * start itself (events/session_start.rs:274-285), so hookmux offers no block there.
 */
const SUPPORTS: Record<CanonicalEvent, EffectKind[]> = {
  "prompt.submit": ["inject", "block", "notify"],
  "session.start": ["inject", "notify"],
  "tool.before": ["inject", "block", "notify"],
  "tool.after": ["inject", "block", "notify"],
};

/**
 * Codex moves additionalContext over 2,500 approximate tokens into a file and
 * shows the model a preview (hooks/src/output_spill.rs:13, 65-104), counting 4
 * bytes per token (utils/string/src/truncate.rs:94-97). 10,000 characters stays
 * inline for ASCII text; multibyte text can spill sooner.
 */
const CONTEXT_CHARS = 10_000;

/**
 * Codex fails a block whose reason is empty after trimming, and the prompt or
 * tool call then goes ahead (hooks/src/engine/output_parser.rs:365-367, 514-520).
 */
const FALLBACK_BLOCK_REASON = "Blocked by a hookmux plugin.";

/** apply_patch carries every file edit as patch text in tool_input.command (core/src/tools/handlers/apply_patch.rs:370-375). */
const CANONICAL_TOOLS: Readonly<Record<string, string>> = { apply_patch: "Edit" };

/** hooks.json root is HooksFile with deny_unknown_fields (config/src/hook_config.rs:12-19). */
const ROOT_KEYS = new Set(["description", "hooks"]);

/** Untrusted new or changed hooks are skipped (hooks/src/engine/discovery.rs:917-940). */
const APPROVAL_NOTE = "Codex skips new hook entries until you approve them once with /hooks in the Codex TUI";

/** CODEX_HOME wins when set and non-empty (utils/home-dir/src/lib.rs:13-17, 51-59). */
function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Any other root key makes Codex skip the whole file with only a warning
 * (hooks/src/engine/discovery.rs:410-419), so hookmux refuses to edit it.
 */
function checkRoot(config: Record<string, unknown>, file: string): void {
  const foreign = Object.keys(config).filter((key) => !ROOT_KEYS.has(key));
  if (foreign.length === 0) return;
  throw new ConfigEditError(
    `${file} has root keys Codex does not accept (${foreign.join(", ")}); Codex ignores the whole file until they are removed`,
  );
}

const layout: JsonHookLayout = {
  hostId: ID,
  nativeEvents: NATIVE,
  // timeout is in seconds (protocol/src/hooks.rs:152-172). No statusMessage:
  // it would show on every run, and changing it later re-triggers approval.
  handler: (command, timeoutSec) => ({ type: "command", command, timeout: timeoutSec }),
  checkRoot,
  // Approval is keyed by (event, group index, handler index) (hooks/src/engine/discovery.rs:632,
  // 650, 811), so a removed hub group keeps its slot. An empty group is valid: MatcherGroup.hooks
  // is a #[serde(default)] Vec (protocol/src/hooks.rs:140-146) and its handler loop just runs zero
  // times (discovery.rs:650).
  preserveGroupPositions: true,
};

/**
 * Codex fires UserPromptSubmit only for user input items (core/src/hook_runtime.rs:712-746).
 * Inside a thread-spawned subagent the payload adds agent_id (core/src/hook_runtime.rs:717,
 * 1083-1093; hooks/src/schema.rs:568-576). The parent agent's spawn_agent and send_input
 * messages arrive there as user input (core/src/tools/handlers/multi_agents/spawn.rs:71,119;
 * core/src/agent/control.rs:138-147), so such a prompt counts as system. A person typing
 * into a subagent thread is indistinguishable and is treated the same way.
 */
function originOf(payload: Record<string, unknown>, prompt: string | undefined): Origin {
  if (prompt === undefined) return "unknown";
  return typeof payload.agent_id === "string" ? "system" : "user";
}

function reasonOf(reason: string): string {
  return reason.trim() === "" ? FALLBACK_BLOCK_REASON : reason;
}

/**
 * PreToolUse denies through hookSpecificOutput (hooks/src/schema.rs:245-256); a bare
 * "allow" is rejected (hooks/src/engine/output_parser.rs:449-456). UserPromptSubmit and PostToolUse take
 * decision:"block" plus reason (schema.rs:147-156, 431-441). Codex has no
 * suppressOriginalPrompt key: it never records a blocked prompt (core/src/session/turn.rs:1007-1010).
 */
function blockOutput(event: CanonicalEvent, native: string, reason: string): Record<string, unknown> {
  if (event === "tool.before") {
    return {
      hookSpecificOutput: { hookEventName: native, permissionDecision: "deny", permissionDecisionReason: reason },
    };
  }
  return { decision: "block", reason };
}

const HOST: HostIdentity = {
  id: ID,
  name: "Codex",
  nativeEvents: NATIVE,
  supports: SUPPORTS,
  contextChars: CONTEXT_CHARS,
};

export const codex: HostAdapter = {
  ...HOST,
  contractVersion: 1,

  // Codex puts no version in the payload or the hook env (hooks/src/schema.rs:568-584;
  // env is the Codex process env, hooks/src/registry.rs:83), so version stays null.
  parse(event, payload) {
    return parseHostPayload(HOST, event, payload, {
      promptOrigin: originOf,
      canonicalTool: (name) => CANONICAL_TOOLS[name] ?? name,
    });
  },

  render(result: HubResult, event: HookEvent): string {
    const native = NATIVE[event.name] as string;
    const supports = SUPPORTS[event.name];
    const out: Record<string, unknown> = {};
    if (result.notices.length > 0 && supports.includes("notify")) {
      out.systemMessage = result.notices.map((n) => n.text).join("\n");
    }
    const context = joinContext(result);
    if (result.block && supports.includes("block")) {
      Object.assign(out, blockOutput(event.name, native, reasonOf(result.block.reason)));
    } else if (context && supports.includes("inject")) {
      // hookEventName is required and must match the event (hooks/src/schema.rs:445-450).
      out.hookSpecificOutput = { hookEventName: native, additionalContext: context };
    }
    return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
  },

  // Field sets follow the stdin structs (hooks/src/schema.rs:279-297, 324-343, 500-511, 568-584).
  sample(event, prompt = "hookmux doctor check") {
    const base = {
      session_id: "hookmux-doctor",
      transcript_path: null,
      cwd: process.cwd(),
      hook_event_name: NATIVE[event],
      model: "hookmux-doctor",
      permission_mode: "default",
    };
    if (event === "session.start") return { ...base, source: "startup" };
    const turn = { ...base, turn_id: "hookmux-doctor-turn" };
    if (event === "prompt.submit") return { ...turn, prompt };
    const tool = { ...turn, tool_name: "Bash", tool_input: { command: "echo ok" }, tool_use_id: "hookmux-doctor-call" };
    return event === "tool.before" ? tool : { ...tool, tool_response: "ok\n" };
  },

  config: {
    file: (env = process.env) => join(codexHome(env), "hooks.json"),
    detect: (env = process.env) => existsSync(codexHome(env)),
    installed(launcher, env = process.env) {
      return installedEvents(this.file(env), launcher, layout);
    },
    install(entry, env = process.env) {
      const change = installEntries(this.file(env), entry, layout);
      change.notes.push(APPROVAL_NOTE);
      return change;
    },
    uninstall(launcher, env = process.env) {
      return uninstallEntries(this.file(env), launcher, layout);
    },
  },
  // ~/.agents/skills is the user skill root; $CODEX_HOME/skills is kept only as a
  // deprecated location (ext/skills/src/host_roots.rs:134-147).
  skills: { global: join(homedir(), ".agents", "skills") },
};
