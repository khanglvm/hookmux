// Golden tests for the clients built on claude-style.ts: Qwen Code, Factory
// Droid, Qoder CLI and CodeBuddy Code. Payloads follow each client's documented
// input; expected stdout follows each client's documented output contract.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANONICAL_EVENTS, type CanonicalEvent, type HubResult } from "../../src/core/types.ts";
import { codebuddy } from "../../src/hosts/codebuddy.ts";
import { droid } from "../../src/hosts/droid.ts";
import { qoder } from "../../src/hosts/qoder.ts";
import { qwenCode } from "../../src/hosts/qwen-code.ts";
import type { HostAdapter } from "../../src/hosts/types.ts";
import { configEditorCases, LAUNCHER, parseOrFail, RESULT_SHAPES, type ResultShape } from "./helpers.ts";

const NATIVE: Record<CanonicalEvent, string> = {
  "prompt.submit": "UserPromptSubmit",
  "session.start": "SessionStart",
  "tool.before": "PreToolUse",
  "tool.after": "PostToolUse",
};

/** A documented payload for each event, with the client's own shell tool name. */
function payload(event: CanonicalEvent, shellTool: string): Record<string, unknown> {
  const base = { session_id: "abc123", transcript_path: "/t.jsonl", cwd: "/work/proj", hook_event_name: NATIVE[event] };
  if (event === "prompt.submit")
    return { ...base, prompt: "fix the failing test", submitted_prompt: "fix the failing test" };
  if (event === "session.start") return { ...base, source: "startup" };
  const tool = { ...base, tool_name: shellTool, tool_input: { command: "git status" } };
  return event === "tool.before" ? tool : { ...tool, tool_response: { stdout: "clean" } };
}

const deny = (native: string) =>
  `{"hookSpecificOutput":{"hookEventName":"${native}","permissionDecision":"deny","permissionDecisionReason":"no secrets"}}`;
const context = (native: string) =>
  `{"hookSpecificOutput":{"hookEventName":"${native}","additionalContext":"first\\n\\nsecond"}}`;

interface HostCase {
  adapter: HostAdapter;
  shellTool: string;
  /** Expected block output on prompt.submit, and on tool.after ("" when the client cannot block there). */
  blockPrompt: string;
  blockAfter: string;
  /** Whether tool.before can add context. */
  injectBefore: boolean;
}

const CASES: HostCase[] = [
  {
    adapter: qwenCode,
    shellTool: "run_shell_command",
    blockPrompt: '{"decision":"block","reason":"no secrets"}',
    blockAfter: '{"decision":"block","reason":"no secrets"}',
    injectBefore: true,
  },
  {
    adapter: droid,
    shellTool: "Execute",
    blockPrompt: '{"decision":"block","reason":"no secrets"}',
    blockAfter: '{"decision":"block","reason":"no secrets"}',
    injectBefore: false,
  },
  {
    adapter: qoder,
    shellTool: "Bash",
    blockPrompt: '{"decision":"deny","reason":"no secrets"}',
    blockAfter: "",
    injectBefore: true,
  },
  {
    adapter: codebuddy,
    shellTool: "Bash",
    blockPrompt: '{"continue":false,"reason":"no secrets"}',
    blockAfter: "",
    injectBefore: true,
  },
];

function expected(c: HostCase, event: CanonicalEvent, shape: ResultShape): string {
  const native = NATIVE[event];
  if (shape === "empty") return "";
  if (shape === "notice") return '{"systemMessage":"heads up"}';
  if (shape === "context") return event === "tool.before" && !c.injectBefore ? "" : context(native);
  // block and blockSuppress render the same: no client here has a suppress key.
  if (event === "prompt.submit") return c.blockPrompt;
  if (event === "tool.before") return deny(native);
  if (event === "tool.after") return c.blockAfter;
  return "";
}

for (const c of CASES) {
  const { adapter } = c;

  test(`${adapter.id} parses a documented payload for every event`, () => {
    for (const event of CANONICAL_EVENTS) {
      const parsed = parseOrFail(adapter, event, payload(event, c.shellTool));
      assert.equal(parsed.host.id, adapter.id);
      assert.equal(parsed.host.nativeEvent, NATIVE[event]);
      assert.equal(parsed.sessionId, "abc123");
      assert.equal(parsed.cwd, "/work/proj");
      if (event.startsWith("tool.")) assert.equal(parsed.tool?.canonicalName, "Bash");
    }
    assert.equal(parseOrFail(adapter, "prompt.submit", payload("prompt.submit", c.shellTool)).origin, "user");
  });

  for (const event of CANONICAL_EVENTS) {
    test(`${adapter.id} renders every result shape for ${event}`, () => {
      const parsed = parseOrFail(adapter, event, payload(event, c.shellTool));
      for (const [shape, result] of Object.entries(RESULT_SHAPES) as [ResultShape, HubResult][]) {
        assert.equal(adapter.render(result, parsed), expected(c, event, shape), `${event} / ${shape}`);
      }
    });
  }

  test(`${adapter.id} sample payloads parse back into their event`, () => {
    for (const event of CANONICAL_EVENTS) {
      const sample = adapter.sample(event, "hello");
      assert.equal(sample.hook_event_name, NATIVE[event]);
      const parsed = parseOrFail(adapter, event, sample);
      if (event === "prompt.submit") assert.equal(parsed.origin, "user", "test and explain simulate a user prompt");
    }
  });
}

test("qwen-code maps its tool names and counts a prompt without submitted_prompt as the system's", () => {
  const names: Record<string, string> = {
    run_shell_command: "Bash",
    write_file: "Write",
    edit: "Edit",
    read_file: "Read",
    web_fetch: "web_fetch",
  };
  for (const [native, canonical] of Object.entries(names)) {
    assert.equal(parseOrFail(qwenCode, "tool.before", { tool_name: native }).tool?.canonicalName, canonical);
  }
  const continuation = parseOrFail(qwenCode, "prompt.submit", { prompt: "tool result text" });
  assert.equal(continuation.origin, "system");
  assert.equal(continuation.prompt, "tool result text");
});

test("droid maps Execute, Create and ApplyPatch to portable names", () => {
  const names: Record<string, string> = {
    Execute: "Bash",
    Create: "Write",
    ApplyPatch: "Edit",
    Edit: "Edit",
    Read: "Read",
  };
  for (const [native, canonical] of Object.entries(names)) {
    assert.equal(parseOrFail(droid, "tool.before", { tool_name: native }).tool?.canonicalName, canonical);
  }
});

configEditorCases({
  adapter: qwenCode,
  envFor: (dir) => ({ QWEN_HOME: dir }),
  foreignRoot: { model: { name: "qwen3-coder" } },
});
configEditorCases({ adapter: qoder, envFor: (dir) => ({ QODER_CONFIG_DIR: dir }), foreignRoot: { theme: "dark" } });
configEditorCases({ adapter: codebuddy, envFor: (dir) => ({ HOME: dir }), foreignRoot: { theme: "dark" } });

function droidHome(): { env: NodeJS.ProcessEnv; hooksJson: string; settingsJson: string } {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-droid-"));
  mkdirSync(join(dir, ".factory"));
  return {
    env: { HOME: dir },
    hooksJson: join(dir, ".factory", "hooks.json"),
    settingsJson: join(dir, ".factory", "settings.json"),
  };
}

const ALL = { launcher: LAUNCHER, events: [...CANONICAL_EVENTS], timeoutSec: 5 };
const userGroup = { hooks: [{ type: "command", command: "/usr/local/bin/user-hook" }] };

test("droid writes events to hooks.json keyed by event name, keeping its other root keys", () => {
  const { env, hooksJson } = droidHome();
  writeFileSync(hooksJson, JSON.stringify({ hooksDisabled: false, Stop: [userGroup] }));
  const change = droid.config.install(ALL, env);
  assert.deepEqual(change.added, [...CANONICAL_EVENTS]);
  const written = JSON.parse(readFileSync(hooksJson, "utf8"));
  assert.equal(written.hooksDisabled, false);
  assert.deepEqual(written.Stop, [userGroup]);
  assert.equal(written.hooks, undefined);
  assert.equal(written.PreToolUse[0].hooks[0].command, `${LAUNCHER} --host droid --event tool.before`);
  assert.equal(written.PreToolUse[0].hooks[0].timeout, 5);
  assert.deepEqual(droid.config.installed(LAUNCHER, env), [...CANONICAL_EVENTS]);
});

test("droid adds an event to settings.json when only settings.json defines it, so hooks.json never shadows it", () => {
  const { env, hooksJson, settingsJson } = droidHome();
  writeFileSync(settingsJson, JSON.stringify({ model: "x", hooks: { UserPromptSubmit: [userGroup] } }));
  droid.config.install(ALL, env);
  const settings = JSON.parse(readFileSync(settingsJson, "utf8"));
  assert.equal(settings.model, "x");
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0], userGroup);
  const root = JSON.parse(readFileSync(hooksJson, "utf8"));
  assert.equal(root.UserPromptSubmit, undefined);
  assert.ok(Array.isArray(root.SessionStart));
  assert.deepEqual(droid.config.installed(LAUNCHER, env), [...CANONICAL_EVENTS]);

  const removed = droid.config.uninstall(LAUNCHER, env);
  assert.deepEqual(new Set(removed.removed), new Set(CANONICAL_EVENTS));
  assert.deepEqual(JSON.parse(readFileSync(settingsJson, "utf8")), {
    model: "x",
    hooks: { UserPromptSubmit: [userGroup] },
  });
  assert.deepEqual(JSON.parse(readFileSync(hooksJson, "utf8")), {});
  assert.deepEqual(droid.config.installed(LAUNCHER, env), []);
});

test("droid keeps an event in hooks.json when both files define it, because hooks.json wins", () => {
  const { env, hooksJson, settingsJson } = droidHome();
  writeFileSync(hooksJson, JSON.stringify({ PreToolUse: [userGroup] }));
  writeFileSync(settingsJson, JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));
  droid.config.install({ ...ALL, events: ["tool.before"] }, env);
  assert.equal(JSON.parse(readFileSync(hooksJson, "utf8")).PreToolUse.length, 2);
  assert.equal(JSON.parse(readFileSync(settingsJson, "utf8")).hooks.PreToolUse.length, 1);
});

test("droid refuses an unparseable settings.json before writing hooks.json", () => {
  const { env, hooksJson, settingsJson } = droidHome();
  // Droid accepts comments; hookmux cannot read this file, so it must not guess that UserPromptSubmit is free.
  writeFileSync(settingsJson, '{ // mine\n "hooks": { "UserPromptSubmit": [] } }');
  assert.throws(() => droid.config.install(ALL, env), /not valid JSON/);
  assert.equal(existsSync(hooksJson), false);
});

test("droid will not create hooks.json while Droid still reads the legacy hooks/hooks.json", () => {
  const { env, hooksJson } = droidHome();
  const legacy = join(hooksJson, "..", "hooks", "hooks.json");
  mkdirSync(join(legacy, ".."));
  writeFileSync(legacy, JSON.stringify({ PreToolUse: [userGroup] }));
  assert.doesNotThrow(() => droid.config.install({ ...ALL, events: [] }, env));
  assert.throws(() => droid.config.install(ALL, env), /legacy hooks file/);
  assert.equal(existsSync(hooksJson), false);
});

test("droid does not count a settings.json hub entry that hooks.json now shadows", () => {
  const { env, hooksJson, settingsJson } = droidHome();
  writeFileSync(settingsJson, JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));
  droid.config.install({ ...ALL, events: ["tool.before"] }, env);
  assert.deepEqual(droid.config.installed(LAUNCHER, env), ["tool.before"]);
  writeFileSync(hooksJson, JSON.stringify({ PreToolUse: [userGroup] }));
  assert.deepEqual(droid.config.installed(LAUNCHER, env), []);
  droid.config.install({ ...ALL, events: ["tool.before"] }, env);
  assert.deepEqual(droid.config.installed(LAUNCHER, env), ["tool.before"]);
});
