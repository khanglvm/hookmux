// The one path that activates a plugin: show what it can do, ask the person at
// the keyboard, then pin its content hash in trust.json. It refuses whenever
// stdin is not a terminal, even with --yes, so an agent can install a plugin in
// shadow mode but never switch it on by itself.

import { relative } from "node:path";
import { readFlags, writeFlags } from "../../load/flags.ts";
import { hashPlugin, listPluginFiles, readTrust, writeTrust } from "../../load/trust.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { syncAfterChange } from "./hosts.ts";
import { bold, detail, say } from "./output.ts";
import { inspectInstalled, installedDir, isInstalled } from "./plugins.ts";
import { confirm, isInteractive } from "./prompt.ts";

/** Exit code: 0 promoted (or already active), 1 refused, declined or not promotable. */
export async function promotePlugin(paths: HomePaths, id: string, assumeYes: boolean): Promise<number> {
  if (!isInteractive()) {
    say(
      "fail",
      `promote needs your own terminal: only a person can activate '${id}'`,
      `run this yourself in a terminal: hookmux promote ${id}`,
    );
    return 1;
  }
  if (!isInstalled(paths, id)) {
    say("fail", `plugin '${id}' is not installed`, "hookmux list");
    return 1;
  }
  const dir = installedDir(paths, id);
  const row = inspectInstalled(paths).rows.find((r) => r.id === id);
  if (!row || row.status === "invalid") {
    say("fail", `${id} is invalid: ${row?.entry.problem ?? "not found"}`, `hookmux validate ${dir}`);
    return 1;
  }
  // Hash once, before showing anything: if files change after this, the pin no longer matches.
  const hash = hashPlugin(dir);
  const previous = readTrust(paths.trust).plugins[id];
  const flags = readFlags(paths.flags);
  if (previous?.hash === hash && !flags.shadow.includes(id)) {
    say("ok", `${id} is already promoted and unchanged since ${previous.promotedAt}`);
    return 0;
  }
  describe(id, dir, row.entry.capabilities, previous ? (previous.hash === hash ? "same" : "changed") : "new");
  if (previous) detail(`last promoted ${previous.promotedAt}`);
  if (!assumeYes && !(await confirm(`Activate ${id}?`, false))) {
    say("info", `${id} left as it was`);
    return 1;
  }
  const trust = readTrust(paths.trust);
  trust.plugins[id] = { hash, capabilities: row.entry.capabilities, promotedAt: new Date().toISOString() };
  writeTrust(paths.trust, trust);
  writeFlags(paths.flags, { ...flags, shadow: flags.shadow.filter((s) => s !== id) });
  say("ok", `${id} promoted; it runs on the next hook event`);
  syncAfterChange(paths);
  return 0;
}

function describe(id: string, dir: string, capabilities: string[], change: "new" | "same" | "changed"): void {
  const changeText = {
    new: "first promote",
    same: "content unchanged since the last promote (clearing shadow mode)",
    changed: "content CHANGED since the last promote",
  }[change];
  console.log(bold(`Promote ${id}`));
  detail(`capabilities: ${capabilities.join(", ") || "none"}`);
  detail(`content: ${changeText}`);
  detail("files:");
  for (const f of listPluginFiles(dir).files) detail(`  ${relative(dir, f)}`);
}
