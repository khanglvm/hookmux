// The one path that activates a plugin: show what it can do, ask the person at
// the keyboard, then pin its content hash and capabilities in trust.json. It
// refuses --yes, an agent client's environment and a stdin that is not a
// terminal, so an agent can install a plugin in shadow mode but never switch it
// on by itself.

import { relative } from "node:path";
import { readFlagsForUpdate, writeFlags } from "../../load/flags.ts";
import { isCapabilitySubset, listPluginFiles, readTrust, uncoveredCapabilities, writeTrust } from "../../load/trust.ts";
import { takeGrant } from "../../runtime/grants.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { type ActivationRefusal, activationRefusal, agentMarker } from "./agent-env.ts";
import { syncAfterChange } from "./hosts.ts";
import { bold, detail, say } from "./output.ts";
import { inspectInstalled, installedDir, isInstalled } from "./plugins.ts";
import { confirm, isInteractive } from "./prompt.ts";

export interface PromoteOptions {
  assumeYes: boolean;
  /** Also grant a standing approval with the plugin's current capabilities as the ceiling. */
  standing?: boolean;
}

/** Exit code: 0 promoted (or already active), 1 refused, declined or not promotable. */
export async function promotePlugin(paths: HomePaths, id: string, opts: PromoteOptions): Promise<number> {
  const { assumeYes, standing = false } = opts;
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
  const standingCovered =
    previous?.standing !== undefined && isCapabilitySubset(capabilities, previous.standing.capabilities);
  if (sameContent && capsCovered && !flags.shadow.includes(id) && (!standing || standingCovered)) {
    say("ok", `${id} is already promoted and unchanged since ${previous.promotedAt}`);
    return 0;
  }
  describe(id, dir, capabilities, previous ? (sameContent ? (capsCovered ? "same" : "caps") : "changed") : "new");
  if (previous) detail(`last promoted ${previous.promotedAt}`);
  if (standing) describeStanding(id, capabilities);
  if (!(await confirm(standing ? `Activate ${id} and grant the standing approval?` : `Activate ${id}?`, false))) {
    say("info", `${id} left as it was`);
    return 1;
  }
  pin(paths, id, { hash, capabilities }, standing);
  say("ok", `${id} promoted; it runs on the next hook event`);
  await syncAfterChange(paths);
  return 0;
}

/** Records the person's approval: the content pin, the standing approval when asked for, and no shadow flag. */
function pin(paths: HomePaths, id: string, content: { hash: string; capabilities: string[] }, standing: boolean): void {
  const now = new Date().toISOString();
  const trust = readTrust(paths.trust);
  const kept = standing ? { capabilities: content.capabilities, grantedAt: now } : trust.plugins[id]?.standing;
  trust.plugins[id] = { ...content, promotedAt: now, via: "promote", ...(kept ? { standing: kept } : {}) };
  writeTrust(paths.trust, trust);
  const flags = readFlagsForUpdate(paths.flags);
  writeFlags(paths.flags, { ...flags, shadow: flags.shadow.filter((s) => s !== id) });
}

/**
 * Activates a plugin on a grant the hub issued when the person approved this exact
 * command in their agent client. The grant stands in for the terminal check, so it
 * must match the plugin, the content the person was shown and the --standing flag.
 * Exit code: 0 promoted, 1 refused.
 */
export async function promoteWithGrant(
  paths: HomePaths,
  id: string,
  opts: { token: string; standing: boolean },
): Promise<number> {
  const again = `hookmux promote ${id}${opts.standing ? " --standing" : ""}`;
  const grant = takeGrant(paths.grants, opts.token);
  if (!grant || grant.id !== id || grant.standing !== opts.standing) {
    say("fail", `this approval for '${id}' is unknown, already used or expired`, `ask again: ${again}`);
    return 1;
  }
  const row = inspectInstalled(paths).rows.find((r) => r.id === id);
  if (!row || row.status === "invalid" || row.entry.hash === undefined) {
    say("fail", `${id} is invalid: ${row?.entry.problem ?? "not installed"}`, "hookmux list");
    return 1;
  }
  const sameCapabilities =
    Array.isArray(grant.capabilities) && grant.capabilities.join("\n") === row.entry.capabilities.join("\n");
  if (row.entry.hash !== grant.hash || !sameCapabilities) {
    say("fail", `${id} changed after the approval was shown, so it was not activated`, `ask again: ${again}`);
    return 1;
  }
  pin(paths, id, { hash: row.entry.hash, capabilities: row.entry.capabilities }, opts.standing);
  say("ok", `${id} promoted on your approval; it runs on the next hook event`);
  await syncAfterChange(paths);
  return 0;
}

/**
 * Pins the installed content of each plugin that holds a standing approval
 * covering its capabilities, without asking. Plugins in shadow mode are left
 * for promote. Returns the ids it pinned.
 */
export function applyStandingApprovals(paths: HomePaths, ids: string[]): string[] {
  const trust = readTrust(paths.trust);
  const flags = readFlagsForUpdate(paths.flags);
  const rows = inspectInstalled(paths).rows;
  const pinned: string[] = [];
  for (const id of ids) {
    const grant = trust.plugins[id]?.standing;
    if (!grant) continue;
    const row = rows.find((r) => r.id === id);
    if (!row || row.status === "invalid" || row.entry.hash === undefined) continue;
    if (flags.shadow.includes(id)) {
      say("info", `${id} is in shadow mode, so its standing approval is not applied`, `hookmux promote ${id}`);
      continue;
    }
    const beyond = uncoveredCapabilities(row.entry.capabilities, grant.capabilities);
    if (beyond.length > 0) {
      say("warn", `${id} now needs ${beyond.join(", ")}, beyond its standing approval`, `hookmux promote ${id}`);
      continue;
    }
    const now = new Date().toISOString();
    trust.plugins[id] = {
      hash: row.entry.hash,
      capabilities: row.entry.capabilities,
      promotedAt: now,
      via: "standing",
      standing: grant,
    };
    pinned.push(id);
    say("ok", `${id} activated under the standing approval granted ${grant.grantedAt}`);
  }
  if (pinned.length > 0) writeTrust(paths.trust, trust);
  return pinned;
}

/** Ends a plugin's standing approval; its current pin stays. Needs no terminal: it only takes trust away. */
export function endStanding(paths: HomePaths, id: string): number {
  const trust = readTrust(paths.trust);
  const entry = trust.plugins[id];
  if (!entry?.standing) {
    say("info", `${id} has no standing approval`);
    return 0;
  }
  delete entry.standing;
  writeTrust(paths.trust, trust);
  say("ok", `${id}: standing approval ended; later changes need hookmux promote ${id}`);
  return 0;
}

function describeStanding(id: string, capabilities: string[]): void {
  detail("standing approval:");
  detail(`  later \`hookmux add\` runs replace and activate ${id} without asking while it needs`);
  detail(`  no more than: ${capabilities.join(", ") || "none"}`);
  detail("  anyone who can run hookmux add (agents included) can then change its files within that;");
  detail("  matchers, folder globs and the phase are not part of the ceiling.");
  detail(`  end it any time: hookmux promote ${id} --end-standing`);
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
