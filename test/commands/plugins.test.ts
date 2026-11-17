// add, promote, list, remove and the flags they keep, run from source.

import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, moodboardCopy, sandbox } from "./helpers.ts";

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("add copies a local plugin, records its source and leaves it untrusted", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  const r = await cli(sb, "add", src);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ added moodboard 1\.0\.0/);
  assert.match(r.stdout, /→ hookmux promote moodboard/);
  assert.ok(existsSync(join(sb.home, "plugins", "moodboard", "plugin.toml")));
  const record = json(join(sb.home, "sources.json")).moodboard;
  assert.equal(record.source, src);
  assert.match(record.hash, /^sha256:/);
  const list = JSON.parse((await cli(sb, "list", "--json")).stdout);
  assert.equal(list.plugins[0].status, "untrusted");
  assert.deepEqual(list.plugins[0].events, ["prompt.submit"]);
});

test("add refuses an id that is already installed unless --force", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  assert.equal((await cli(sb, "add", src)).code, 0);
  const again = await cli(sb, "add", src);
  assert.equal(again.code, 1);
  assert.match(again.stdout, /✗ plugin 'moodboard' is already installed\n {2}→ .*--force/);
  assert.equal((await cli(sb, "add", src, "--force")).code, 0);
  assert.deepEqual((await import("node:fs")).readdirSync(join(sb.home, "tmp")), [], "staging folder is left empty");
});

test("add refuses a plugin that contains a symlink", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  symlinkSync("/etc/hosts", join(src, "hosts"));
  const r = await cli(sb, "add", src);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /hosts is a symlink/);
  assert.ok(!existsSync(join(sb.home, "plugins", "moodboard")));
});

test("add fixes group- and world-writable modes in the hub copy", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  chmodSync(join(src, "plugin.toml"), 0o666);
  assert.equal((await cli(sb, "add", src)).code, 0);
  assert.equal(statSync(join(sb.home, "plugins", "moodboard", "plugin.toml")).mode & 0o022, 0);
  assert.equal(statSync(join(src, "plugin.toml")).mode & 0o777, 0o666, "the source is not changed");
});

test("add --list shows the plugins and installs nothing", async () => {
  const sb = sandbox();
  const r = await cli(sb, "add", moodboardCopy(sb), "--list");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ moodboard 1\.0\.0 \(\.\)/);
  assert.match(r.stdout, /capabilities: event:prompt\.submit, inject/);
  assert.ok(!existsSync(join(sb.home, "plugins")));
});

test("add --shadow records the shadow flag", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb), "--shadow")).code, 0);
  assert.deepEqual(json(join(sb.home, "flags.json")).shadow, ["moodboard"]);
});

test("promote refuses without a terminal, even with --yes", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  for (const args of [
    ["promote", "moodboard"],
    ["promote", "moodboard", "--yes"],
  ]) {
    const r = await cli(sb, ...args);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /✗ promote needs your own terminal/);
    assert.match(r.stdout, /→ run this yourself in a terminal: hookmux promote moodboard/);
  }
  assert.ok(!existsSync(join(sb.home, "trust.json")), "nothing was trusted");
});

test("disable and enable edit flags; remove deletes the plugin and its records", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb), "--shadow")).code, 0);
  assert.equal((await cli(sb, "disable", "moodboard")).code, 0);
  assert.deepEqual(json(join(sb.home, "flags.json")).disabled, ["moodboard"]);
  assert.equal((await cli(sb, "enable", "moodboard")).code, 0);
  assert.deepEqual(json(join(sb.home, "flags.json")).disabled, []);
  assert.equal((await cli(sb, "remove", "moodboard")).code, 0);
  assert.ok(!existsSync(join(sb.home, "plugins", "moodboard")));
  assert.deepEqual(json(join(sb.home, "sources.json")), {});
  assert.deepEqual(json(join(sb.home, "flags.json")), { shadow: [], disabled: [] });
});

test("plugin ids that are not valid ids are usage errors", async () => {
  const sb = sandbox();
  const r = await cli(sb, "remove", "../escape");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not a valid plugin id/);
});
