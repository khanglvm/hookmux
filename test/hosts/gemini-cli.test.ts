import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CANONICAL_EVENTS, type CanonicalEvent, type HubResult } from "../../src/core/types.ts";
import { geminiCli } from "../../src/hosts/gemini-cli.ts";
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
  "prompt.submit": "BeforeAgent.json",
  "session.start": "SessionStart.json",
  "tool.before": "BeforeTool.json",
  "tool.after": "AfterTool.json",
};

function fixtureEvent(event: CanonicalEvent) {
  return parseOrFail(geminiCli, event, readFixture("gemini-cli", FIXTURE[event]));
}

test("gemini-cli parses each fixture into the canonical event", () => {
  const prompt = fixtureEvent("prompt.submit");
  assert.equal(prompt.host.id, "gemini-cli");
  assert.equal(prompt.host.nativeEvent, "BeforeAgent");
  assert.equal(prompt.host.version, null);
  assert.equal(prompt.sessionId, "00000000-0000-4000-8000-000000000001");
  assert.equal(prompt.cwd, "/work/proj");
  assert.equal(prompt.origin, "user");
  assert.equal(prompt.prompt, "fix the failing test");

  const start = fixtureEvent("session.start");
  assert.equal(start.source, "startup");
  assert.deepEqual(start.host.supports, ["inject", "notify"]);

  const before = fixtureEvent("tool.before");
  assert.deepEqual(before.tool, {
    name: "run_shell_command",
    canonicalName: "Bash",
    input: { command: "git status", description: "show status" },
  });
  assert.deepEqual(before.host.supports, ["block", "notify"]);

  const after = fixtureEvent("tool.after");
  assert.equal(after.tool?.name, "write_file");
  assert.equal(after.tool?.canonicalName, "Write");
});

test("gemini-cli maps built-in tool names and passes others through", () => {
  const expected: Record<string, string> = {
    run_shell_command: "Bash",
    write_file: "Write",
    replace: "Edit",
    read_file: "Read",
    glob: "Glob",
    grep_search: "Grep",
    list_directory: "LS",
    mcp_github_get_issue: "mcp_github_get_issue",
    web_fetch: "web_fetch",
  };
  for (const [native, canonical] of Object.entries(expected)) {
    const parsed = parseOrFail(geminiCli, "tool.before", { tool_name: native, tool_input: {} });
    assert.equal(parsed.tool?.canonicalName, canonical, native);
    assert.equal(parsed.tool?.name, native);
  }
});

const EXPECTED: Record<CanonicalEvent, Record<ResultShape, string>> = {
  "prompt.submit": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: '{"continue":false,"stopReason":"no secrets"}',
    blockSuppress: '{"decision":"deny","reason":"no secrets"}',
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
    context: "",
    notice: '{"systemMessage":"heads up"}',
    block: '{"decision":"deny","reason":"no secrets"}',
    blockSuppress: '{"decision":"deny","reason":"no secrets"}',
  },
  "tool.after": {
    empty: "",
    context: '{"hookSpecificOutput":{"hookEventName":"AfterTool","additionalContext":"first\\n\\nsecond"}}',
    notice: '{"systemMessage":"heads up"}',
    block: '{"decision":"deny","reason":"no secrets"}',
    blockSuppress: '{"decision":"deny","reason":"no secrets"}',
  },
};

for (const event of CANONICAL_EVENTS) {
  test(`gemini-cli renders every result shape for ${event}`, () => {
    const parsed = fixtureEvent(event);
    for (const [shape, result] of Object.entries(RESULT_SHAPES) as [ResultShape, HubResult][]) {
      assert.equal(geminiCli.render(result, parsed), EXPECTED[event][shape], `${event} / ${shape}`);
    }
  });
}

test("gemini-cli renders a JSON object or nothing, never plain text", () => {
  const mixed: HubResult = {
    ...RESULT_SHAPES.context,
    notices: RESULT_SHAPES.notice.notices,
    block: RESULT_SHAPES.block.block,
  };
  for (const event of CANONICAL_EVENTS) {
    for (const result of [...Object.values(RESULT_SHAPES), mixed]) {
      const text = geminiCli.render(result, fixtureEvent(event));
      if (text === "") continue;
      const out = JSON.parse(text);
      assert.equal(typeof out, "object");
      assert.ok(!Array.isArray(out));
    }
  }
  assert.equal(
    geminiCli.render(mixed, fixtureEvent("prompt.submit")),
    '{"systemMessage":"heads up","continue":false,"stopReason":"no secrets"}',
  );
});

test("gemini-cli sample payloads parse back into their event", () => {
  for (const event of CANONICAL_EVENTS) {
    const sample = geminiCli.sample(event, "hello");
    assert.equal(sample.hook_event_name, geminiCli.nativeEvents[event]);
    assert.ok(parseOrFail(geminiCli, event, sample));
  }
  assert.equal(parseOrFail(geminiCli, "prompt.submit", geminiCli.sample("prompt.submit", "hello")).prompt, "hello");
});

function geminiHome(): { dir: string; env: NodeJS.ProcessEnv; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-gemini-cli-"));
  return { dir, env: { GEMINI_CLI_HOME: dir }, file: join(dir, ".gemini", "settings.json") };
}

test("gemini-cli writes named handlers with the timeout in milliseconds and a trust note", () => {
  const { dir, env, file } = geminiHome();
  assertFileUnder(geminiCli, env, dir);
  assert.equal(geminiCli.config.file(env), file);
  const change = geminiCli.config.install({ launcher: LAUNCHER, events: ["tool.before"], timeoutSec: 7 }, env);
  assert.ok(change.notes.some((n) => n.includes("trusted")));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    hooks: {
      BeforeTool: [
        {
          hooks: [
            {
              type: "command",
              name: "hookmux",
              command: `${LAUNCHER} --host gemini-cli --event tool.before`,
              timeout: 7000,
            },
          ],
        },
      ],
    },
  });
});

test("gemini-cli refuses a settings.json with comments, without writing", () => {
  const { env, file } = geminiHome();
  const original = '{\n  // my theme\n  "ui": { "theme": "GitHub" }\n}\n';
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, original);
  assert.throws(
    () => geminiCli.config.install({ launcher: LAUNCHER, events: ["prompt.submit"], timeoutSec: 5 }, env),
    ConfigEditError,
  );
  assert.equal(readFileSync(file, "utf8"), original);
  assert.equal(existsSync(`${file}.hookmux.bak`), false);
});

test("gemini-cli detects the .gemini dir under GEMINI_CLI_HOME", () => {
  const { dir, env } = geminiHome();
  assert.equal(geminiCli.config.detect(env), false);
  mkdirSync(join(dir, ".gemini"));
  assert.equal(geminiCli.config.detect(env), true);
});

configEditorCases({
  adapter: geminiCli,
  envFor: (dir) => ({ GEMINI_CLI_HOME: dir }),
  foreignRoot: { ui: { theme: "GitHub" }, hooksConfig: { enabled: true } },
});
