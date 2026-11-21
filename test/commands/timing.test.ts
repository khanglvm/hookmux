// Measured time: the per-plugin "took" line of `hookmux test` and the slowest plugins in `doctor`.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { slowestPlugins } from "../../src/commands/lib/doctor-checks.ts";
import { homePaths } from "../../src/runtime/paths.ts";
import { cli, MOODBOARD, sandbox } from "./helpers.ts";

/** A log line shaped like src/runtime/log.ts writes it. */
function line(event: string, plugins: Record<string, number>) {
  return {
    ts: "2026-11-21T10:00:00.000Z",
    host: "claude-code",
    event,
    ms: 5,
    plugins: Object.entries(plugins).map(([id, ms]) => ({ id, outcome: "silent", ms })),
  };
}

test("test prints one took line per plugin and carries ms in --json", async () => {
  const sb = sandbox();
  const r = await cli(sb, "test", MOODBOARD);
  assert.match(r.stdout, /moodboard: took \d+ ms \(slowest case \d+ ms\)/);
  const json = JSON.parse((await cli(sb, "test", MOODBOARD, "--json")).stdout);
  assert.ok(json.plugins[0].cases.every((c: { ms: number }) => Number.isInteger(c.ms)));
});

test("slowestPlugins ranks the top three by p95 per event, and needs 20 runs", () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    line(i % 2 ? "tool.before" : "prompt.submit", { slow: i === 19 ? 400 : 10, mid: 50, fast: 1, tiny: 0 }),
  );
  const top = slowestPlugins(records);
  assert.deepEqual(
    top.map((t) => [t.id, t.event, t.p95Ms]),
    [
      ["slow", "tool.before", 400],
      ["mid", "prompt.submit", 50],
      ["mid", "tool.before", 50],
    ],
  );
  assert.deepEqual(slowestPlugins(records.slice(0, 19)), []);
});

test("doctor names the slowest plugins only while the log is on and has 20 runs", async () => {
  const sb = sandbox();
  const paths = homePaths(sb.home);
  mkdirSync(dirname(paths.logFile), { recursive: true });
  const lines = Array.from({ length: 20 }, () => JSON.stringify(line("tool.before", { guard: 120 })));
  writeFileSync(paths.logFile, `${lines.join("\n")}\n{cut off`);
  assert.doesNotMatch((await cli(sb, "doctor")).stdout, /slowest:/);
  assert.equal((await cli(sb, "log", "on")).code, 0);
  assert.match((await cli(sb, "doctor")).stdout, /slowest: guard p95 120 ms on tool\.before/);
  writeFileSync(paths.logFile, `${lines.slice(0, 5).join("\n")}\n`);
  assert.doesNotMatch((await cli(sb, "doctor")).stdout, /slowest:/);
});
