// Decides whether this process may activate a plugin. A terminal on stdin is
// not proof that a person is typing (an agent can run the CLI under a
// pseudo-terminal), so the environment markers each agent client sets on the
// commands it runs are refused as well. This stops injected or accidental
// activation; it is no sandbox against a same-user process that clears its env.

/**
 * Variables an agent client sets on the shell commands its model runs.
 * Codex sources are codex-rs/ at rust-v0.167.1, Gemini CLI at v0.68.0.
 */
export const AGENT_ENV_MARKERS: readonly string[] = [
  // Claude Code is closed source: both are observed in the env of its Bash tool runs.
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  // core/src/sandboxing/mod.rs:180 (macOS seatbelt runs).
  "CODEX_SANDBOX",
  // core/src/spawn.rs:87 and core/src/sandboxing/mod.rs:172-176 (network-restricted runs).
  "CODEX_SANDBOX_NETWORK_DISABLED",
  // protocol/src/shell_environment.rs:167 (every exec env built for a thread).
  "CODEX_THREAD_ID",
  // core/src/unified_exec/process_manager.rs:1504-1505 via core/src/exec_env.rs:41-49 and
  // protocol/src/shell_environment.rs:30-40.
  "CODEX_SESSION_ID",
  "CODEX_TOOL_CALL_ID",
  "CODEX_VERSION",
  // packages/core/src/services/shellExecutionService.ts:59, set at :584 on every shell run.
  "GEMINI_CLI",
  // opencode-ai 1.19.6, packages/opencode/src/index.ts: set on its own process before any
  // session starts, and the bash tool builds its child env from that process env.
  "OPENCODE",
];

/** The client each marker belongs to, so `install` can wire the client that is running it. */
const MARKER_HOST: Readonly<Record<string, string>> = {
  CLAUDECODE: "claude-code",
  CLAUDE_CODE_ENTRYPOINT: "claude-code",
  CODEX_SANDBOX: "codex",
  CODEX_SANDBOX_NETWORK_DISABLED: "codex",
  CODEX_THREAD_ID: "codex",
  CODEX_SESSION_ID: "codex",
  CODEX_TOOL_CALL_ID: "codex",
  CODEX_VERSION: "codex",
  GEMINI_CLI: "gemini-cli",
  OPENCODE: "opencode",
};

/** The first agent marker present in `env`, or undefined when there is none. */
export function agentMarker(env: NodeJS.ProcessEnv): string | undefined {
  return AGENT_ENV_MARKERS.find((name) => env[name] !== undefined && env[name] !== "");
}

/** The host id of the agent client whose marker is in `env`, or undefined. */
export function agentHost(env: NodeJS.ProcessEnv): string | undefined {
  const marker = agentMarker(env);
  return marker === undefined ? undefined : MARKER_HOST[marker];
}

export interface ActivationContext {
  /** True when the command was given --yes. */
  assumeYes: boolean;
  interactive: boolean;
  env: NodeJS.ProcessEnv;
}

export type ActivationRefusal = "yes-flag" | "agent" | "no-terminal";

/**
 * Why this process may not activate a plugin, or undefined when it may ask.
 * Checked in this order so each refusal names the first thing to change.
 */
export function activationRefusal(ctx: ActivationContext): ActivationRefusal | undefined {
  if (ctx.assumeYes) return "yes-flag";
  if (agentMarker(ctx.env) !== undefined) return "agent";
  if (!ctx.interactive) return "no-terminal";
  return undefined;
}
