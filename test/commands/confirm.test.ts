// A promote command an agent runs in Claude Code: the hub asks the person and the
// approved command carries a one-time grant that promote accepts without a terminal.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parsePromoteCommand } from "../../src/core/promote-command.ts";
import { readTrust } from "../../src/load/trust.ts";
import { homePaths } from "../../src/runtime/paths.ts";
import { cli, moodboardCopy, runNode, type Sandbox, sandbox } from "./helpers.ts";

const SHELL_TOOLS: Record<string, string> = { codex: "shell", "qwen-code": "run_shell_command" };

/** Runs the hook as Claude Code would for one Bash call and returns its parsed stdout, or null when empty. */
async function bashHook(sb: Sandbox, command: string, host = "claude-code") {
  const payload = {
    session_id: "s1",
    transcript_path: "",
    cwd: sb.dir,
    hook_event_name: "PreToolUse",
    tool_name: SHELL_TOOLS[host] ?? "Bash",
    tool_input: { command, description: "promote" },
    tool_use_id: "t1",
  };
  const r = await runNode(sb, ["src/hook-main.ts", "--host", host, "--event", "tool.before"], JSON.stringify(payload));
  assert.equal(r.code, 0);
  return r.stdout.trim() === "" ? null : JSON.parse(r.stdout).hookSpecificOutput;
}

/** Installs the moodboard example and returns the command the person would approve for `ask`. */
async function approvedCommand(sb: Sandbox, ask: string): Promise<string[]> {
  const out = await bashHook(sb, ask);
  assert.equal(out?.permissionDecision, "ask");
  assert.equal(out.updatedInput.description, "hookmux: activate plugin moodboard", "the agent's wording is replaced");
  return (out.updatedInput.command as string).split(" ").slice(1);
}

const statusOf = async (sb: Sandbox) => JSON.parse((await cli(sb, "list", "--json")).stdout).plugins[0].status;

test("only an exact promote command is recognised", () => {
  assert.deepEqual(parsePromoteCommand("hookmux promote sushi-role"), { id: "sushi-role", standing: false });
  assert.deepEqual(parsePromoteCommand("  hookmux promote a --standing "), { id: "a", standing: true });
  for (const command of [
    "hookmux promote a; rm -rf ~",
    "hookmux promote a && echo done",
    "hookmux promote a --yes",
    "hookmux promote a --standing --grant x",
    "hookmux promote $(id)",
    "hookmux promote A",
    "sudo hookmux promote a",
    "hookmux promote",
    42,
  ]) {
    assert.equal(parsePromoteCommand(command), null, String(command));
  }
});

test("the hub asks the person and the approved command activates the plugin once", async () => {
  const sb = sandbox();
  sb.env.CLAUDECODE = "1";
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const out = await bashHook(sb, "hookmux promote moodboard --standing");
  assert.match(out.permissionDecisionReason, /approve to turn on moodboard 1\.0\.0 from .*Now: not promoted yet\./);
  assert.match(out.permissionDecisionReason, /Standing approval/);
  const args = (out.updatedInput.command as string).split(" ").slice(1);
  assert.deepEqual(args.slice(0, 4), ["promote", "moodboard", "--standing", "--grant"]);
  const done = await cli(sb, ...args);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.equal(await statusOf(sb), "active");
  const entry = readTrust(homePaths(sb.home).trust).plugins.moodboard;
  assert.deepEqual(entry?.standing?.capabilities, entry?.capabilities);
  const reused = await cli(sb, ...args);
  assert.equal(reused.code, 1);
  assert.match(reused.stdout, /unknown, already used or expired/);
});

test("a grant does not cover another plugin, another flag or changed content", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  assert.equal((await cli(sb, "add", src)).code, 0);
  const plain = await approvedCommand(sb, "hookmux promote moodboard");
  const withStanding = [...plain.slice(0, 2), "--standing", ...plain.slice(2)];
  assert.equal((await cli(sb, ...withStanding)).code, 1);
  assert.equal(await statusOf(sb), "untrusted");

  const stale = await approvedCommand(sb, "hookmux promote moodboard");
  const manifest = join(sb.home, "plugins", "moodboard", "plugin.toml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^description = .*$/m, 'description = "edited"'));
  const refused = await cli(sb, ...stale);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /changed after the approval was shown/);
  assert.equal(await statusOf(sb), "untrusted");

  assert.equal((await cli(sb, "promote", "moodboard", "--grant", "0".repeat(48))).code, 1);
});

test("the hub leaves other commands, unknown plugins and hosts that cannot ask alone", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  assert.equal(await bashHook(sb, "hookmux promote moodboard; echo more"), null);
  assert.equal(await bashHook(sb, "hookmux promote missing"), null);
  assert.equal(await bashHook(sb, "hookmux list"), null);
  assert.equal(await bashHook(sb, "hookmux promote moodboard", "codex"), null);
});

test("Qwen Code asks the person the same way, and the grant records the client", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const out = await bashHook(sb, "hookmux promote moodboard", "qwen-code");
  assert.equal(out?.permissionDecision, "ask");
  assert.equal(out.hookEventName, "PreToolUse");
  assert.equal(out.updatedInput.description, "hookmux: activate plugin moodboard");
  assert.equal(out.updatedInput.command.split(" ")[3], "--grant");
  const done = await cli(sb, ...(out.updatedInput.command as string).split(" ").slice(1));
  assert.equal(done.code, 0, done.stdout + done.stderr);
  const entry = readTrust(homePaths(sb.home).trust).plugins.moodboard;
  assert.deepEqual({ via: entry?.via, host: entry?.host }, { via: "prompt", host: "qwen-code" });
  assert.match((await cli(sb, "list")).stdout, /approved: prompt \(qwen-code\)/);
});
