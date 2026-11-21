// `hookmux new --template` and `--repo`: every scaffold validates and passes its own tests.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VERSION } from "../../src/version.ts";
import { cli, sandbox } from "./helpers.ts";

test("each template validates and passes hookmux test as written", async () => {
  const sb = sandbox();
  for (const template of ["prompt-context", "tool-guard", "session-note"]) {
    const id = `demo-${template}`;
    const made = await cli(sb, "new", id, "--template", template, "--dir", sb.dir);
    assert.equal(made.code, 0, made.stdout);
    const dir = join(sb.dir, id);
    assert.equal((await cli(sb, "validate", dir)).code, 0);
    const tested = await cli(sb, "test", dir, "--run-scripts");
    assert.equal(tested.code, 0, tested.stdout);
    assert.match(tested.stdout, /2 passed, 0 failed, 0 skipped/);
  }
});

test("tool-guard is a guard, session-note runs on session events, and note.sh is executable", async () => {
  const sb = sandbox();
  await cli(sb, "new", "g", "--template", "tool-guard", "--dir", sb.dir);
  await cli(sb, "new", "n", "--template", "session-note", "--dir", sb.dir);
  assert.match(readFileSync(join(sb.dir, "g", "plugin.toml"), "utf8"), /^phase = "guard"$/m);
  assert.match(readFileSync(join(sb.dir, "n", "plugin.toml"), "utf8"), /^origins = \["unknown"\]$/m);
  assert.ok(statSync(join(sb.dir, "n", "note.sh")).mode & 0o100);
});

test("--event must agree with a fixed-event template", async () => {
  const sb = sandbox();
  const bad = await cli(sb, "new", "g", "--template", "tool-guard", "--event", "prompt.submit", "--dir", sb.dir);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /tool-guard template listens to tool\.before/);
  const same = await cli(sb, "new", "g", "--template", "tool-guard", "--event", "tool.before", "--dir", sb.dir);
  assert.equal(same.code, 0, same.stdout);
  assert.equal((await cli(sb, "new", "x", "--template", "nope", "--dir", sb.dir)).code, 2);
});

test("--repo writes a README with the install lines and a pinned CI workflow", async () => {
  const sb = sandbox();
  const made = await cli(sb, "new", "demo", "--template", "tool-guard", "--repo", "me/demo", "--dir", sb.dir);
  assert.equal(made.code, 0, made.stdout);
  const dir = join(sb.dir, "demo");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  assert.match(readme, /npx -y hookmux install me\/demo/);
  assert.match(
    readme,
    /Install the demo plugin with hookmux: run `npx -y hookmux install me\/demo`, show me the approval card it prints word for word, and wait for my answer\./,
  );
  assert.match(readme, /stays off until you approve/);
  assert.ok(!readme.includes("<!-- card -->"), "the card placeholder is filled");
  // The card is rendered from the compiled scaffold, in a text block under a short lead-in.
  assert.match(
    readme,
    /What your users approve[^\n]*\n\n```text\nhookmux plugin: demo [\s\S]*From: github\.com\/me\/demo [\s\S]*\n {2}high {4}[\s\S]*```/,
  );
  assert.ok(!/Content:/.test(readme), "no content hash: the README is part of the hashed folder");
  const ci = readFileSync(join(dir, ".github", "workflows", "hookmux.yml"), "utf8");
  assert.ok(ci.includes(`npx -y hookmux@${VERSION} validate .`));
  assert.ok(ci.includes(`npx -y hookmux@${VERSION} test . --run-scripts`));
  assert.match(ci, /node-version: "22"/);
  for (const use of ci.match(/uses: .*/g) ?? []) assert.match(use, /@[0-9a-f]{40} # v\d/);
  assert.equal((await cli(sb, "test", dir)).code, 0);
  assert.equal((await cli(sb, "validate", dir)).code, 0);
});

test("--repo without a value uses a placeholder, and without the flag adds no repo files", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "new", "a", "--repo", "--dir", sb.dir)).code, 0);
  assert.match(readFileSync(join(sb.dir, "a", "README.md"), "utf8"), /hookmux install OWNER\/NAME/);
  assert.equal((await cli(sb, "new", "b", "--dir", sb.dir)).code, 0);
  assert.equal(existsSync(join(sb.dir, "b", "README.md")), false);
  assert.equal((await cli(sb, "new", "c", "--repo=not a repo", "--dir", sb.dir)).code, 2);
});
