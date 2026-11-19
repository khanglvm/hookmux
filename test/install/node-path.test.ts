import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stableNodePath } from "../../src/install/node-path.ts";

function layout() {
  const root = mkdtempSync(join(tmpdir(), "hookmux-node-"));
  const cellar = join(root, "Cellar", "node", "26.1", "bin");
  const bin = join(root, "bin");
  mkdirSync(cellar, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(cellar, "node"), "#!/bin/sh\n", { mode: 0o755 });
  return { root, versioned: join(cellar, "node"), bin };
}

test("the unversioned node on PATH that resolves to the running binary is recorded", () => {
  const { versioned, bin, root } = layout();
  symlinkSync(versioned, join(bin, "node"));
  assert.equal(stableNodePath(versioned, `${join(root, "empty")}:${bin}`), join(bin, "node"));
});

test("a node on PATH that is another binary is skipped, and the running path is kept", () => {
  const { versioned, bin } = layout();
  writeFileSync(join(bin, "node"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(stableNodePath(versioned, `relative:${bin}`), versioned);
});
