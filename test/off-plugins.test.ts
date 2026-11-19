import assert from "node:assert/strict";
import { test } from "node:test";
import { offPluginsNotice } from "../src/core/off-plugins.ts";
import type { Registry } from "../src/load/snapshot.ts";

const registry = (plugins: object[]) => ({ plugins }) as unknown as Registry;

test("an unpromoted guard and a plugin that does not load are named at session start", () => {
  const notice = offPluginsNotice(
    registry([
      { id: "bot-guard", status: "untrusted", phase: "guard" },
      { id: "broken", status: "invalid" },
      { id: "nudge", status: "untrusted", phase: "enrich" },
      { id: "live-guard", status: "active", phase: "guard" },
    ]),
  );
  assert.equal(
    notice,
    "hookmux: guard plugin bot-guard is off until you run hookmux promote bot-guard; plugin broken does not load (hookmux doctor).",
  );
});

test("no notice when every guard runs and every plugin loads", () => {
  assert.equal(offPluginsNotice(registry([{ id: "nudge", status: "untrusted", phase: "enrich" }])), null);
});

test("a guard switched off with disable or shadow is named too", () => {
  const notice = offPluginsNotice(
    registry([
      { id: "off-guard", status: "active", phase: "guard", base: { enabled: false } },
      { id: "shadow-guard", status: "active", phase: "guard", base: { enabled: true, shadow: true } },
    ]),
  );
  assert.equal(notice, "hookmux: guard plugin off-guard, shadow-guard is disabled or in shadow and blocks nothing.");
});
