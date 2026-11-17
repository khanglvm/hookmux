import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { firstShellWord, hubCommand, isHubCommand, shellQuote } from "../../src/hosts/hub-command.ts";

const PLAIN = "/opt/hookmux/bin/hookmux-hook";
const AWKWARD = "/Users/o'neil/My Tools/$HOME/~x/hookmux-hook";

test("plain launcher paths stay bare; anything else is single-quoted", () => {
  assert.equal(hubCommand(PLAIN, "codex", "prompt.submit"), `${PLAIN} --host codex --event prompt.submit`);
  assert.equal(shellQuote("~/bin/x"), "'~/bin/x'");
  assert.equal(shellQuote(AWKWARD), `'/Users/o'\\''neil/My Tools/$HOME/~x/hookmux-hook'`);
});

test("the shell reads a quoted launcher back as the exact path", () => {
  const word = execFileSync("sh", ["-c", `printf '%s' ${shellQuote(AWKWARD)}`], { encoding: "utf8" });
  assert.equal(word, AWKWARD);
});

test("hub commands are recognised by their exact first word and arguments", () => {
  assert.ok(isHubCommand(hubCommand(PLAIN, "codex", "tool.before"), PLAIN));
  assert.ok(isHubCommand(hubCommand(AWKWARD, "claude-code", "prompt.submit"), AWKWARD));
  assert.ok(isHubCommand(`"/a b/hookmux-hook" --host codex --event prompt.submit`, "/a b/hookmux-hook"), "legacy form");
  assert.ok(isHubCommand(`"/a \\"b\\"/h" --host codex --event prompt.submit`, '/a "b"/h'), "legacy escaped quote");
  for (const command of [
    `${PLAIN}-old --host codex --event prompt.submit`,
    `${PLAIN}`,
    `${PLAIN} --event prompt.submit --host codex`,
    `${PLAIN} --host codex`,
    `echo ${PLAIN} --host codex --event prompt.submit`,
    `/usr/local/bin/other --host x --event y ${PLAIN}`,
    `'${PLAIN} --host codex --event prompt.submit`,
    42,
  ]) {
    assert.equal(isHubCommand(command, PLAIN), false, String(command));
  }
});

test("firstShellWord joins adjacent quoted runs the way sh does", () => {
  assert.deepEqual(firstShellWord(`'a'\\''b'"c" rest`), { word: "a'bc", rest: " rest" });
  assert.equal(firstShellWord(""), null);
});
