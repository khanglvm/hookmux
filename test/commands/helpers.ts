// Test sandbox: every CLI run is a subprocess whose HOME, HOOKMUX_HOME and host
// config folders point into a fresh temp folder, so no test can touch the real
// ~/.claude, ~/.codex, ~/.gemini or ~/.hookmux, and stdin is never a terminal.
// Agent markers are stripped so results do not depend on the client running the tests.

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../src/checks/index.ts";
import { AGENT_ENV_MARKERS } from "../../src/commands/lib/agent-env.ts";
import { compileRegistry } from "../../src/load/registry.ts";
import { readTrust, writeTrust } from "../../src/load/trust.ts";
import { homePaths } from "../../src/runtime/paths.ts";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const MOODBOARD = join(ROOT, "examples", "moodboard");

export interface Sandbox {
  dir: string;
  home: string;
  claude: string;
  env: NodeJS.ProcessEnv;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-cli-"));
  const claude = join(dir, "claude");
  mkdirSync(claude);
  mkdirSync(join(dir, "user"));
  const { HOOKMUX_DISABLE: _off, HOOKMUX_DEBUG: _debug, ...base } = process.env;
  for (const name of AGENT_ENV_MARKERS) delete base[name];
  const env = {
    ...base,
    HOME: join(dir, "user"),
    HOOKMUX_HOME: join(dir, "hookmux"),
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: join(dir, "user", ".codex"),
    NO_COLOR: "1",
  };
  return { dir, home: env.HOOKMUX_HOME, claude, env };
}

/** Runs a node script (default: the CLI from source) with stdin piped, never a terminal. */
export function runNode(sb: Sandbox, args: string[], input = ""): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: sb.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

export function cli(sb: Sandbox, ...args: string[]): Promise<RunResult> {
  return runNode(sb, ["src/cli.ts", ...args]);
}

/** Copies the moodboard example into the sandbox, as a plugin source folder. */
export function moodboardCopy(sb: Sandbox, name = "moodboard-src"): string {
  const dir = join(sb.dir, name);
  cpSync(MOODBOARD, dir, { recursive: true });
  return dir;
}

/** Pins an installed plugin's current content and capabilities, standing in for an interactive promote. */
export function trustInstalled(sb: Sandbox, id: string): void {
  const paths = homePaths(sb.home);
  const entry = compileRegistry(paths).plugins.find((p) => p.id === id);
  if (!entry?.hash) throw new Error(`cannot trust ${id}: ${entry?.problem ?? "not installed"}`);
  const store = readTrust(paths.trust);
  store.plugins[id] = { hash: entry.hash, capabilities: entry.capabilities, promotedAt: "test" };
  writeTrust(paths.trust, store);
}
