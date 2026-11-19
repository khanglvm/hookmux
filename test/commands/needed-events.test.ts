import assert from "node:assert/strict";
import { test } from "node:test";
import { neededEvents } from "../../src/commands/lib/hosts.ts";
import type { Registry } from "../../src/load/snapshot.ts";

const plugin = (status: string, events: string[]) => ({ id: status, status, base: { events } });

test("hub events cover plugins waiting for promote but not invalid ones", () => {
  const registry = {
    plugins: [plugin("untrusted", ["tool.after"]), plugin("invalid", ["tool.before"])],
  } as unknown as Registry;
  assert.deepEqual(neededEvents(registry), ["prompt.submit", "session.start", "tool.after"]);
});
