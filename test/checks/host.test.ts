import assert from "node:assert/strict";
import { test } from "node:test";
import "../../src/checks/index.ts";
import { type CheckKind, getCheck } from "../../src/checks/registry.ts";
import { sampleEvent } from "../../src/commands/lib/run.ts";
import type { CheckSpec } from "../../src/core/types.ts";
import { claudeCode } from "../../src/hosts/claude-code.ts";
import { codex } from "../../src/hosts/codex.ts";
import { geminiCli } from "../../src/hosts/gemini-cli.ts";
import type { HostAdapter } from "../../src/hosts/types.ts";
import { checkContext, pluginSpec } from "./support.ts";

const host = getCheck("host") as CheckKind;

async function runHost(adapter: HostAdapter, spec: Omit<CheckSpec, "kind">) {
  const full: CheckSpec = { kind: "host", ...spec };
  const event = sampleEvent(adapter, "tool.after", "x");
  const result = await host.run(full, checkContext(pluginSpec("/tmp", { c: full }), { event }));
  return result.value;
}

// markup: claude-code yes, gemini-cli no, codex unknown (tool.after).
test("features is true on yes, false on no and unknown on unknown", async () => {
  assert.equal(await runHost(claudeCode, { features: ["inject.markup"] }), true);
  assert.equal(await runHost(geminiCli, { features: ["inject.markup"] }), false);
  assert.equal(await runHost(codex, { features: ["inject.markup"] }), null);
});

test("lacks is the inverse", async () => {
  assert.equal(await runHost(claudeCode, { lacks: ["inject.markup"] }), false);
  assert.equal(await runHost(geminiCli, { lacks: ["inject.markup"] }), true);
  assert.equal(await runHost(codex, { lacks: ["inject.markup"] }), null);
});

test("a mismatch beats an unknown feature, a match leaves it unknown", async () => {
  assert.equal(await runHost(codex, { id: ["claude-code"], features: ["inject.markup"] }), false);
  assert.equal(await runHost(codex, { id: ["codex"], features: ["inject.markup"] }), null);
});

test("a feature with no value on this event is unknown", async () => {
  // inject.before-call is about tool.before only; the sample event is tool.after.
  assert.equal(await runHost(claudeCode, { features: ["inject.before-call"] }), null);
});

test("validation rejects an unknown feature id and one named in both lists", () => {
  assert.deepEqual(host.validate({ kind: "host", features: ["inject.markdown"] }), [
    "features: unknown feature 'inject.markdown'",
  ]);
  assert.deepEqual(host.validate({ kind: "host", lacks: ["block.prevents"] }), []);
  assert.deepEqual(host.validate({ kind: "host", features: ["block.prevents"], lacks: ["block.prevents"] }), [
    "block.prevents is in both features and lacks",
  ]);
  assert.match(host.validate({ kind: "host" })[0] ?? "", /needs at least one of/);
});
