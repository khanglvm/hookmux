import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cachedScript, sha256Hex } from "../../src/checks/script-cache.ts";

const BODY = Buffer.from("#!/bin/sh\nexit 0\n");
const SHA = sha256Hex(BODY);

/** A fresh hookmux root per test, so a loosened or refused cache never leaks into another test. */
function freshRoot(): { root: string; dir: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "hookmux-cache-"));
  const dir = join(root, "cache", "scripts");
  return { root, dir, file: join(dir, SHA) };
}

function assertPrivateCopy(file: string): void {
  const stat = lstatSync(file);
  assert.ok(stat.isFile(), "the cached copy is not a regular file");
  assert.equal(stat.mode & 0o7777, 0o700);
  assert.deepEqual(readFileSync(file), BODY);
}

test("a missing copy is written with mode 0700 in 0700 folders", () => {
  const { root, dir, file } = freshRoot();
  assert.equal(cachedScript(BODY, SHA, root), file);
  assertPrivateCopy(file);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "cache")).mode & 0o777, 0o700);
});

test("a planted copy with the right bytes but mode 0600 is replaced", () => {
  const { root, dir, file } = freshRoot();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, BODY, { mode: 0o600 });
  cachedScript(BODY, SHA, root);
  assertPrivateCopy(file);
});

test("a symlink to a file with the right bytes is replaced by a regular file", () => {
  const { root, dir, file } = freshRoot();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const elsewhere = join(root, "elsewhere.sh");
  writeFileSync(elsewhere, BODY, { mode: 0o700 });
  symlinkSync(elsewhere, file);
  cachedScript(BODY, SHA, root);
  assertPrivateCopy(file);
  assert.deepEqual(readFileSync(elsewhere), BODY, "the link target was written through");
});

test("cache folders of ours with a loose mode are tightened to 0700", () => {
  const { root, dir, file } = freshRoot();
  mkdirSync(dir, { recursive: true });
  chmodSync(join(root, "cache"), 0o755);
  chmodSync(dir, 0o777);
  cachedScript(BODY, SHA, root);
  assert.equal(statSync(join(root, "cache")).mode & 0o7777, 0o700);
  assert.equal(statSync(dir).mode & 0o7777, 0o700);
  assertPrivateCopy(file);
});

test("a cache folder that is a symlink is refused", () => {
  const { root } = freshRoot();
  const elsewhere = mkdtempSync(join(tmpdir(), "hookmux-elsewhere-"));
  mkdirSync(join(root, "cache"), { mode: 0o700 });
  symlinkSync(elsewhere, join(root, "cache", "scripts"));
  assert.throws(() => cachedScript(BODY, SHA, root), /not a folder owned by you/);
});
