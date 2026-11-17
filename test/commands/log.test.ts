// log on / off / show against real hook runs (the source hook entry, no build).

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "../../src/commands/log.ts";
import { cli, moodboardCopy, runNode, type Sandbox, sandbox, trustInstalled } from "./helpers.ts";

function hook(sb: Sandbox, prompt: string) {
  const payload = { session_id: `s-${prompt.length}`, cwd: "/tmp", hook_event_name: "UserPromptSubmit", prompt };
  return runNode(sb, ["src/hook.ts", "--host", "claude-code", "--event", "prompt.submit"], JSON.stringify(payload));
}

test("log records hook runs only while on, and show filters them", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  trustInstalled(sb, "moodboard");

  await hook(sb, "redesign the landing page before logging");
  const on = await cli(sb, "log", "on", "--for", "30m", "--prompts");
  assert.equal(on.code, 0);
  assert.match(on.stdout, /! prompt text .* will be stored locally/);
  await hook(sb, "redesign the landing page to feel modern");
  await hook(sb, "rename this variable");
  assert.equal((await cli(sb, "log", "off")).code, 0);
  await hook(sb, "redesign the landing page after logging");

  const all = JSON.parse((await cli(sb, "log", "show", "--json")).stdout).entries;
  assert.equal(all.length, 2);
  assert.equal(all[0].prompt.text, "redesign the landing page to feel modern");
  const human = (await cli(sb, "log", "show", "-n", "1")).stdout;
  assert.match(human, /claude-code {2}prompt\.submit {2}\d+ms {2}fired: none/);
  const fired = JSON.parse((await cli(sb, "log", "show", "--json", "--plugin", "moodboard")).stdout).entries;
  assert.equal(fired.length, 2, "both runs evaluated moodboard");
  const errors = JSON.parse((await cli(sb, "log", "show", "--json", "--errors")).stdout).entries;
  assert.equal(errors.length, 0);

  const status = JSON.parse((await cli(sb, "log", "status", "--json")).stdout);
  assert.equal(status.enabled, false);
  assert.ok(status.bytes > 0);
});

test("log on --for parses durations and rejects others", async () => {
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
  assert.throws(() => parseDuration("10s"));
  assert.throws(() => parseDuration("0h"));
  const sb = sandbox();
  assert.equal((await cli(sb, "log", "on", "--for", "soon")).code, 2);
});
