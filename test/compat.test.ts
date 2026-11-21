import assert from "node:assert/strict";
import { test } from "node:test";
import "../src/checks/index.ts";
import { type CompatRow, planPlugin } from "../src/core/compat.ts";
import type { EffectSpec, PluginSpec } from "../src/core/types.ts";
import { ADAPTERS } from "../src/hosts/index.ts";
import { pluginSpec } from "./checks/support.ts";

function plan(spec: Partial<PluginSpec>, hostIds: string[]): CompatRow[] {
  const base = { ...pluginSpec("/tmp", { c: { kind: "host", id: ["x"] } }), ...spec };
  const hosts = hostIds.map((id) => ADAPTERS[id]).filter((h) => h !== undefined);
  return planPlugin({ base, variants: {} }, hosts);
}

function only(rows: CompatRow[]): CompatRow {
  assert.equal(rows.length, 1);
  return rows[0] as CompatRow;
}

const block = (fallback?: EffectSpec["fallback"]): EffectSpec[] => [
  { effect: "block", reason: "no", ...(fallback ? { fallback } : {}) },
];

test("a block after a tool call: native, engine notice, author fallback and drop", () => {
  const after = { events: ["tool.after" as const], effects: block() };
  const native = only(plan(after, ["claude-code"]));
  assert.deepEqual([native.outcome, native.as, native.via], ["works", "block", "native"]);
  assert.deepEqual(
    native.caveats.map((c) => [c.feature, c.value]),
    [["block.prevents", false]],
  );

  const notice = only(plan(after, ["qoder"]));
  assert.deepEqual([notice.outcome, notice.as, notice.via], ["fallback", "notify", "engine"]);

  const inject = only(plan({ ...after, effects: block(["inject"]) }, ["qoder"]));
  assert.deepEqual([inject.outcome, inject.as, inject.via], ["fallback", "inject", "author"]);
  assert.ok(inject.caveats.some((c) => c.feature === "inject.inline" && c.value === null));

  const dropped = only(plan({ ...after, effects: block([]) }, ["qoder"]));
  assert.deepEqual([dropped.outcome, dropped.as], ["dropped", null]);
});

test("a host with no native name for an event, or outside `hosts`, gets no rows", () => {
  const { codex } = ADAPTERS;
  assert.ok(codex);
  const noEvent = { ...codex, nativeEvents: { ...codex.nativeEvents, "tool.after": null } };
  const spec = { ...pluginSpec("/tmp", {}), events: ["tool.after" as const], effects: block() };
  assert.deepEqual(planPlugin({ base: spec, variants: {} }, [noEvent]), []);
  assert.deepEqual(plan({ events: ["tool.after"], effects: block(), hosts: ["codex"] }, ["qoder"]), []);
});

test("a [host.<id>] variant is planned in place of the base", () => {
  const base = { ...pluginSpec("/tmp", {}), events: ["tool.after" as const], effects: block() };
  const variant = { ...base, effects: block([]) };
  const rows = planPlugin({ base, variants: { qoder: variant } }, [ADAPTERS.qoder as never]);
  assert.equal(only(rows).outcome, "dropped");
});

test("input caveats: version range, user-only origins and file_path fields", () => {
  const checks = {
    v: { kind: "host", version: ">=1" },
    f: { kind: "regex", patterns: ["x"], field: "tool.input.file_path" },
  };
  const inject: EffectSpec[] = [{ effect: "inject", text: "plain" }];
  const tool = only(plan({ checks, events: ["tool.before"], effects: inject }, ["codex"]));
  assert.deepEqual(tool.caveats.map((c) => c.feature).sort(), [
    "host.version",
    "inject.before-call",
    "inject.inline",
    "tool.file-path",
  ]);
  const prompt = only(plan({ events: ["prompt.submit"], origins: ["user"], effects: inject }, ["qoder"]));
  assert.ok(prompt.caveats.some((c) => c.feature === "prompt.origin" && c.value === false));
  const both = only(plan({ events: ["prompt.submit"], origins: ["user", "system"], effects: inject }, ["qoder"]));
  assert.ok(!both.caveats.some((c) => c.feature === "prompt.origin"));
});

test("a caveat appears only when the effect can hit it", () => {
  const rowFor = (effect: EffectSpec) => only(plan({ events: ["prompt.submit"], effects: [effect] }, ["gemini-cli"]));
  const features = (r: CompatRow) => r.caveats.map((c) => c.feature);
  assert.ok(!features(rowFor({ effect: "inject", text: "plain" })).includes("inject.markup"));
  assert.ok(features(rowFor({ effect: "inject", text: "<b>bold</b>" })).includes("inject.markup"));
  assert.ok(!features(rowFor({ effect: "block", reason: "no" })).includes("block.suppress-prompt"));
});
