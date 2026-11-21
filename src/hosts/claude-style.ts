// Builds adapters for clients that copied Claude Code's hook contract: the same
// native event names, the same nested JSON config, and hookSpecificOutput,
// systemMessage and permissionDecision on stdout. Each client still differs in
// where its config lives, how it blocks a prompt, which events can block, and
// its tool names; a ClaudeStyleSpec states exactly those differences.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { joinContext } from "../core/compose.ts";
import type { CanonicalEvent, EffectKind, HookEvent, HubResult, Origin } from "../core/types.ts";
import { type HostIdentity, parseHostPayload } from "./event.ts";
import { installEntries, installedEvents, type JsonHookLayout, uninstallEntries } from "./json-config.ts";
import type { HostAdapter, HostConfigEditor } from "./types.ts";

/** The native event names every Claude-style client shares. */
export const CLAUDE_EVENTS: Readonly<Record<CanonicalEvent, string>> = {
  "prompt.submit": "UserPromptSubmit",
  "session.start": "SessionStart",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
};

/** hookmux's context budget on these clients, the same as Claude Code's cap. */
const DEFAULT_CONTEXT_CHARS = 10_000;

/** A block on an event that blocks; everything else about rendering is shared. */
export type BlockRenderer = (event: CanonicalEvent, native: string, reason: string) => Record<string, unknown>;

export interface ClaudeStyleSpec {
  id: string;
  name: string;
  supports: Record<CanonicalEvent, EffectKind[]>;
  /** The client's user-level config folder, after its own env override. */
  configDir(env: NodeJS.ProcessEnv): string;
  /** Renders a block for prompt.submit and tool.after; tool.before always denies through permissionDecision. */
  blockOutput: BlockRenderer;
  /** Client tool name to hookmux's portable name; names not listed pass through. */
  canonicalTools?: Readonly<Record<string, string>>;
  /** Origin of a prompt payload; defaults to "user" whenever a prompt is present. */
  promptOrigin?(payload: Record<string, unknown>, prompt: string | undefined): Origin;
  /** Replaces the default single settings.json editor. */
  config?: HostConfigEditor;
  /** Note printed after each install, such as a trust step the client needs. */
  installNote?: string;
  /** Global skills folder, when the client documents one. */
  skillsDir?(env: NodeJS.ProcessEnv): string;
  /** Shell tool name used in sample payloads. */
  sampleShellTool?: string;
  /** Extra fields a real user prompt carries, so a sample prompt parses with origin "user". */
  samplePromptFields?(prompt: string): Record<string, unknown>;
}

/** The Claude Code handler shape; every client here takes the timeout in seconds. */
export function claudeLayout(hostId: string, rootTable = false): JsonHookLayout {
  return {
    hostId,
    nativeEvents: CLAUDE_EVENTS,
    handler: (command, timeoutSec) => ({ type: "command", command, timeout: timeoutSec }),
    rootTable,
  };
}

/** Deny before a tool call; the clients here all read permissionDecision under hookSpecificOutput. */
function denyTool(native: string, reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: native, permissionDecision: "deny", permissionDecisionReason: reason },
  };
}

/** Context always names its event: Qoder and Droid reject hookSpecificOutput without a matching hookEventName. */
export function renderClaudeStyle(spec: ClaudeStyleSpec, result: HubResult, event: HookEvent): string {
  const supports = spec.supports[event.name];
  const native = CLAUDE_EVENTS[event.name];
  const out: Record<string, unknown> = {};
  if (result.notices.length > 0 && supports.includes("notify")) {
    out.systemMessage = result.notices.map((n) => n.text).join("\n");
  }
  const context = joinContext(result);
  if (result.block && supports.includes("block")) {
    const reason = result.block.reason;
    Object.assign(
      out,
      event.name === "tool.before" ? denyTool(native, reason) : spec.blockOutput(event.name, native, reason),
    );
  } else if (context && supports.includes("inject")) {
    out.hookSpecificOutput = { hookEventName: native, additionalContext: context };
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

function sampleFor(spec: ClaudeStyleSpec, event: CanonicalEvent, prompt: string): Record<string, unknown> {
  const base = {
    session_id: "hookmux-doctor",
    transcript_path: "",
    cwd: process.cwd(),
    hook_event_name: CLAUDE_EVENTS[event],
  };
  if (event === "prompt.submit") return { ...base, prompt, ...spec.samplePromptFields?.(prompt) };
  if (event === "session.start") return { ...base, source: "startup" };
  const tool = { ...base, tool_name: spec.sampleShellTool ?? "Bash", tool_input: { command: "echo ok" } };
  return event === "tool.before" ? tool : { ...tool, tool_response: { stdout: "ok" } };
}

function settingsEditor(spec: ClaudeStyleSpec): HostConfigEditor {
  const layout = claudeLayout(spec.id);
  return {
    file: (env = process.env) => join(spec.configDir(env), "settings.json"),
    detect: (env = process.env) => existsSync(spec.configDir(env)),
    installed(launcher, env = process.env) {
      return installedEvents(this.file(env), launcher, layout);
    },
    install(entry, env = process.env) {
      return installEntries(this.file(env), entry, layout);
    },
    uninstall(launcher, env = process.env) {
      return uninstallEntries(this.file(env), launcher, layout);
    },
  };
}

/** Builds a full adapter from the differences in `spec`. */
export function claudeStyleAdapter(spec: ClaudeStyleSpec): HostAdapter {
  const host: HostIdentity = {
    id: spec.id,
    name: spec.name,
    nativeEvents: CLAUDE_EVENTS,
    supports: spec.supports,
    contextChars: DEFAULT_CONTEXT_CHARS,
  };
  const tools = spec.canonicalTools ?? {};
  const base = spec.config ?? settingsEditor(spec);
  const config: HostConfigEditor = spec.installNote
    ? {
        ...base,
        install(entry, env) {
          const change = base.install(entry, env);
          change.notes.push(spec.installNote as string);
          return change;
        },
      }
    : base;
  return {
    ...host,
    contractVersion: 1,
    parse(event, payload) {
      return parseHostPayload(host, event, payload, {
        promptOrigin: spec.promptOrigin ?? ((_payload, prompt) => (prompt === undefined ? "unknown" : "user")),
        canonicalTool: (name) => (Object.hasOwn(tools, name) ? (tools[name] as string) : name),
      });
    },
    render: (result, event) => renderClaudeStyle(spec, result, event),
    sample: (event, prompt = "hookmux doctor check") => sampleFor(spec, event, prompt),
    config,
    ...(spec.skillsDir ? { skills: { global: spec.skillsDir(process.env) } } : {}),
  };
}
