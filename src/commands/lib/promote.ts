// The one path that activates a plugin: show what it can do, ask the person at
// the keyboard, then pin its content hash and capabilities in trust.json. It
// refuses --yes, an agent client's environment and a stdin that is not a
// terminal, so an agent can install a plugin in shadow mode but never switch it
// on by itself.

import { relative } from "node:path";
import { readFlagsForUpdate, writeFlags } from "../../load/flags.ts";
import { isCapabilitySubset, listPluginFiles, readTrust, writeTrust } from "../../load/trust.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { type ActivationRefusal, activationRefusal, agentMarker } from "./agent-env.ts";
import { syncAfterChange } from "./hosts.ts";
import { bold, detail, say } from "./output.ts";
import { inspectInstalled, installedDir, isInstalled } from "./plugins.ts";
import { confirm, isInteractive } from "./prompt.ts";

/** Exit code: 0 promoted (or already active), 1 refused, declined or not promotable. */
export async function promotePlugin(paths: HomePaths, id: string, assumeYes: boolean): Promise<number> {
  const refusal = activationRefusal({ assumeYes, interactive: isInteractive(), env: process.env });
  if (refusal) {
    sayRefusal(refusal, id);
    return 1;
  }
  if (!isInstalled(paths, id)) {
    say("fail", `plugin '${id}' is not installed`, "hookmux list");
    return 1;
  }
  const dir = installedDir(paths, id);
  const row = inspectInstalled(paths).rows.find((r) => r.id === id);
  if (!row || row.status === "invalid" || row.entry.hash === undefined) {
    say("fail", `${id} is invalid: ${row?.entry.problem ?? "not found"}`, `hookmux validate ${dir}`);
    return 1;
  }
  // The hash and capabilities come from the same compile, which read each file once:
  // what is shown here is exactly what gets pinned, overrides in config.toml included.
  const { hash, capabilities } = row.entry;
  const previous = readTrust(paths.trust).plugins[id];
  const flags = readFlagsForUpdate(paths.flags);
  const sameContent = previous?.hash === hash;
  const capsCovered = previous !== undefined && isCapabilitySubset(capabilities, previous.capabilities);
  if (sameContent && capsCovered && !flags.shadow.includes(id)) {
    say("ok", `${id} is already promoted and unchanged since ${previous.promotedAt}`);
    return 0;
  }
  describe(id, dir, capabilities, previous ? (sameContent ? (capsCovered ? "same" : "caps") : "changed") : "new");
  if (previous) detail(`last promoted ${previous.promotedAt}`);
  if (!(await confirm(`Activate ${id}?`, false))) {
    say("info", `${id} left as it was`);
    return 1;
  }
  const trust = readTrust(paths.trust);
  trust.plugins[id] = { hash, capabilities, promotedAt: new Date().toISOString() };
  writeTrust(paths.trust, trust);
  writeFlags(paths.flags, { ...flags, shadow: flags.shadow.filter((s) => s !== id) });
  say("ok", `${id} promoted; it runs on the next hook event`);
  syncAfterChange(paths);
  return 0;
}

function sayRefusal(refusal: ActivationRefusal, id: string): void {
  const yourself = `run this yourself in a terminal: hookmux promote ${id}`;
  if (refusal === "yes-flag") {
    say("fail", "promote does not take --yes: a person types y to activate a plugin", yourself);
  } else if (refusal === "agent") {
    say(
      "fail",
      `promote refuses to run inside an agent client (${agentMarker(process.env)} is set): only a person can activate '${id}'`,
      yourself,
    );
  } else {
    say("fail", `promote needs your own terminal: only a person can activate '${id}'`, yourself);
  }
}

type Change = "new" | "same" | "caps" | "changed";

function describe(id: string, dir: string, capabilities: string[], change: Change): void {
  const changeText: Record<Change, string> = {
    new: "first promote",
    same: "content unchanged since the last promote (clearing shadow mode)",
    caps: "content unchanged, but config.toml overrides add capabilities since the last promote",
    changed: "content CHANGED since the last promote",
  };
  console.log(bold(`Promote ${id}`));
  detail(`capabilities: ${capabilities.join(", ") || "none"}`);
  detail(`content: ${changeText[change]}`);
  detail("files:");
  for (const f of listPluginFiles(dir).files) detail(`  ${relative(dir, f)}`);
}
