// init, doctor and uninstall against the built bundle. This file owns the
// build step (it deletes and rewrites dist/); no other test file reads dist/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { cli, MOODBOARD, ROOT, runNode, type Sandbox, sandbox, trustInstalled } from "./helpers.ts";

const DIST_CLI = join(ROOT, "dist", "cli.mjs");

before(() => {
  execFileSync(process.execPath, ["scripts/build.ts"], { cwd: ROOT, stdio: "ignore" });
});

function built(sb: Sandbox, ...args: string[]) {
  return runNode(sb, [DIST_CLI, ...args]);
}

function settings(sb: Sandbox): { hooks?: Record<string, { hooks: { command: string }[] }[]> } {
  return JSON.parse(readFileSync(join(sb.claude, "settings.json"), "utf8"));
}

test("init wires Claude Code in an empty home, and a second run changes nothing", async () => {
  const sb = sandbox();
  const first = await built(sb, "init", "--yes", "--no-skill");
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /✓ Claude Code: added prompt\.submit, session\.start/);
  assert.equal(readlinkSync(join(sb.home, "engine", "current")), "0.1.0");
  const launcher = readFileSync(join(sb.home, "bin", "hookmux-hook"), "utf8");
  assert.ok(launcher.includes(`NODE='${process.execPath}'`));
  assert.ok(!launcher.includes("@ROOT@"));
  const before = readFileSync(join(sb.claude, "settings.json"), "utf8");

  const second = await built(sb, "init", "--yes", "--no-skill");
  assert.equal(second.code, 0, second.stdout);
  assert.match(second.stdout, /engine 0\.1\.0 already current/);
  assert.match(second.stdout, /Claude Code: up to date/);
  assert.equal(readFileSync(join(sb.claude, "settings.json"), "utf8"), before);
});

test("init without a terminal needs --host or --yes", async () => {
  const sb = sandbox();
  const r = await built(sb, "init");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /pass --host <id> or --yes/);
});

test("doctor --json runs the real launcher and reports a healthy install", async () => {
  const sb = sandbox();
  assert.equal((await built(sb, "init", "--host", "claude-code", "--no-skill")).code, 0);
  assert.equal((await cli(sb, "add", MOODBOARD)).code, 0);
  trustInstalled(sb, "moodboard");
  const r = await built(sb, "doctor", "--json");
  const report = JSON.parse(r.stdout);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(report.ok, true);
  const run = report.checks.find((c: { id: string }) => c.id === "host.claude-code.run");
  assert.equal(run.status, "ok");
  assert.match(run.title, /answered in \d+ ms/);
  assert.deepEqual(Object.keys(report).sort(), ["checks", "fixed", "home", "next", "ok", "verdict", "version"]);
});

test("doctor reports a broken launcher Node path and --fix repairs it", async () => {
  const sb = sandbox();
  assert.equal((await built(sb, "init", "--yes", "--no-skill")).code, 0);
  const file = join(sb.home, "bin", "hookmux-hook");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^NODE='.*'$/m, "NODE='/nonexistent/node'"));
  const broken = await built(sb, "doctor");
  assert.equal(broken.code, 1, broken.stderr);
  assert.match(
    broken.stdout + broken.stderr,
    /✗ launcher's Node '\/nonexistent\/node' is missing\n {2}→ hookmux doctor --fix/,
  );
  const fixed = await built(sb, "doctor", "--fix");
  assert.equal(fixed.code, 0, fixed.stdout);
  assert.match(fixed.stdout, /✓ fix: re-recorded the launcher's Node path/);
});

test("uninstall removes only hub entries and keeps the user's own hooks", async () => {
  const sb = sandbox();
  const own = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
  writeFileSync(join(sb.claude, "settings.json"), JSON.stringify(own));
  assert.equal((await built(sb, "init", "--yes", "--no-skill")).code, 0);
  assert.equal(settings(sb).hooks?.UserPromptSubmit?.length, 2);
  const r = await built(sb, "uninstall");
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(settings(sb), own);
  assert.ok(existsSync(join(sb.home, "engine")), "home folder stays without --purge");
});
