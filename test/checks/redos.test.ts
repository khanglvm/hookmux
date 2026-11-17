import assert from "node:assert/strict";
import { test } from "node:test";
import { hasNestedRepetition } from "../../src/checks/redos.ts";
import { compilePatterns } from "../../src/checks/text.ts";

test("nested unbounded repetition is flagged", () => {
  for (const source of ["(a+)+", "(a*)*", "(\\w+\\s?)+", "(?:x|y+){2,}", "((ab)+)*", "(?<w>[a-z]+)+$", "(a+?)+"]) {
    assert.equal(hasNestedRepetition(source), true, source);
  }
});

test("ordinary patterns pass", () => {
  for (const source of [
    "\\bredesign\\b",
    "(a|b)+",
    "(ab)+c*",
    "(a+)?",
    "(a+){2}",
    "[(+)]+",
    "\\(a+\\)+",
    "(?:https?://)?\\S+",
    "x{2,5}",
    "(\\d{1,3}\\.){3}\\d{1,3}",
  ]) {
    assert.equal(hasNestedRepetition(source), false, source);
  }
});

test("compilePatterns reports a catastrophic pattern instead of compiling it", () => {
  const problems: string[] = [];
  const compiled = compilePatterns(["ok", "(a+)+$"], "iu", "patterns", problems);
  assert.equal(compiled.length, 1);
  assert.match(problems.join(), /repeats a group that already repeats/);
});
