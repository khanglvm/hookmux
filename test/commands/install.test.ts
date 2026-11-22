// init, doctor and uninstall against the built bundle. This file owns the
// build step (it deletes and rewrites dist/); no other test file reads dist/.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { stableNodePath } from "../../src/install/node-path.ts";
import { cli, MOODBOARD, moodboardCopy, ROOT, runNode, type Sandbox, sandbox, trustInstalled } from "./helpers.ts";

const DIST_CLI = join(ROOT, "dist", "cli.mjs");
/** The build stamps the engine with package.json's version, which every release bumps. */
const BUILT_VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const BUILT_VERSION_RE = BUILT_VERSION.replaceAll(".", "\\.");

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
  assert.equal(readlinkSync(join(sb.home, "engine", "current")), BUILT_VERSION);
  const launcher = readFileSync(join(sb.home, "bin", "hookmux-hook"), "utf8");
  assert.ok(launcher.includes(`NODE='${stableNodePath()}'`));
  assert.ok(!launcher.includes("@ROOT@"));
  const before = readFileSync(join(sb.claude, "settings.json"), "utf8");

  const second = await built(sb, "init", "--yes", "--no-skill");
  assert.equal(second.code, 0, second.stdout);
  assert.match(second.stdout, new RegExp(`engine ${BUILT_VERSION_RE} already current`));
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

/** The sandbox as seen from inside Codex: a thread marker, no terminal. */
function inCodex(sb: Sandbox): Sandbox {
  return { ...sb, env: { ...sb.env, CODEX_THREAD_ID: "x" } };
}

test("install from an agent wires its client, adds the plugin untrusted and waits for the person", async () => {
  const sb = inCodex(sandbox());
  const r = await built(sb, "install", moodboardCopy(sb));
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`engine ${BUILT_VERSION_RE} installed`));
  assert.match(r.stdout, /approved \d+ hub entries/);
  assert.match(r.stdout, /hookmux: approval needed for moodboard\nhookmux plugin: moodboard/);
  const code = /replies `approve ([A-HJ-NP-Z2-9]{4})`/.exec(r.stdout)?.[1];
  assert.ok(code, "the card names a code");
  assert.ok(r.stdout.includes(`hookmux promote moodboard --confirm ${code}`));
  assert.ok(existsSync(join(sb.dir, "user", ".codex", "hooks.json")), "Codex is wired");
  const listed = JSON.parse((await built(sb, "list", "--json")).stdout);
  assert.equal(listed.plugins[0].status, "untrusted");
  assert.deepEqual(
    listed.plugins.map((p: { id: string }) => p.id),
    ["moodboard"],
    "no bundled plugin came along",
  );
});

test("install by an agent with no client marker and no --host is a usage error", async () => {
  const sb = sandbox();
  const r = await built(sb, "install", moodboardCopy(sb));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /name your client: hookmux install <source> --host <id>/);
  assert.ok(!existsSync(join(sb.home, "engine")), "nothing was set up");
});

test("install leaves a newer engine in place while it wires another client", async () => {
  const sb = inCodex(sandbox());
  assert.equal((await built(sb, "install", moodboardCopy(sb))).code, 3);
  const engines = join(sb.home, "engine");
  cpSync(join(engines, BUILT_VERSION), join(engines, "9.9.9"), { recursive: true });
  rmSync(join(engines, "current"));
  symlinkSync("9.9.9", join(engines, "current"));
  const again = await built(sb, "install", moodboardCopy(sb), "--host", "claude-code");
  assert.equal(again.code, 3, again.stdout + again.stderr);
  assert.equal(readlinkSync(join(engines, "current")), "9.9.9");
  assert.ok(existsSync(join(engines, "9.9.9")), "the newer engine is not pruned");
});

test("a second install does not reinstall the engine", async () => {
  const sb = inCodex(sandbox());
  assert.equal((await built(sb, "install", moodboardCopy(sb))).code, 3);
  assert.equal((await cli(sb, "new", "second", "--dir", sb.dir)).code, 0);
  const again = await built(sb, "install", join(sb.dir, "second"));
  assert.equal(again.code, 3, again.stdout + again.stderr);
  assert.doesNotMatch(again.stdout, /engine |launcher /);
  assert.match(again.stdout, /approval needed for second/);
});
