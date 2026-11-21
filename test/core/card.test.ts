// The approval card: both worked examples as exact text, the short form the
// permission prompt and the approval notice use, and what is stripped from text
// a plugin author controls.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CARD_DEADLINE_MS, CARD_EXAMPLES, type CardExample } from "../../scripts/card-examples.ts";
import {
  type CardFacts,
  capabilityLines,
  costLine,
  renderCard,
  renderCardShort,
  safeText,
} from "../../src/core/card.ts";

const DEADLINE_MS = CARD_DEADLINE_MS;
/** U+202E, which reverses the text after it; spelled out so this file holds no invisible character. */
const BIDI_OVERRIDE = String.fromCharCode(0x202e);

const [GIT_GUARD_EXAMPLE, TOPIC_ROUTER_EXAMPLE] = CARD_EXAMPLES as [CardExample, CardExample];
const GIT_GUARD = GIT_GUARD_EXAMPLE.facts;
const GIT_GUARD_CAPS = GIT_GUARD_EXAMPLE.capabilities;
const GIT_GUARD_HASH = GIT_GUARD_EXAMPLE.hash;
const TOPIC_ROUTER = TOPIC_ROUTER_EXAMPLE.facts;
const TOPIC_ROUTER_CAPS = TOPIC_ROUTER_EXAMPLE.capabilities;
const TOPIC_ROUTER_HASH = TOPIC_ROUTER_EXAMPLE.hash;

test("a script plugin on tool.before renders the worked example", () => {
  const card = renderCard(GIT_GUARD, GIT_GUARD_CAPS, {
    hash: GIT_GUARD_HASH,
    approval: "first approval",
    deadlineMs: DEADLINE_MS,
  });
  assert.equal(
    card,
    [
      "hookmux plugin: git-guard 0.3.1",
      "From: github.com/acme/git-guard @ 4f2c1a9 (hookmux has not reviewed it)",
      "Does: Stops force-pushes to main.",
      "Runs: Before every tool call · runs a script · can add up to 2 s",
      "Can:",
      "  high    Runs guard.sh as your user, not sandboxed",
      "  high    Can stop the agent's tool calls",
      "  medium  Passes $GITHUB_TOKEN from your environment to its script",
      "  low     Shows you messages the agent does not see",
      "Content: sha256:3b9e…41ac, first approval",
    ].join("\n"),
  );
});

test("a model plugin on prompt.submit renders the worked example", () => {
  const card = renderCard(TOPIC_ROUTER, TOPIC_ROUTER_CAPS, {
    hash: TOPIC_ROUTER_HASH,
    approval: "first approval",
    deadlineMs: DEADLINE_MS,
  });
  assert.equal(
    card,
    [
      "hookmux plugin: topic-router 1.2.0",
      "From: github.com/acme/topic-router @ 9a1b2c3 (hookmux has not reviewed it)",
      "Does: Points the agent at the team wiki for billing questions.",
      "Runs: On every prompt · calls your model provider · can add up to 2 s",
      "Can:",
      "  medium  Sends your prompt text to your configured model provider (local)",
      "  medium  Adds text the agent reads and may follow",
      "A model alone never blocks anything.",
      "Content: sha256:77a0…c2d1, first approval",
    ].join("\n"),
  );
});

test("the short form keeps the high and medium lines in one paragraph", () => {
  assert.equal(
    renderCardShort(GIT_GUARD, GIT_GUARD_CAPS, DEADLINE_MS),
    "hookmux: approve to turn on git-guard 0.3.1 from acme/git-guard. " +
      "Before every tool call · runs a script · can add up to 2 s. " +
      "Runs guard.sh as your user, not sandboxed. Can stop the agent's tool calls. " +
      "Passes $GITHUB_TOKEN to its script.",
  );
});

test("a block on a prompt and on tool calls earns a line for each", () => {
  const facts: CardFacts = { ...GIT_GUARD, events: ["prompt.submit", "tool.before", "tool.after"], tier: 0 };
  const lines = capabilityLines(["block"], facts).map((l) => l.text);
  assert.deepEqual(lines, ["Can stop the agent's tool calls", "Can discard your prompt before the agent sees it"]);
  assert.equal(
    costLine(facts, DEADLINE_MS),
    "On every prompt, before every tool call and after every tool call · in-process checks only",
  );
});

test("a capability hookmux cannot describe is shown as high risk", () => {
  const [line] = capabilityLines(["teleport"], GIT_GUARD);
  assert.deepEqual(line, { risk: "high", text: "Uses teleport (hookmux has no description for it)" });
});

test("author text cannot forge or hide card lines", () => {
  const hostile: CardFacts = {
    ...GIT_GUARD,
    description: `Harmless.\n  low     Shows nothing\u001b[2J${BIDI_OVERRIDE}`,
    version: "1.0\u0007\nFrom: bundled with hookmux",
    scripts: ["x.sh\nsafe", "../../etc/passwd"],
    source: "https://github.com/acme/evil\nFrom: bundled with hookmux",
  };
  const card = renderCard(hostile, ["script", "env:A\nB"], { hash: GIT_GUARD_HASH, approval: "x", deadlineMs: 1000 });
  assert.equal(card.split("\n").length, 8, "no author text starts a new line");
  assert.doesNotMatch(card, new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f${BIDI_OVERRIDE}]`));
  assert.match(card, /Runs its scripts as your user/, "unsafe file names are not printed");
  assert.match(card, /an environment variable with an unusual name/);
});

test("safeText flattens, strips escapes and caps the length", () => {
  assert.equal(safeText("a\u001b[31mred\u001b[0m\tb\r\nc"), "ared b c");
  assert.equal(safeText("x".repeat(300)).length, 200);
  assert.equal(safeText(undefined), "");
  // Tag characters, the Arabic letter mark and variation selectors are invisible to a person but read by the agent.
  assert.equal(safeText("a\u{e0041}\u{e0042}b؜c️d\u{e0100}e"), "a b c d e");
});
