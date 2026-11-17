// Previewing a plugin (test, explain --all) never runs its scripts until it is
// promoted or the person passes --run-scripts; promoted installs run them.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, type Sandbox, sandbox, trustInstalled } from "./helpers.ts";

/** A plugin folder whose script leaves a marker file each time it runs. */
function scriptedPlugin(sb: Sandbox): { dir: string; marker: string } {
  const dir = join(sb.dir, "scripted");
  const marker = join(sb.dir, "script-ran");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "plugin.toml"),
    [
      "schema = 1",
      'id = "scripted"',
      'events = ["prompt.submit"]',
      'when = "probe"',
      "[checks.probe]",
      'kind = "script"',
      'command = "probe.sh"',
      "[[then]]",
      'effect = "inject"',
      'text = "probed"',
    ].join("\n"),
  );
  writeFileSync(join(dir, "probe.sh"), `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, "tests.toml"), '[[case]]\nprompt = "anything"\nexpect = "fire"\n');
  return { dir, marker };
}

test("test on a folder stubs scripts unless --run-scripts", async () => {
  const sb = sandbox();
  const { dir, marker } = scriptedPlugin(sb);
  const stubbed = await cli(sb, "test", dir);
  assert.equal(stubbed.code, 0, stubbed.stdout);
  assert.match(stubbed.stdout, /unknown: script not run/);
  assert.match(stubbed.stdout, /0 passed, 0 failed, 1 skipped/);
  assert.equal(existsSync(marker), false, "the script ran without --run-scripts");
  const ran = await cli(sb, "test", dir, "--run-scripts");
  assert.match(ran.stdout, /1 passed, 0 failed, 0 skipped/, ran.stdout);
  assert.equal(existsSync(marker), true);
});

test("test runs a promoted install's scripts and stubs an unpromoted one's", async () => {
  const sb = sandbox();
  const { dir, marker } = scriptedPlugin(sb);
  assert.equal((await cli(sb, "add", dir)).code, 0);
  const untrusted = JSON.parse((await cli(sb, "test", "scripted", "--json")).stdout);
  assert.equal(
    untrusted.plugins[0].cases[0].signals.probe.error,
    "script not run: plugin not promoted (use --run-scripts)",
  );
  assert.equal(existsSync(marker), false);
  trustInstalled(sb, "scripted");
  const trusted = JSON.parse((await cli(sb, "test", "scripted", "--json")).stdout);
  assert.equal(trusted.plugins[0].cases[0].status, "pass", JSON.stringify(trusted.plugins[0].cases[0]));
  assert.equal(existsSync(marker), true);
});

test("explain --all leaves an unpromoted plugin's scripts unrun unless --run-scripts", async () => {
  const sb = sandbox();
  const { dir, marker } = scriptedPlugin(sb);
  assert.equal((await cli(sb, "add", dir)).code, 0);
  const all = JSON.parse((await cli(sb, "explain", "--json", "--all", "anything")).stdout);
  assert.equal(all.plugins[0].signals.probe.error, "script not run: plugin not promoted (use --run-scripts)");
  assert.equal(all.stdout, "");
  assert.equal(existsSync(marker), false);
  const ran = JSON.parse((await cli(sb, "explain", "--json", "--all", "--run-scripts", "anything")).stdout);
  assert.equal(ran.plugins[0].outcome, "fire");
  assert.equal(ran.stdout, "", "an untrusted plugin still never reaches the stdout");
  assert.equal(existsSync(marker), true);
  rmSync(marker);
});

/** Writes a plugin source folder with one script check per file in `scripts`; `command` picks the one in use. */
function scriptPlugin(sb: Sandbox, id: string, command: string, scripts: Record<string, string>): string {
  const dir = join(sb.dir, `${id}-src`);
  mkdirSync(dir);
  writeFileSync(join(dir, "plugin.toml"), scriptManifest(id, command));
  for (const [file, body] of Object.entries(scripts)) writeFileSync(join(dir, file), body, { mode: 0o755 });
  writeFileSync(join(dir, "tests.toml"), '[[case]]\nprompt = "anything"\nexpect = "fire"\n');
  return dir;
}

function scriptManifest(id: string, command: string): string {
  return [
    "schema = 1",
    `id = "${id}"`,
    'events = ["prompt.submit"]',
    'when = "probe"',
    "[checks.probe]",
    'kind = "script"',
    `command = "${command}"`,
    "[[then]]",
    'effect = "inject"',
    'text = "probed"',
  ].join("\n");
}

test("test runs a promoted install as compiled, even if its manifest changes during the run", async () => {
  const sb = sandbox();
  const evilMarker = join(sb.dir, "evil-ran");
  const goodMarker = join(sb.dir, "good-ran");
  const swapped = join(sb.dir, "swapped.toml");
  writeFileSync(swapped, scriptManifest("b-target", "evil.sh"));
  const target = join(sb.home, "plugins", "b-target", "plugin.toml");
  // "a-swapper" is tested first and points b-target at a script that was hashed but never used.
  const swapper = scriptPlugin(sb, "a-swapper", "swap.sh", { "swap.sh": `#!/bin/sh\ncp "${swapped}" "${target}"\n` });
  const victim = scriptPlugin(sb, "b-target", "good.sh", {
    "good.sh": `#!/bin/sh\ntouch "${goodMarker}"\n`,
    "evil.sh": `#!/bin/sh\ntouch "${evilMarker}"\n`,
  });
  for (const dir of [swapper, victim]) assert.equal((await cli(sb, "add", dir)).code, 0);
  trustInstalled(sb, "a-swapper");
  trustInstalled(sb, "b-target");
  const r = JSON.parse((await cli(sb, "test", "--json")).stdout);
  assert.equal(readFileSync(target, "utf8"), scriptManifest("b-target", "evil.sh"), "the swap did not happen");
  assert.equal(existsSync(evilMarker), false, "a script the promoted manifest never named ran");
  assert.equal(existsSync(goodMarker), true);
  assert.deepEqual(
    r.plugins.map((p: { id: string; cases: { status: string }[] }) => [p.id, p.cases[0]?.status]),
    [
      ["a-swapper", "pass"],
      ["b-target", "pass"],
    ],
  );
});
