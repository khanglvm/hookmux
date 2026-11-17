import assert from "node:assert/strict";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../src/checks/index.ts";
import { runEngine } from "../src/core/engine.ts";
import { claudeCode } from "../src/hosts/claude-code.ts";
import { compileManifest, readManifest } from "../src/load/manifest.ts";

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
