import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANONICAL_EVENTS, type CanonicalEvent } from "../../src/core/types.ts";
import { claudeCode } from "../../src/hosts/claude-code.ts";
import {
  assertFileUnder,
  configEditorCases,
  LAUNCHER,
  parseOrFail,
  RESULT_SHAPES,
  type ResultShape,
  readFixture,
} from "./helpers.ts";

const FIXTURE: Record<CanonicalEvent, string> = {
  "prompt.submit": "UserPromptSubmit.json",
  "session.start": "SessionStart.json",
  "tool.before": "PreToolUse.json",
  "tool.after": "PostToolUse.json",
};

test("claude-code parses each fixture into the canonical event", () => {
  const prompt = parseOrFail(claudeCode, "prompt.submit", readFixture("claude-code", FIXTURE["prompt.submit"]));
  assert.equal(prompt.name, "prompt.submit");
  assert.equal(prompt.host.nativeEvent, "UserPromptSubmit");
  assert.equal(prompt.host.version, null);
  assert.equal(prompt.sessionId, "abc123");
  assert.equal(prompt.cwd, "/Users/me/proj");
  assert.equal(prompt.origin, "user");
  assert.equal(prompt.prompt, "fix the failing test");

  const start = parseOrFail(claudeCode, "session.start", readFixture("claude-code", FIXTURE["session.start"]));
  assert.equal(start.source, "startup");
  assert.equal(start.origin, "unknown");
  assert.deepEqual(start.host.supports, ["inject", "notify"]);

  const before = parseOrFail(claudeCode, "tool.before", readFixture("claude-code", FIXTURE["tool.before"]));
  assert.deepEqual(before.tool, { name: "Bash", canonicalName: "Bash", input: { command: "git status --short" } });

  const after = parseOrFail(claudeCode, "tool.after", readFixture("claude-code", FIXTURE["tool.after"]));
  assert.equal(after.tool?.canonicalName, "Write");
  assert.equal(after.host.nativeEvent, "PostToolUse");
});

test("claude-code marks task notifications as system prompts and rejects non-objects", () => {
  const note = parseOrFail(claudeCode, "prompt.submit", { session_id: "s", prompt: "<task-notification>done" });
  assert.equal(note.origin, "system");
  assert.equal(claudeCode.parse("prompt.submit", "not an object", {}), null);
  assert.equal(claudeCode.parse("prompt.submit", [1], {}), null);
});

const EXPECTED: Record<CanonicalEvent, Record<ResultShape, string>> = {
  "prompt.submit": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: '{"decision":"block","reason":"no secrets"}',
    blockSuppress:
      '{"decision":"block","reason":"no secrets","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","suppressOriginalPrompt":true}}',
  },
  "session.start": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: '{"decision":"block","reason":"no secrets"}',
    blockSuppress: '{"decision":"block","reason":"no secrets"}',
  },
  "tool.before": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block:
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no secrets"}}',
    blockSuppress:
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no secrets"}}',
  },
  "tool.after": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: '{"decision":"block","reason":"no secrets"}',
    blockSuppress: '{"decision":"block","reason":"no secrets"}',
  },
};

for (const event of CANONICAL_EVENTS) {
  test(`claude-code renders every result shape for ${event}`, () => {
    const parsed = parseOrFail(claudeCode, event, readFixture("claude-code", FIXTURE[event]));
    for (const [shape, result] of Object.entries(RESULT_SHAPES) as [
      ResultShape,
      (typeof RESULT_SHAPES)[ResultShape],
    ][]) {
      assert.equal(claudeCode.render(result, parsed), EXPECTED[event][shape], `${event} / ${shape}`);
    }
  });
}

test("claude-code sample payloads parse back into their event", () => {
  for (const event of CANONICAL_EVENTS) {
    const parsed = parseOrFail(claudeCode, event, claudeCode.sample(event, "hello"));
    assert.equal(parsed.host.nativeEvent, claudeCode.nativeEvents[event]);
  }
  assert.equal(parseOrFail(claudeCode, "prompt.submit", claudeCode.sample("prompt.submit", "hello")).prompt, "hello");
});

test("claude-code writes command handlers with the timeout in seconds", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-claude-code-"));
  const env = { CLAUDE_CONFIG_DIR: dir };
  assertFileUnder(claudeCode, env, dir);
  claudeCode.config.install({ launcher: LAUNCHER, events: ["prompt.submit"], timeoutSec: 7 }, env);
  const config = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(config.hooks.UserPromptSubmit, [
    { hooks: [{ type: "command", command: `${LAUNCHER} --host claude-code --event prompt.submit`, timeout: 7 }] },
  ]);
});

configEditorCases({
  adapter: claudeCode,
  envFor: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
  foreignRoot: { model: "opus", permissions: { allow: ["Bash(ls)"] } },
});

test("claude-code uninstall still deletes a hub group in the middle and notes the move", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-claude-"));
  const env = { CLAUDE_CONFIG_DIR: dir };
  const file = claudeCode.config.file(env);
  claudeCode.config.install({ launcher: LAUNCHER, events: ["prompt.submit"], timeoutSec: 5 }, env);
  const config = JSON.parse(readFileSync(file, "utf8"));
  const user = { hooks: [{ type: "command", command: "/usr/local/bin/after-hub" }] };
  config.hooks.UserPromptSubmit.push(user);
  writeFileSync(file, JSON.stringify(config));
  const change = claudeCode.config.uninstall(LAUNCHER, env);
  assert.equal(change.notes.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hooks.UserPromptSubmit, [user]);
});
