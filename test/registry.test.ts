import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../src/checks/index.ts";
import type { PluginSpec } from "../src/core/types.ts";
import { ADAPTERS } from "../src/hosts/index.ts";
import { writeFlags } from "../src/load/flags.ts";
import { compileManifest } from "../src/load/manifest.ts";
import { compileRegistry } from "../src/load/registry.ts";
import { KNOWN_HOSTS } from "../src/load/snapshot.ts";
import { capabilitiesOf, writeTrust } from "../src/load/trust.ts";
import { homePaths } from "../src/runtime/paths.ts";

const EXAMPLES = new URL("../examples/", import.meta.url).pathname;

function home() {
  const paths = homePaths(mkdtempSync(join(tmpdir(), "hookmux-reg-")));
  mkdirSync(paths.plugins, { recursive: true });
  return paths;
}

test("KNOWN_HOSTS matches the registered adapters", () => {
  assert.deepEqual([...KNOWN_HOSTS].sort(), Object.keys(ADAPTERS).sort());
});

test("an unpromoted plugin flagged shadow runs in shadow only", () => {
  const paths = home();
  cpSync(join(EXAMPLES, "moodboard"), join(paths.plugins, "moodboard"), { recursive: true });
  assert.equal(compileRegistry(paths).plugins[0]?.status, "untrusted");
  writeFlags(paths.flags, { shadow: ["moodboard"], disabled: [] });
  const entry = compileRegistry(paths).plugins[0];
  assert.equal(entry?.status, "active");
  assert.equal(entry?.base?.shadow, true);
});

test("an unpromoted plugin with a script stays off even when flagged shadow", () => {
  const paths = home();
  const dir = join(paths.plugins, "scripted");
  mkdirSync(dir);
  writeFileSync(join(dir, "check.sh"), "#!/bin/sh\necho '{\"value\":0.9}'\n");
  chmodSync(join(dir, "check.sh"), 0o755);
  writeFileSync(
    join(dir, "plugin.toml"),
    [
      "schema = 1",
      'id = "scripted"',
      'events = ["prompt.submit"]',
      'when = "score >= 0.5"',
      "[checks.score]",
      'kind = "script"',
      'command = "check.sh"',
      'output = "score"',
      "[[then]]",
      'effect = "inject"',
      'text = "hi"',
    ].join("\n"),
  );
  writeFlags(paths.flags, { shadow: ["scripted"], disabled: [] });
  const entry = compileRegistry(paths).plugins[0];
  assert.equal(entry?.status, "untrusted", entry?.problem);
});

test("a score script can be compared in when, and a bool check cannot", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-shape-"));
  const base = {
    schema: 1,
    id: "s",
    events: ["prompt.submit"],
    then: [{ effect: "inject", text: "x" }],
  };
  const defaults = { routeOrigins: ["user" as const], knownHosts: KNOWN_HOSTS };
  compileManifest(
    { ...base, when: "s >= 0.5", checks: { s: { kind: "script", command: "c.sh", output: "score" } } },
    dir,
    undefined,
    defaults,
  );
  assert.throws(() =>
    compileManifest(
      { ...base, when: "s >= 0.5", checks: { s: { kind: "keywords", words: ["a"] } } },
      dir,
      undefined,
      defaults,
    ),
  );
});

test("a config override that adds capabilities sends a promoted plugin back to promote", () => {
  const paths = home();
  cpSync(join(EXAMPLES, "moodboard"), join(paths.plugins, "moodboard"), { recursive: true });
  const before = compileRegistry(paths).plugins[0];
  assert.ok(before?.hash);
  writeTrust(paths.trust, {
    plugins: { moodboard: { hash: before.hash, capabilities: before.capabilities, promotedAt: "test" } },
  });
  assert.equal(compileRegistry(paths).plugins[0]?.status, "active");
  writeFileSync(paths.config, '[[override.moodboard.then]]\neffect = "block"\nreason = "no"\n');
  const after = compileRegistry(paths).plugins[0];
  assert.equal(after?.status, "untrusted");
  assert.equal(after?.problem, "config override adds block; run hookmux promote moodboard");
  assert.ok(after?.capabilities.includes("block"), "capabilities come from the effective spec");
});

test("a trust entry without a capability list approves no capability", () => {
  const paths = home();
  cpSync(join(EXAMPLES, "moodboard"), join(paths.plugins, "moodboard"), { recursive: true });
  const hash = compileRegistry(paths).plugins[0]?.hash;
  writeFileSync(paths.trust, JSON.stringify({ plugins: { moodboard: { hash, promotedAt: "old" } } }));
  assert.match(compileRegistry(paths).plugins[0]?.problem ?? "", /^config override adds /);
});

test('on_error = "block" is rejected and "open" changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-onerror-"));
  const base = {
    schema: 1,
    id: "g",
    phase: "guard",
    events: ["prompt.submit"],
    when: "true",
    then: [{ effect: "block", reason: "x" }],
  };
  const defaults = { routeOrigins: ["user" as const], knownHosts: KNOWN_HOSTS };
  assert.throws(
    () => compileManifest({ ...base, on_error: "block" }, dir, undefined, defaults),
    /hookmux always fails open; remove on_error/,
  );
  const open = compileManifest({ ...base, on_error: "open" }, dir, undefined, defaults).base;
  assert.deepEqual(open, compileManifest(base, dir, undefined, defaults).base);
});

test("each variable a script passes through is a capability of its own", () => {
  const spec = {
    events: ["tool.after"],
    effects: [{ effect: "inject" }],
    checks: { role: { kind: "script", command: "x.py", env: ["T3CODE_THREAD_ID"] } },
  } as unknown as PluginSpec;
  assert.deepEqual(capabilitiesOf(spec), ["env:T3CODE_THREAD_ID", "event:tool.after", "inject", "script"]);
});
