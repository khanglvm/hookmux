// What every way of activating a plugin shares: reading the plugin as it is
// now, telling a first approval from a changed one, rendering its card, and
// recording the approval in trust.json. The terminal, the permission prompt and
// the relayed card each decide whether the person said yes; this module is what
// they pin afterwards.

import { type CardFacts, renderCard } from "../../core/card.ts";
import { readFlagsForUpdate, writeFlags } from "../../load/flags.ts";
import type { RegistryPlugin } from "../../load/snapshot.ts";
import { isCapabilitySubset, readTrust, type TrustEntry, writeTrust } from "../../load/trust.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { say } from "./output.ts";
import { inspectInstalled, installedDir, isInstalled } from "./plugins.ts";

/** A plugin as it is right now: the content hash and capabilities come from one compile, so what is shown is what gets pinned. */
export interface Promotable {
  id: string;
  dir: string;
  entry: RegistryPlugin;
  hash: string;
  capabilities: string[];
  deadlineMs: number;
}

export type Change = "new" | "same" | "caps" | "changed";

/** Reads an installed plugin for approval; prints why and returns null when it cannot be approved. */
export function readPromotable(paths: HomePaths, id: string): Promotable | null {
  if (!isInstalled(paths, id)) {
    say("fail", `plugin '${id}' is not installed`, "hookmux list");
    return null;
  }
  const dir = installedDir(paths, id);
  const { registry, rows } = inspectInstalled(paths);
  const row = rows.find((r) => r.id === id);
  if (!row || row.status === "invalid" || row.entry.hash === undefined) {
    say("fail", `${id} is invalid: ${row?.entry.problem ?? "not found"}`, `hookmux validate ${dir}`);
    return null;
  }
  const { hash, capabilities } = row.entry;
  return { id, dir, entry: row.entry, hash, capabilities, deadlineMs: registry.settings.deadlineMs };
}

export interface ChangeState {
  previous: TrustEntry | undefined;
  change: Change;
  /** True when the plugin is already approved for this content and live (no shadow flag), so there is nothing to ask. */
  alreadyApproved: boolean;
  /** True when the earlier standing approval covers these capabilities. */
  standingCovered: boolean;
}

/** How this content differs from the person's last approval. */
export function changeState(paths: HomePaths, p: Promotable): ChangeState {
  const previous = readTrust(paths.trust).plugins[p.id];
  const sameContent = previous?.hash === p.hash;
  const capsCovered = previous !== undefined && isCapabilitySubset(p.capabilities, previous.capabilities);
  const shadow = readFlagsForUpdate(paths.flags).shadow.includes(p.id);
  const standingCovered =
    previous?.standing !== undefined && isCapabilitySubset(p.capabilities, previous.standing.capabilities);
  return {
    previous,
    change: previous ? (sameContent ? (capsCovered ? "same" : "caps") : "changed") : "new",
    alreadyApproved: sameContent && capsCovered && !shadow,
    standingCovered,
  };
}

const APPROVAL_TEXT: Record<Change, string> = {
  new: "first approval",
  same: "same content as the last approval; clears shadow mode",
  caps: "same content, but config.toml overrides add capabilities",
  changed: "content CHANGED since the last approval",
};

/**
 * The card for this plugin as it is now.
 * @throws Error when the registry entry carries no card facts, which only a stale snapshot can cause.
 */
export function cardFor(p: Promotable, change: Change): { facts: CardFacts; text: string } {
  const facts = p.entry.card;
  if (!facts) throw new Error(`no card facts for ${p.id}; run hookmux doctor`);
  const text = renderCard(facts, p.capabilities, {
    hash: p.hash,
    approval: APPROVAL_TEXT[change],
    deadlineMs: p.deadlineMs,
  });
  return { facts, text };
}

export interface ApprovalRecord {
  via: "promote" | "prompt" | "relay";
  host?: string | undefined;
  /** When the person's reply was seen, as an ISO time; relay only. */
  approvedAt?: string | undefined;
}

/** Records the person's approval: the content pin, the standing approval when asked for, and no shadow flag. */
export function pin(
  paths: HomePaths,
  id: string,
  content: { hash: string; capabilities: string[] },
  standing: boolean,
  record: ApprovalRecord,
): void {
  const now = new Date().toISOString();
  const trust = readTrust(paths.trust);
  const kept = standing ? { capabilities: content.capabilities, grantedAt: now } : trust.plugins[id]?.standing;
  trust.plugins[id] = {
    ...content,
    promotedAt: now,
    via: record.via,
    ...(record.host ? { host: record.host } : {}),
    ...(record.approvedAt ? { approvedAt: record.approvedAt } : {}),
    ...(kept ? { standing: kept } : {}),
  };
  writeTrust(paths.trust, trust);
  const flags = readFlagsForUpdate(paths.flags);
  writeFlags(paths.flags, { ...flags, shadow: flags.shadow.filter((s) => s !== id) });
}
