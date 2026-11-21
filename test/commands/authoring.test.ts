// new, validate, test, explain and schema, run from source.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import "../../src/checks/index.ts";
import { listChecks } from "../../src/checks/registry.ts";
import { FEATURES } from "../../src/core/features.ts";
import { KNOWN_KEYS } from "../../src/load/manifest.ts";
import { cli, MOODBOARD, moodboardCopy, sandbox, trustInstalled } from "./helpers.ts";

test("test runs the moodboard cases from a path and from the installed copy", async () => {
  const sb = sandbox();
  const byPath = await cli(sb, "test", MOODBOARD);
  assert.equal(byPath.code, 0, byPath.stdout);
  assert.match(byPath.stdout, /✓ 5 passed, 0 failed, 0 skipped/);
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const installed = JSON.parse((await cli(sb, "test", "--json")).stdout);
  assert.equal(installed.ok, true);
  assert.deepEqual(installed.summary, { passed: 5, failed: 0, skipped: 0 });
  assert.equal(installed.plugins[0].cases[0].outcome, "fire");
});

test("test reports a failing case with its signals", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  writeFileSync(join(src, "tests.toml"), '[[case]]\nprompt = "rename this variable"\nexpect = "fire"\n');
  const r = await cli(sb, "test", src);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ moodboard #1 fire: rename this variable → got silent/);
  assert.match(r.stdout, /signals: design_words=false/);
});

test("explain --json has a stable shape and the host's exact stdout", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  trustInstalled(sb, "moodboard");
  const r = await cli(sb, "explain", "--json", "redesign the pricing page so it feels premium");
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), [
    "block",
    "context",
    "errors",
    "event",
    "host",
    "hostFeatures",
    "notices",
    "plugins",
    "prompt",
    "stdout",
  ]);
  assert.equal(out.host, "claude-code");
  assert.equal(out.plugins[0].id, "moodboard");
  assert.equal(out.plugins[0].outcome, "fire");
  assert.equal(out.plugins[0].status, "active");
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /moodboard/);
});

test("explain --all runs untrusted plugins in shadow so the stdout stays real", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const out = JSON.parse((await cli(sb, "explain", "--all", "--json", "redesign the landing page")).stdout);
  assert.equal(out.plugins[0].status, "untrusted");
  assert.equal(out.plugins[0].outcome, "fire");
  assert.equal(out.stdout, "");
});

test("new scaffolds a plugin whose own tests pass, for prompt and tool events", async () => {
  const sb = sandbox();
  for (const event of ["prompt.submit", "tool.before"]) {
    const id = `demo-${event.replace(".", "-")}`;
    const made = await cli(sb, "new", id, "--dir", sb.dir, "--event", event);
    assert.equal(made.code, 0, made.stdout);
    const tested = await cli(sb, "test", join(sb.dir, id));
    assert.equal(tested.code, 0, tested.stdout);
    assert.match(tested.stdout, /2 passed, 0 failed/);
  }
  const again = await cli(sb, "new", "demo-prompt-submit", "--dir", sb.dir);
  assert.equal(again.code, 1);
  assert.equal((await cli(sb, "new", "Bad_Id")).code, 2);
});

test("validate --json lists problems and exits 1", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  writeFileSync(join(src, "plugin.toml"), 'schema = 1\nid = "x"\nevents = ["nope"]\nwhen = "a"\n');
  const r = await cli(sb, "validate", src, "--json");
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p: string) => p.includes("unknown event 'nope'")));
});

test("schema --json documents every manifest key and check kind", async () => {
  const sb = sandbox();
  const schema = JSON.parse((await cli(sb, "schema", "--json")).stdout);
  for (const key of KNOWN_KEYS) {
    const doc = schema.keys.find((k: { key: string }) => k.key === key);
    assert.ok(doc?.meaning, `manifest key '${key}' has no meaning in hookmux schema`);
  }
  assert.deepEqual(
    schema.checks.map((c: { kind: string }) => c.kind),
    listChecks().map((c) => c.kind),
  );
  assert.ok(schema.hosts.some((h: { id: string }) => h.id === "claude-code"));
  assert.deepEqual(
    schema.features.map((f: { id: string }) => f.id),
    FEATURES.map((f) => f.id),
  );
  const qoder = schema.hosts.find((h: { id: string }) => h.id === "qoder");
  assert.equal(qoder.events["tool.after"].features["block.prevents"], false);
});

test("validate --json carries compat rows, and a dropped effect leaves the exit code at 0", async () => {
  const sb = sandbox();
  const src = moodboardCopy(sb);
  const manifest = [
    'schema = 1\nid = "moodboard-src"\nevents = ["tool.after"]\nwhen = "any"',
    '[checks.any]\nkind = "host"\nlacks = ["block.prevents"]',
    '[[then]]\neffect = "block"\nreason = "revert it"\nfallback = []',
  ].join("\n\n");
  writeFileSync(join(src, "plugin.toml"), manifest);
  const r = await cli(sb, "validate", src, "--json");
  assert.equal(r.code, 0, r.stdout);
  const qoder = JSON.parse(r.stdout).compat.find((row: { host: string }) => row.host === "qoder");
  assert.deepEqual([qoder.outcome, qoder.as, qoder.via], ["dropped", null, "author"]);
});

test("unknown flags are usage errors with exit 2", async () => {
  const sb = sandbox();
  const r = await cli(sb, "list", "--bogus");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Run 'hookmux list --help'/);
});
