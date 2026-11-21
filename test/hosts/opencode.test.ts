// Golden tests for the opencode adapter: parsing and rendering, the plugin-file
// config editor, and the generated shim itself, run under node against a fake
// launcher so no real hookmux binary or opencode install is needed.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CANONICAL_EVENTS, type CanonicalEvent, type HubResult } from "../../src/core/types.ts";
import { ConfigEditError } from "../../src/hosts/json-config.ts";
import { opencode } from "../../src/hosts/opencode.ts";
import { assertFileUnder, LAUNCHER, parseOrFail, RESULT_SHAPES, type ResultShape } from "./helpers.ts";

function payload(event: CanonicalEvent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { session_id: "ses_abc", cwd: "/work/proj", hook_event_name: opencode.nativeEvents[event] };
  if (event === "prompt.submit") return { ...base, prompt: "fix the failing test", origin: "user", ...overrides };
  if (event === "session.start") return { ...base, ...overrides };
  const tool = { ...base, tool_name: "bash", tool_input: { command: "git status" }, ...overrides };
  return event === "tool.before" ? tool : { ...tool, tool_response: "clean" };
}

test("opencode parses a payload for every event", () => {
  for (const event of CANONICAL_EVENTS) {
    const parsed = parseOrFail(opencode, event, payload(event));
    assert.equal(parsed.host.id, "opencode");
    assert.equal(parsed.host.nativeEvent, opencode.nativeEvents[event]);
    assert.equal(parsed.host.version, null);
    assert.equal(parsed.sessionId, "ses_abc");
    assert.equal(parsed.cwd, "/work/proj");
    if (event.startsWith("tool.")) assert.equal(parsed.tool?.canonicalName, "Bash");
  }
  assert.equal(parseOrFail(opencode, "prompt.submit", payload("prompt.submit")).origin, "user");
});

test("opencode maps its built-in tool ids and passes unknown ones through", () => {
  const names: Record<string, string> = {
    bash: "Bash",
    write: "Write",
    edit: "Edit",
    read: "Read",
    apply_patch: "Edit",
  };
  for (const [native, canonical] of Object.entries(names)) {
    assert.equal(parseOrFail(opencode, "tool.before", { tool_name: native }).tool?.canonicalName, canonical);
  }
  assert.equal(parseOrFail(opencode, "tool.before", { tool_name: "glob" }).tool?.canonicalName, "glob");
});

test("opencode origin: explicit payload field wins, then prompt presence, with no field and no prompt unknown", () => {
  assert.equal(parseOrFail(opencode, "prompt.submit", { origin: "system", prompt: "continue" }).origin, "system");
  assert.equal(parseOrFail(opencode, "prompt.submit", { prompt: "hi" }).origin, "user");
  assert.equal(parseOrFail(opencode, "prompt.submit", {}).origin, "unknown");
});

test("opencode copies filePath to file_path on the canonical tool input, leaving raw untouched", () => {
  const parsed = parseOrFail(opencode, "tool.before", { tool_name: "write", tool_input: { filePath: "/a/b.ts" } });
  assert.equal((parsed.tool?.input as Record<string, unknown>).file_path, "/a/b.ts");
  const raw = parsed.raw as Record<string, unknown>;
  assert.equal((raw.tool_input as Record<string, unknown>).file_path, undefined);
});

function expectedRender(event: CanonicalEvent, shape: ResultShape): string {
  if (shape === "empty") return "";
  if (shape === "notice") return '{"notice":"heads up"}';
  if (shape === "context") return event === "tool.before" ? "" : '{"context":"first\\n\\nsecond"}';
  // block and blockSuppress render the same: opencode has no suppress key.
  return event === "tool.before" ? '{"block":"no secrets"}' : "";
}

for (const event of CANONICAL_EVENTS) {
  test(`opencode renders every result shape for ${event}`, () => {
    const parsed = parseOrFail(opencode, event, payload(event));
    for (const [shape, result] of Object.entries(RESULT_SHAPES) as [ResultShape, HubResult][]) {
      assert.equal(opencode.render(result, parsed), expectedRender(event, shape), `${event} / ${shape}`);
    }
  });
}

test("opencode sample payloads parse back into their event", () => {
  for (const event of CANONICAL_EVENTS) {
    const sample = opencode.sample(event, "hello");
    assert.equal(sample.hook_event_name, opencode.nativeEvents[event]);
    const parsed = parseOrFail(opencode, event, sample);
    if (event === "prompt.submit") assert.equal(parsed.origin, "user");
  }
});

// --- config editor -----------------------------------------------------

function pluginFile(dir: string): string {
  return opencode.config.file({ XDG_CONFIG_HOME: dir });
}

const ALL = { launcher: LAUNCHER, events: [...CANONICAL_EVENTS], timeoutSec: 5 };

test("opencode config: fresh install writes a marked plugin file for every event", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  const env = { XDG_CONFIG_HOME: dir };
  const change = opencode.config.install(ALL, env);
  assert.equal(change.changed, true);
  assert.deepEqual(change.added, [...CANONICAL_EVENTS]);
  assert.deepEqual(opencode.config.installed(LAUNCHER, env), [...CANONICAL_EVENTS]);
  const text = readFileSync(pluginFile(dir), "utf8");
  assert.match(text, /^\/\/ hookmux generated this opencode plugin/);
  assert.ok(text.includes(`const LAUNCHER = ${JSON.stringify(LAUNCHER)};`));
  assert.ok(text.includes(`const EVENTS = ${JSON.stringify([...CANONICAL_EVENTS])};`));
});

test("opencode config: installing the same events again changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  const env = { XDG_CONFIG_HOME: dir };
  opencode.config.install(ALL, env);
  const before = readFileSync(pluginFile(dir), "utf8");
  const again = opencode.config.install(ALL, env);
  assert.equal(again.changed, false);
  assert.deepEqual(again.added, []);
  assert.equal(readFileSync(pluginFile(dir), "utf8"), before);
});

test("opencode config: a second install with new events writes the union", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  const env = { XDG_CONFIG_HOME: dir };
  opencode.config.install({ ...ALL, events: ["tool.before"] }, env);
  assert.deepEqual(opencode.config.installed(LAUNCHER, env), ["tool.before"]);
  const change = opencode.config.install({ ...ALL, events: ["prompt.submit"] }, env);
  assert.deepEqual(change.added, ["prompt.submit"]);
  assert.deepEqual(opencode.config.installed(LAUNCHER, env), ["prompt.submit", "tool.before"]);
});

test("opencode config: refuses a file at the same path that hookmux did not write", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  const env = { XDG_CONFIG_HOME: dir };
  const file = pluginFile(dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "export default () => ({});\n");
  assert.throws(() => opencode.config.install(ALL, env), ConfigEditError);
  assert.equal(opencode.config.installed(LAUNCHER, env).length, 0);
});

test("opencode config: uninstall removes the file only when it carries this launcher's marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  const env = { XDG_CONFIG_HOME: dir };
  opencode.config.install(ALL, env);
  const removedByOther = opencode.config.uninstall("/other/launcher", env);
  assert.equal(removedByOther.changed, false);
  assert.equal(existsSync(pluginFile(dir)), true);
  const removed = opencode.config.uninstall(LAUNCHER, env);
  assert.deepEqual(removed.removed, [...CANONICAL_EVENTS]);
  assert.equal(existsSync(pluginFile(dir)), false);
});

test("opencode config: doctor's probe with no events writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  const env = { XDG_CONFIG_HOME: dir };
  const change = opencode.config.install({ ...ALL, events: [] }, env);
  assert.equal(change.changed, false);
  assert.equal(existsSync(pluginFile(dir)), false);
});

test("opencode config: XDG_CONFIG_HOME moves the plugin file", () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-"));
  assertFileUnder(opencode, { XDG_CONFIG_HOME: dir }, dir);
});

// --- the generated shim --------------------------------------------------

type ShimHookFn = (input: Record<string, unknown>, output?: Record<string, unknown>) => Promise<void>;

interface ShimHooks {
  event: ShimHookFn;
  "chat.message": ShimHookFn;
  "tool.execute.before": ShimHookFn;
  "tool.execute.after": ShimHookFn;
}

interface FakePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text: string;
  synthetic?: boolean;
}

/** Writes an executable fake launcher that answers from $FAKE_ANSWERS, keyed by canonical event. */
function writeFakeLauncher(dir: string): string {
  const file = join(dir, "fake-launcher.mjs");
  writeFileSync(
    file,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'const i = process.argv.indexOf("--event");',
      'const event = i >= 0 ? process.argv[i + 1] : "";',
      // Like the real launcher with no engine installed: exits without reading stdin.
      'if (process.env.FAKE_MODE === "noread") process.exit(0);',
      'let data = "";',
      'process.stdin.on("data", (c) => { data += c; });',
      'process.stdin.on("end", () => {',
      "  if (process.env.FAKE_ECHO_FILE) {",
      "    try { appendFileSync(process.env.FAKE_ECHO_FILE, `${event}\\t${data}\\n`); } catch {}",
      "  }",
      '  const mode = process.env.FAKE_MODE || "answer";',
      '  if (mode === "hang") return;',
      '  if (mode === "nonzero") { process.exit(1); }',
      '  if (mode === "garbage") { process.stdout.write("not-json"); process.exit(0); }',
      "  const answers = process.env.FAKE_ANSWERS ? JSON.parse(process.env.FAKE_ANSWERS) : {};",
      '  if (event === process.env.FAKE_SLOW_EVENT) { setTimeout(() => { process.stdout.write(answers[event] ?? ""); process.exit(0); }, 400); return; }',
      '  process.stdout.write(answers[event] ?? "");',
      "  process.exit(0);",
      "});",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return file;
}

/** Installs a real plugin file against a fake launcher and loads it as the shim tests would see it. */
async function loadShim(dir: string, timeoutSec = 5): Promise<(input: unknown) => Promise<ShimHooks>> {
  const launcher = writeFakeLauncher(dir);
  const env = { XDG_CONFIG_HOME: dir };
  opencode.config.install({ launcher, events: [...CANONICAL_EVENTS], timeoutSec }, env);
  const mod = (await import(pathToFileURL(opencode.config.file(env)).href)) as {
    default: (input: unknown) => Promise<ShimHooks>;
  };
  return mod.default;
}

test("opencode shim: inject on chat.message pushes a valid synthetic part", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_ANSWERS = JSON.stringify({ "prompt.submit": JSON.stringify({ context: "extra context" }) });
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  const output = {
    message: { id: "msg_1" },
    parts: [{ id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "hi" }],
  };
  await hooks["chat.message"]({ sessionID: "ses_1", messageID: "msg_1" }, output);
  const parts = output.parts as FakePart[];
  assert.equal(parts.length, 2);
  const added = parts[1] as FakePart;
  assert.equal(added.type, "text");
  assert.equal(added.text, "extra context");
  assert.equal(added.synthetic, true);
  assert.equal(added.sessionID, "ses_1");
  assert.equal(added.messageID, "msg_1");
  assert.match(added.id, /^prt_/);
  delete process.env.FAKE_ANSWERS;
});

test("opencode shim: context queued at session.created lands on that session's first prompt only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_ANSWERS = JSON.stringify({ "session.start": JSON.stringify({ context: "welcome" }) });
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_2" } } } });

  const first = {
    message: { id: "msg_a" },
    parts: [{ id: "prt_a", sessionID: "ses_2", messageID: "msg_a", type: "text", text: "hi" }],
  };
  await hooks["chat.message"]({ sessionID: "ses_2", messageID: "msg_a" }, first);
  assert.equal((first.parts as FakePart[]).length, 2);
  assert.equal((first.parts as FakePart[])[1]?.text, "welcome");

  const second = {
    message: { id: "msg_b" },
    parts: [{ id: "prt_b", sessionID: "ses_2", messageID: "msg_b", type: "text", text: "more" }],
  };
  await hooks["chat.message"]({ sessionID: "ses_2", messageID: "msg_b" }, second);
  assert.equal((second.parts as FakePart[]).length, 1);
  delete process.env.FAKE_ANSWERS;
});

test("opencode shim: session.start context that answers after the first prompt starts still lands on it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_ANSWERS = JSON.stringify({ "session.start": JSON.stringify({ context: "late welcome" }) });
  process.env.FAKE_SLOW_EVENT = "session.start";
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  // opencode does not await the event hook, so the first prompt starts while session.start runs.
  void hooks.event({ event: { type: "session.created", properties: { info: { id: "ses_late" } } } });
  const first = {
    message: { id: "msg_l" },
    parts: [{ id: "prt_l", sessionID: "ses_late", messageID: "msg_l", type: "text", text: "hi" }],
  };
  await hooks["chat.message"]({ sessionID: "ses_late", messageID: "msg_l" }, first);
  assert.equal((first.parts as FakePart[])[1]?.text, "late welcome");
  delete process.env.FAKE_ANSWERS;
  delete process.env.FAKE_SLOW_EVENT;
});

test("opencode shim: subagent prompts carry origin system", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  const echo = join(dir, "echo.log");
  process.env.FAKE_ECHO_FILE = echo;
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "ses_3", parentID: "ses_root" } } },
  });
  await hooks["chat.message"](
    { sessionID: "ses_3", messageID: "msg_c" },
    {
      message: { id: "msg_c" },
      parts: [{ id: "prt_c", sessionID: "ses_3", messageID: "msg_c", type: "text", text: "x" }],
    },
  );
  const lines = readFileSync(echo, "utf8").trim().split("\n");
  const promptLine = lines.find((l) => l.startsWith("prompt.submit\t"));
  assert.ok(promptLine);
  const sent = JSON.parse(promptLine.split("\t")[1] as string);
  assert.equal(sent.origin, "system");
  delete process.env.FAKE_ECHO_FILE;
});

test("opencode shim: block on tool.execute.before throws with the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_ANSWERS = JSON.stringify({ "tool.before": JSON.stringify({ block: "no secrets" }) });
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  await assert.rejects(
    hooks["tool.execute.before"]({ sessionID: "ses_4", tool: "bash" }, { args: { command: "rm -rf /" } }),
    /no secrets/,
  );
  delete process.env.FAKE_ANSWERS;
});

test("opencode shim: a launcher that hangs is killed at the timeout and the hook resolves without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_MODE = "hang";
  const factory = await loadShim(dir, 1);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  const output = {
    message: { id: "msg_5" },
    parts: [{ id: "prt_5", sessionID: "ses_5", messageID: "msg_5", type: "text", text: "hi" }],
  };
  await hooks["chat.message"]({ sessionID: "ses_5", messageID: "msg_5" }, output);
  assert.equal(output.parts.length, 1);
  delete process.env.FAKE_MODE;
});

test("opencode shim: a launcher that exits without reading a large payload does not crash the host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_MODE = "noread";
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  const output = { output: "x".repeat(1 << 20) };
  await hooks["tool.execute.after"]({ sessionID: "ses_7", tool: "read", args: {} }, output);
  // Let the failed write's error event fire before the test ends.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(output.output.length, 1 << 20);
  delete process.env.FAKE_MODE;
});

test("opencode shim: garbage launcher stdout is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-opencode-shim-"));
  process.env.FAKE_MODE = "garbage";
  const factory = await loadShim(dir);
  const hooks = await factory({ directory: dir, client: { tui: { showToast: async () => {} } } });
  await assert.doesNotReject(
    hooks["tool.execute.before"]({ sessionID: "ses_6", tool: "bash" }, { args: { command: "echo ok" } }),
  );
  delete process.env.FAKE_MODE;
});
