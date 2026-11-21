// Standing approvals (promote --standing) and Codex hub approval through the fake app-server.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approveHubEntries } from "../../src/hosts/codex-trust.ts";
import { isCapabilitySubset, readTrust, writeTrust } from "../../src/load/trust.ts";
import { homePaths } from "../../src/runtime/paths.ts";
import { cli, FAKE_CODEX, moodboardCopy, type Sandbox, sandbox, trustInstalled } from "./helpers.ts";

/** Stands in for an interactive `promote --standing`: pins the plugin and grants `ceiling`. */
function grantStanding(sb: Sandbox, id: string, ceiling?: string[]): void {
  trustInstalled(sb, id);
  const paths = homePaths(sb.home);
  const store = readTrust(paths.trust);
  const entry = store.plugins[id];
  assert.ok(entry);
  entry.standing = { capabilities: ceiling ?? entry.capabilities, grantedAt: "test" };
  writeTrust(paths.trust, store);
}

const trustOf = (sb: Sandbox, id: string) => readTrust(homePaths(sb.home).trust).plugins[id];

function editDescription(dir: string, text: string): void {
  const file = join(dir, "plugin.toml");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^description = .*$/m, `description = "${text}"`));
}

test("add --force activates a changed plugin under its standing approval", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  assert.equal((await cli(sb, "add", src)).code, 0);
  grantStanding(sb, "moodboard");
  const before = trustOf(sb, "moodboard");
  editDescription(src, "changed");
  const r = await cli(sb, "add", src, "--force");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /moodboard activated under the standing approval/);
  assert.doesNotMatch(r.stdout, /hookmux promote moodboard/);
  const after = trustOf(sb, "moodboard");
  assert.notEqual(after?.hash, before?.hash);
  assert.equal(after?.via, "standing");
  assert.deepEqual(after?.standing, before?.standing);
  const list = JSON.parse((await cli(sb, "list", "--json")).stdout);
  assert.equal(list.plugins[0].status, "active");
});

test("a plugin that outgrows its standing approval stays untrusted", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  assert.equal((await cli(sb, "add", src)).code, 0);
  grantStanding(sb, "moodboard", ["event:prompt.submit"]);
  editDescription(src, "changed");
  const r = await cli(sb, "add", src, "--force");
  assert.match(r.stdout, /beyond its standing approval/);
  assert.match(r.stdout, /hookmux promote moodboard/);
  const list = JSON.parse((await cli(sb, "list", "--json")).stdout);
  assert.equal(list.plugins[0].status, "untrusted");
});

test("add --shadow does not apply a standing approval", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  assert.equal((await cli(sb, "add", src)).code, 0);
  grantStanding(sb, "moodboard");
  const pinned = trustOf(sb, "moodboard")?.hash;
  editDescription(src, "changed");
  const r = await cli(sb, "add", src, "--force", "--shadow");
  assert.match(r.stdout, /shadow mode/);
  assert.equal(trustOf(sb, "moodboard")?.hash, pinned);
});

test("an in-place edit is not covered by a standing approval", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  grantStanding(sb, "moodboard");
  editDescription(join(sb.home, "plugins", "moodboard"), "edited in place");
  const list = JSON.parse((await cli(sb, "list", "--json")).stdout);
  assert.equal(list.plugins[0].status, "untrusted");
});

test("promote --standing still needs a terminal; --end-standing does not", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const refused = await cli(sb, "promote", "moodboard", "--standing");
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /standing approval needs your terminal or your client's permission prompt/);
  grantStanding(sb, "moodboard");
  const ended = await cli(sb, "promote", "moodboard", "--end-standing");
  assert.equal(ended.code, 0, ended.stdout + ended.stderr);
  assert.equal(trustOf(sb, "moodboard")?.standing, undefined);
  assert.ok(trustOf(sb, "moodboard")?.hash, "the current pin stays");
});

test("a higher approved evidence_chars limit covers a lower one", () => {
  assert.ok(isCapabilitySubset(["evidence_chars:400", "script"], ["evidence_chars:600", "script"]));
  assert.ok(!isCapabilitySubset(["evidence_chars:800"], ["evidence_chars:600"]));
  assert.ok(!isCapabilitySubset(["block"], ["evidence_chars:600"]));
});

function codexHooks(sb: Sandbox): string {
  return join(sb.env.CODEX_HOME as string, "hooks.json");
}

const fakeTrust = (sb: Sandbox) =>
  JSON.parse(readFileSync(join(sb.env.CODEX_HOME as string, "fake-trust.json"), "utf8")) as Record<string, string>;

async function initCodex(sb: Sandbox) {
  mkdirSync(sb.env.CODEX_HOME as string, { recursive: true });
  writeFileSync(
    codexHooks(sb),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }),
  );
  return cli(sb, "init", "--host", "codex", "--no-skill", "--no-bundled");
}

test("init approves hookmux's Codex hub entries and leaves other hooks alone", async () => {
  const sb = sandbox();
  const r = await initCodex(sb);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Codex: approved 2 hub entries/);
  const keys = Object.keys(fakeTrust(sb));
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => /:(user_prompt_submit|session_start):0:0$/.test(k)));
  assert.ok(!keys.some((k) => k.includes(":stop:")));
  const again = await cli(sb, "sync");
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.stdout, /approved/);
});

test("a failed Codex approval is reported with the /hooks step", async () => {
  const sb = sandbox();
  sb.env.FAKE_CODEX_FAIL = "write";
  const r = await initCodex(sb);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /still need approval\n {2}→ open Codex, run \/hooks/);
  sb.env.FAKE_CODEX_FAIL = "list";
  const listed = await cli(sb, "sync");
  assert.equal(listed.code, 1);
  assert.match(listed.stdout, /could not approve hub entries \(hooks\/list failed\)/);
  sb.env.HOOKMUX_CODEX = join(sb.dir, "missing-codex");
  delete sb.env.FAKE_CODEX_FAIL;
  const missing = await cli(sb, "sync");
  assert.equal(missing.code, 0, "a machine without codex is not a failed sync");
  assert.match(missing.stdout, /could not approve hub entries \(could not start codex app-server/);
});

test("doctor reports a Codex hub entry whose approved hash no longer matches", async () => {
  const sb = sandbox();
  assert.equal((await initCodex(sb)).code, 0);
  assert.match((await cli(sb, "doctor")).stdout, /Codex: 2 hub entries approved/);
  const trust = fakeTrust(sb);
  for (const key of Object.keys(trust)) trust[key] = "sha256:stale";
  writeFileSync(join(sb.env.CODEX_HOME as string, "fake-trust.json"), JSON.stringify(trust));
  assert.match((await cli(sb, "doctor")).stdout, /Codex has not approved: .*\(modified\)/);
});

test("a symlinked CODEX_HOME still gets its hub entries approved", async () => {
  const sb = sandbox();
  const real = join(sb.dir, "real-codex");
  mkdirSync(real);
  symlinkSync(real, join(sb.dir, "codex-link"));
  sb.env.CODEX_HOME = join(sb.dir, "codex-link");
  const r = await initCodex(sb);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Codex: approved 2 hub entries/);
});

test("hub entries Codex does not list count as unapproved", async () => {
  const sb = sandbox();
  sb.env.FAKE_CODEX_FAIL = "empty";
  const r = await initCodex(sb);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /Codex does not list the hub entries for prompt\.submit, session\.start/);
  assert.match((await cli(sb, "doctor")).stdout, /Codex has not approved: .*\(not listed by Codex\)/);
});

test("an app-server that ignores SIGTERM is killed after the timeout", async () => {
  const sb = sandbox();
  const home = sb.env.CODEX_HOME as string;
  mkdirSync(home, { recursive: true });
  const env = { ...sb.env, FAKE_CODEX_FAIL: "hang" };
  const target = { launcher: "/x", hooksFile: join(home, "hooks.json"), events: [], env, codex: FAKE_CODEX };
  await assert.rejects(approveHubEntries({ ...target, timeoutMs: 300 }), /did not answer in time/);
  const pid = Number(readFileSync(join(home, "fake.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a hub entry in the older double-quoted form is left for /hooks, and counts once approved there", async () => {
  const sb = sandbox();
  const home = sb.env.CODEX_HOME as string;
  mkdirSync(home, { recursive: true });
  const legacy = { type: "command", command: `"${homePaths(sb.home).launcher}" --host codex --event prompt.submit` };
  writeFileSync(codexHooks(sb), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [legacy] }] } }));
  const r = await cli(sb, "init", "--host", "codex", "--no-skill", "--no-bundled");
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Codex: 1 hub entries still need approval/);
  const legacyKey = `${realpathSync(home)}/hooks.json:user_prompt_submit:0:0`;
  assert.equal(fakeTrust(sb)[legacyKey], undefined);
  const byHand = `sha256:${createHash("sha256").update(JSON.stringify(legacy)).digest("hex")}`;
  writeFileSync(join(home, "fake-trust.json"), JSON.stringify({ ...fakeTrust(sb), [legacyKey]: byHand }));
  const again = await cli(sb, "sync");
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.match((await cli(sb, "doctor")).stdout, /Codex: 2 hub entries approved/);
});

test("a hub entry edited to run async or under a matcher is not approved", async () => {
  const sb = sandbox();
  assert.equal((await initCodex(sb)).code, 0);
  const table = JSON.parse(readFileSync(codexHooks(sb), "utf8"));
  table.hooks.UserPromptSubmit[0].matcher = "never";
  table.hooks.SessionStart[0].hooks[0].async = true;
  writeFileSync(codexHooks(sb), JSON.stringify(table));
  const before = fakeTrust(sb);
  const r = await cli(sb, "sync");
  assert.match(r.stdout, /hub entries still need approval/);
  assert.deepEqual(fakeTrust(sb), before);
});
