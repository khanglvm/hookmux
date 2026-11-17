// Hook-side state that overlapping hook runs share: session markers, the
// provider breaker and the decision log's rotation.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isCoolingDown, recordFailure, recordSuccess } from "../src/providers/breaker.ts";
import { appendLog, LOG_ROTATE_BYTES } from "../src/runtime/log.ts";
import { descendantsOf, parseProcessTable } from "../src/runtime/process-tree.ts";
import { pruneSessions, readFired, recordFired } from "../src/runtime/state.ts";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `hookmux-${name}-`));

test("session markers from separate runs add up instead of overwriting each other", () => {
  const dir = temp("sessions");
  recordFired(dir, "s1", ["alpha"]);
  recordFired(dir, "s1", ["beta", "alpha"]);
  recordFired(dir, "s2", ["gamma"]);
  assert.deepEqual([...readFired(dir, "s1")].sort(), ["alpha", "beta"]);
  assert.deepEqual([...readFired(dir, "s2")], ["gamma"]);
  assert.deepEqual([...readFired(dir, "never")], []);
  recordFired(dir, "s1", ["../escape"]);
  assert.equal(existsSync(join(dir, "escape")), false, "an id that is not a plugin id is never a path");
});

test("pruning removes week-old session folders and old-format files only", () => {
  const dir = temp("prune");
  recordFired(dir, "old", ["alpha"]);
  recordFired(dir, "new", ["alpha"]);
  writeFileSync(join(dir, "legacy.json"), '{"fired":["alpha"]}');
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  for (const name of ["legacy.json", sessionFolder("old")]) utimesSync(join(dir, name), weekAgo, weekAgo);
  assert.equal(pruneSessions(dir), 2);
  assert.deepEqual([...readFired(dir, "new")], ["alpha"]);
  assert.deepEqual([...readFired(dir, "old")], []);
});

/** The folder name a session id maps to, found by recording into an empty folder. */
function sessionFolder(sessionId: string): string {
  const probe = temp("probe");
  recordFired(probe, sessionId, ["x"]);
  return readdirSync(probe)[0] as string;
}

test("one provider's breaker state never touches another's", () => {
  const dir = temp("breaker");
  recordFailure("a", Date.now(), dir);
  recordFailure("b", Date.now(), dir);
  recordSuccess("a", dir);
  assert.equal(isCoolingDown("a", Date.now(), dir), false);
  assert.equal(isCoolingDown("b", Date.now(), dir), true);
});

test("a run that finds the rotation lock taken appends without rotating", () => {
  const dir = temp("log");
  const file = join(dir, "hookmux.log");
  writeFileSync(file, "x".repeat(LOG_ROTATE_BYTES));
  writeFileSync(`${file}.lock`, "");
  appendLog(file, "line\n");
  assert.equal(existsSync(`${file}.1`), false);
  assert.ok(readFileSync(file, "utf8").endsWith("line\n"));
});

test("a stale rotation lock is replaced, the log rotates and the lock is removed", () => {
  const dir = temp("log");
  const file = join(dir, "hookmux.log");
  writeFileSync(file, "x".repeat(LOG_ROTATE_BYTES));
  writeFileSync(`${file}.lock`, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${file}.lock`, old, old);
  appendLog(file, "line\n");
  assert.equal(readFileSync(`${file}.1`, "utf8").length, LOG_ROTATE_BYTES);
  assert.equal(readFileSync(file, "utf8"), "line\n");
  assert.equal(existsSync(`${file}.lock`), false);
});

test("descendants are found through every generation of one ps snapshot", () => {
  const table = parseProcessTable(" 10   1\n 20  10\n 30  20\n 31  20\n 40   1\nheader line\n 50  50\n");
  assert.deepEqual(descendantsOf(10, table), [20, 30, 31]);
  assert.deepEqual(descendantsOf(40, table), []);
  assert.deepEqual(descendantsOf(50, table), [], "a process listed as its own parent is not its own child");
});
