import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../src/checks/index.ts";
import { ADAPTERS } from "../src/hosts/index.ts";
import { writeFlags } from "../src/load/flags.ts";
import { compileManifest } from "../src/load/manifest.ts";
import { compileRegistry } from "../src/load/registry.ts";
import { KNOWN_HOSTS } from "../src/load/snapshot.ts";
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
