import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../src/checks/index.ts";
import { sampleEvent } from "../src/commands/lib/run.ts";
import { runEngine } from "../src/core/engine.ts";
import type { Fallback, PluginSpec } from "../src/core/types.ts";
import { claudeCode } from "../src/hosts/claude-code.ts";
import { droid } from "../src/hosts/droid.ts";
import { qoder } from "../src/hosts/qoder.ts";
import type { HostAdapter } from "../src/hosts/types.ts";
import { compileManifest, readManifest } from "../src/load/manifest.ts";
import { KNOWN_HOSTS } from "../src/load/snapshot.ts";
import { capabilitiesOf } from "../src/load/trust.ts";
import { pluginSpec } from "./checks/support.ts";

const EXAMPLES = new URL("../examples/", import.meta.url).pathname;

function moodboard() {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-test-"));
  cpSync(join(EXAMPLES, "moodboard"), dir, { recursive: true });
  return compileManifest(readManifest(dir), dir, undefined, { routeOrigins: ["user"], knownHosts: ["claude-code"] })
    .base;
}

function promptEvent(prompt: string) {
  const event = claudeCode.parse(
    "prompt.submit",
    { session_id: "s1", cwd: "/tmp", prompt, hook_event_name: "UserPromptSubmit" },
    {},
  );
  assert.ok(event);
  return event;
}

const settings = { deadlineMs: 1000, blockRequiresRule: true, contextBudget: 9000, runtime: { providers: {} } };

test("moodboard fires on a design request and renders Claude context", async () => {
  const event = promptEvent("redesign the pricing page so it feels more premium");
  const result = await runEngine({ event, plugins: [moodboard()], settings, firedThisSession: new Set() });
  assert.equal(result.trace[0]?.outcome, "fire");
  const out = JSON.parse(claudeCode.render(result, event));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /moodboard/);
});

test("moodboard stays silent on a bug fix and on task notifications", async () => {
  const plugin = moodboard();
  const fix = await runEngine({
    event: promptEvent("fix the crash on the settings screen"),
    plugins: [plugin],
    settings,
    firedThisSession: new Set(),
  });
  assert.equal(fix.trace[0]?.outcome, "silent");
  const note = promptEvent("<task-notification>redesign landing page done</task-notification>");
  assert.equal(note.origin, "system");
  const r = await runEngine({ event: note, plugins: [plugin], settings, firedThisSession: new Set() });
  assert.equal(r.trace.length, 0);
  assert.equal(claudeCode.render(r, note), "");
});

test("session dedupe skips a plugin that already fired", async () => {
  const event = promptEvent("redesign the pricing page");
  const r = await runEngine({ event, plugins: [moodboard()], settings, firedThisSession: new Set(["moodboard"]) });
  assert.equal(r.trace[0]?.outcome, "skipped");
  assert.equal(claudeCode.render(r, event), "");
});

// Fallback: qoder cannot block after a tool call, claude-code can.
const RULE_CHECK: PluginSpec["checks"] = { any: { kind: "regex", patterns: ["."], field: "cwd" } };

function toolPlugin(
  event: "tool.before" | "tool.after",
  effects: PluginSpec["effects"],
  checks: PluginSpec["checks"] = RULE_CHECK,
): PluginSpec {
  const base = pluginSpec("/tmp", checks);
  return { ...base, events: [event], origins: ["user", "system", "unknown"], when: "any", effects };
}

const afterToolPlugin = (effects: PluginSpec["effects"], checks?: PluginSpec["checks"]) =>
  toolPlugin("tool.after", effects, checks);

async function composeAfterTool(adapter: HostAdapter, plugin: PluginSpec, budget = 9000) {
  const event = sampleEvent(adapter, "tool.after", "x");
  const result = await runEngine({
    event,
    plugins: [plugin],
    settings: { ...settings, contextBudget: budget },
    firedThisSession: new Set(),
  });
  return { result, note: result.trace[0]?.note };
}

const block = (fallback?: Fallback): PluginSpec["effects"] => [
  { effect: "block", reason: "revert it", ...(fallback ? { fallback } : {}) },
];

test("a block with fallback inject becomes context where the host cannot block", async () => {
  const { result, note } = await composeAfterTool(qoder, afterToolPlugin(block(["inject"])));
  assert.deepEqual(result.context, [{ pluginId: "test-plugin", text: "revert it" }]);
  assert.equal(result.block, undefined);
  assert.equal(note, "host cannot block here; fallback inject");
});

test("an empty fallback drops the effect instead of showing a notice", async () => {
  const { result } = await composeAfterTool(qoder, afterToolPlugin(block([])));
  assert.deepEqual([result.context, result.notices], [[], []]);
});

test("a fallback to an effect the host also lacks drops with a note", async () => {
  // Droid cannot inject before a tool call, so a notify that falls back to inject has nowhere to go.
  const plugin = toolPlugin("tool.before", [{ effect: "inject", text: "x", fallback: ["notify"] }]);
  const event = sampleEvent(droid, "tool.before", "x");
  const supported = await runEngine({ event, plugins: [plugin], settings, firedThisSession: new Set() });
  assert.deepEqual(supported.notices, [{ pluginId: "test-plugin", text: "x" }]);
  const noNotify = { ...event, host: { ...event.host, supports: ["block" as const] } };
  const dropped = await runEngine({ event: noNotify, plugins: [plugin], settings, firedThisSession: new Set() });
  assert.deepEqual([dropped.context, dropped.notices], [[], []]);
  assert.equal(dropped.trace[0]?.note, "host cannot add context here; no listed fallback works; dropped");
});

test("without a fallback a block keeps today's notice and note", async () => {
  const { result, note } = await composeAfterTool(qoder, afterToolPlugin(block()));
  assert.deepEqual(result.notices, [{ pluginId: "test-plugin", text: "revert it" }]);
  assert.equal(note, "host cannot block here; shown as a notice");
});

test("a block with no rule-backed check never falls back", async () => {
  const modelOnly = { any: { kind: "classify", labels: ["x"], field: "cwd" } } as PluginSpec["checks"];
  const plugin = { ...afterToolPlugin(block(["inject"]), modelOnly), when: "true" };
  const { result, note } = await composeAfterTool(qoder, plugin);
  assert.deepEqual([result.context, result.notices, result.block], [[], [], undefined]);
  assert.equal(note, "block dropped: no rule-backed check agreed");
});

test("an inject reached by fallback counts against the context budget", async () => {
  const { result, note } = await composeAfterTool(qoder, afterToolPlugin(block(["inject"])), 5);
  assert.deepEqual(result.context, []);
  assert.match(note ?? "", /over context budget \(5 chars\); dropped/);
});

test("a block still blocks where the host can, whatever the fallback says", async () => {
  const { result } = await composeAfterTool(claudeCode, afterToolPlugin(block(["inject"])));
  assert.equal(result.block?.reason, "revert it");
  assert.deepEqual(result.context, []);
});

const MANIFEST = {
  schema: 1,
  id: "fb",
  events: ["tool.after"],
  when: "true",
  then: [{ effect: "block", reason: "r", fallback: ["inject", "notify"] }],
};

function compileRaw(manifest: Record<string, unknown>) {
  const defaults = { routeOrigins: ["user" as const], knownHosts: KNOWN_HOSTS };
  return compileManifest(manifest, "/tmp/fb", undefined, defaults);
}

test("fallback compiles, and a manifest without it compiles as before", () => {
  assert.deepEqual(compileRaw(MANIFEST).base.effects[0], {
    effect: "block",
    reason: "r",
    suppressOriginalPrompt: false,
    fallback: ["inject", "notify"],
  });
  const plain = compileRaw({ ...MANIFEST, then: [{ effect: "inject", text: "t" }] }).base.effects[0];
  assert.deepEqual(plain, { effect: "inject", text: "t" });
});

test("fallback rejects block, unknown values, duplicates and the effect's own kind", () => {
  const reject = (fallback: unknown, pattern: RegExp) =>
    assert.throws(() => compileRaw({ ...MANIFEST, then: [{ effect: "block", reason: "r", fallback }] }), pattern);
  reject(["block"], /cannot contain 'block'/);
  reject(["email"], /unknown effect 'email'/);
  reject(["inject", "inject"], /lists 'inject' twice/);
  reject("inject", /must be a list/);
  assert.throws(
    () => compileRaw({ ...MANIFEST, then: [{ effect: "inject", text: "t", fallback: ["inject"] }] }),
    /own kind 'inject'/,
  );
});

test("capabilities include each fallback kind", () => {
  const caps = capabilitiesOf(
    compileRaw({ ...MANIFEST, then: [{ effect: "notify", text: "t", fallback: ["inject"] }] }).base,
  );
  assert.ok(caps.includes("notify") && caps.includes("inject"));
});
