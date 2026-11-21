// The terminal path that activates a plugin, and the native-prompt grant path: show
// the card, ask the person at the keyboard, then pin the plugin's content hash and
// capabilities in trust.json. It refuses --yes. An agent client's environment, or a
// stdin that is not a terminal, hands the request to relay.ts instead, which issues a
// card and a code, so an agent can install a plugin and ask but never answer for the person.

import { relative } from "node:path";
import { readFlagsForUpdate } from "../../load/flags.ts";
import { listPluginFiles, readTrust, uncoveredCapabilities, writeTrust } from "../../load/trust.ts";
import { takeGrant } from "../../runtime/grants.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { activationRefusal } from "./agent-env.ts";
import { cardFor, changeState, pin, readPromotable } from "./approval.ts";
import { syncAfterChange } from "./hosts.ts";
import { detail, say } from "./output.ts";
import { inspectInstalled } from "./plugins.ts";
import { confirm, isInteractive } from "./prompt.ts";
import { relayPromote } from "./relay.ts";

export interface PromoteOptions {
  assumeYes: boolean;
  /** Also grant a standing approval with the plugin's current capabilities as the ceiling. */
  standing?: boolean;
}

/**
 * Exit code: 0 promoted (or already active), 1 refused, declined or not promotable,
 * 3 a card was issued and the person has not answered it yet (relay.ts).
 */
export async function promotePlugin(paths: HomePaths, id: string, opts: PromoteOptions): Promise<number> {
  const { assumeYes, standing = false } = opts;
  const refusal = activationRefusal({ assumeYes, interactive: isInteractive(), env: process.env });
  if (refusal === "yes-flag") {
    say(
      "fail",
      "promote does not take --yes: a person types y to activate a plugin",
      `run this yourself in a terminal: hookmux promote ${id}`,
    );
    return 1;
  }
  // An agent, or a shell with no terminal, cannot type y: it gets the card and a code for the person to answer.
  if (refusal) return relayPromote(paths, id, { standing });
  const p = readPromotable(paths, id);
  if (!p) return 1;
  const state = changeState(paths, p);
  const { previous, change } = state;
  if (state.alreadyApproved && (!standing || state.standingCovered)) {
    say("ok", `${id} is already promoted and unchanged since ${previous?.promotedAt}`);
    return 0;
  }
  describe(p.dir, cardFor(p, change).text);
  if (previous) detail(`last promoted ${previous.promotedAt}`);
  if (standing) describeStanding(id, p.capabilities);
  if (!(await confirm(standing ? `Activate ${id} and grant the standing approval?` : `Activate ${id}?`, false))) {
    say("info", `${id} left as it was`);
    return 1;
  }
  pin(paths, id, p, standing, { via: "promote" });
  say("ok", `${id} promoted; it runs on the next hook event`);
  await syncAfterChange(paths);
  return 0;
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
  pin(paths, id, { hash: row.entry.hash, capabilities: row.entry.capabilities }, opts.standing, {
    via: "prompt",
    host: grant.host,
  });
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

/** The card, then the files a person can read before saying yes. */
function describe(dir: string, card: string): void {
  console.log(card);
  detail("files:");
  for (const f of listPluginFiles(dir).files) detail(`  ${relative(dir, f)}`);
}
