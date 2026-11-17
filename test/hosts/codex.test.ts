import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANONICAL_EVENTS, type CanonicalEvent, emptyResult, type HubResult } from "../../src/core/types.ts";
import { codex } from "../../src/hosts/codex.ts";
import { ConfigEditError } from "../../src/hosts/json-config.ts";
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

function fixtureEvent(event: CanonicalEvent, name = FIXTURE[event]) {
  return parseOrFail(codex, event, readFixture("codex", name));
}

test("codex parses each fixture into the canonical event", () => {
  const prompt = fixtureEvent("prompt.submit");
  assert.equal(prompt.host.id, "codex");
  assert.equal(prompt.host.nativeEvent, "UserPromptSubmit");
  assert.equal(prompt.host.version, null);
  assert.equal(prompt.sessionId, "0197e2b4-7a3c-7d10-9c1e-5f3a2b6d8e41");
  assert.equal(prompt.cwd, "/Users/me/proj");
  assert.equal(prompt.origin, "user");
  assert.equal(prompt.prompt, "fix the failing test");

  const start = fixtureEvent("session.start");
  assert.equal(start.source, "startup");
  assert.equal(start.origin, "unknown");
  assert.deepEqual(start.host.supports, ["inject", "notify"]);

  const bash = fixtureEvent("tool.before");
  assert.deepEqual(bash.tool, { name: "Bash", canonicalName: "Bash", input: { command: "git status --short" } });

  const after = fixtureEvent("tool.after");
  assert.equal(after.tool?.name, "mcp__github__get_issue");
  assert.equal(after.tool?.canonicalName, "mcp__github__get_issue");
});

test("codex maps apply_patch to Edit and keeps the native name", () => {
  const patch = fixtureEvent("tool.before", "PreToolUse-apply_patch.json");
  assert.equal(patch.tool?.name, "apply_patch");
  assert.equal(patch.tool?.canonicalName, "Edit");
});

test("codex treats a subagent's prompt as a system prompt", () => {
  assert.equal(fixtureEvent("prompt.submit", "UserPromptSubmit-subagent.json").origin, "system");
});

const EXPECTED: Record<CanonicalEvent, Record<ResultShape, string>> = {
  "prompt.submit": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: '{"decision":"block","reason":"no secrets"}',
    blockSuppress: '{"decision":"block","reason":"no secrets"}',
  },
  "session.start": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: "",
    blockSuppress: "",
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
  test(`codex renders every result shape for ${event}`, () => {
    const parsed = fixtureEvent(event);
    for (const [shape, result] of Object.entries(RESULT_SHAPES) as [ResultShape, HubResult][]) {
      assert.equal(codex.render(result, parsed), EXPECTED[event][shape], `${event} / ${shape}`);
    }
  });
}

/** Universal fields of every output struct: HookUniversalOutputWire, codex-rs/hooks/src/schema.rs:91-100. */
const UNIVERSAL = ["continue", "stopReason", "suppressOutput", "systemMessage"];

/**
 * Keys each output struct accepts; all are deny_unknown_fields. Top level:
 * UserPromptSubmitCommandOutputWire schema.rs:431-441, SessionStartCommandOutputWire
 * schema.rs:389-396, PreToolUseCommandOutputWire schema.rs:132-141,
 * PostToolUseCommandOutputWire schema.rs:147-156. hookSpecificOutput:
 * schema.rs:445-450, 399-404, 245-256 and 232-240 respectively.
 */
const ALLOWED: Record<CanonicalEvent, { top: string[]; specific: string[] }> = {
  "prompt.submit": {
    top: [...UNIVERSAL, "decision", "reason", "hookSpecificOutput"],
    specific: ["hookEventName", "additionalContext"],
  },
  "session.start": { top: [...UNIVERSAL, "hookSpecificOutput"], specific: ["hookEventName", "additionalContext"] },
  "tool.before": {
    top: [...UNIVERSAL, "decision", "reason", "hookSpecificOutput"],
    specific: ["hookEventName", "permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext"],
  },
  "tool.after": {
    top: [...UNIVERSAL, "decision", "reason", "hookSpecificOutput"],
    specific: ["hookEventName", "additionalContext", "updatedMCPToolOutput"],
  },
};

const MIXED: HubResult = {
  ...RESULT_SHAPES.context,
  notices: RESULT_SHAPES.notice.notices,
  block: RESULT_SHAPES.blockSuppress.block,
};

test("codex output only ever holds keys the Codex structs accept", () => {
  for (const event of CANONICAL_EVENTS) {
    const parsed = fixtureEvent(event);
    const allowed = ALLOWED[event];
    for (const result of [...Object.values(RESULT_SHAPES), MIXED]) {
      const text = codex.render(result, parsed);
      if (text === "") continue;
      const out = JSON.parse(text);
      for (const key of Object.keys(out)) assert.ok(allowed.top.includes(key), `${event}: unexpected key ${key}`);
      if (out.decision !== undefined) assert.equal(out.decision, "block");
      const specific = out.hookSpecificOutput;
      if (specific === undefined) continue;
      assert.equal(specific.hookEventName, codex.nativeEvents[event]);
      for (const key of Object.keys(specific)) assert.ok(allowed.specific.includes(key), `${event}: unexpected ${key}`);
      if (specific.permissionDecision !== undefined) assert.equal(specific.permissionDecision, "deny");
    }
  }
});

test("codex replaces an empty block reason, which Codex would reject", () => {
  const blank: HubResult = { ...emptyResult(), block: { reason: "  ", suppressOriginalPrompt: false, pluginId: "p" } };
  assert.equal(
    codex.render(blank, fixtureEvent("prompt.submit")),
    '{"decision":"block","reason":"Blocked by a hookmux plugin."}',
  );
  const deny = JSON.parse(codex.render(blank, fixtureEvent("tool.before")));
  assert.equal(deny.hookSpecificOutput.permissionDecisionReason, "Blocked by a hookmux plugin.");
});

test("codex renders a block with its notice and drops the context", () => {
  assert.equal(
    codex.render(MIXED, fixtureEvent("prompt.submit")),
    '{"systemMessage":"heads up","decision":"block","reason":"no secrets"}',
  );
});

test("codex sample payloads parse back into their event", () => {
  for (const event of CANONICAL_EVENTS) {
    const sample = codex.sample(event, "hello");
    assert.equal(sample.hook_event_name, codex.nativeEvents[event]);
    assert.ok(parseOrFail(codex, event, sample));
  }
  assert.equal(parseOrFail(codex, "prompt.submit", codex.sample("prompt.submit", "hello")).prompt, "hello");
});

function codexHome(): { dir: string; env: NodeJS.ProcessEnv; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-codex-"));
  return { dir, env: { CODEX_HOME: dir }, file: join(dir, "hooks.json") };
}

test("codex writes $CODEX_HOME/hooks.json with the timeout in seconds and an approval note", () => {
  const { dir, env, file } = codexHome();
  assertFileUnder(codex, env, dir);
  assert.equal(codex.config.file(env), file);
  const change = codex.config.install({ launcher: LAUNCHER, events: ["tool.before"], timeoutSec: 7 }, env);
  assert.ok(change.notes.some((n) => n.includes("/hooks")));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: `${LAUNCHER} --host codex --event tool.before`, timeout: 7 }] },
      ],
    },
  });
  const again = codex.config.install({ launcher: LAUNCHER, events: ["tool.before"], timeoutSec: 7 }, env);
  assert.equal(again.changed, false);
  assert.ok(again.notes.some((n) => n.includes("/hooks")));
});

test("codex refuses a hooks.json with root keys Codex rejects, without writing", () => {
  const { env, file } = codexHome();
  const original = JSON.stringify({ description: "mine", hooks: {}, hookmux: { version: 1 } });
  writeFileSync(file, original);
  assert.throws(
    () => codex.config.install({ launcher: LAUNCHER, events: ["prompt.submit"], timeoutSec: 5 }, env),
    (error: Error) => error instanceof ConfigEditError && error.message.includes("hookmux"),
  );
  assert.throws(() => codex.config.uninstall(LAUNCHER, env), ConfigEditError);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(`${file}.hookmux.bak`), false);
  assert.deepEqual(codex.config.installed(LAUNCHER, env), []);
});

test("codex detects the Codex home dir", () => {
  const { dir, env } = codexHome();
  assert.equal(codex.config.detect(env), true);
  const missing = join(dir, "absent");
  assert.equal(codex.config.detect({ CODEX_HOME: missing }), false);
  mkdirSync(missing);
  assert.equal(codex.config.detect({ CODEX_HOME: missing }), true);
});

configEditorCases({
  adapter: codex,
  envFor: (dir) => ({ CODEX_HOME: dir }),
  foreignRoot: { description: "my own hooks" },
});
