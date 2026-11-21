// One-time grants for `hookmux promote --grant`. The hub writes one when it
// asks the person to approve a promote command in their agent client; promote
// consumes it. A grant names the plugin, the content hash the person was shown
// and whether a standing approval was asked for, so it activates nothing else.
//
// Security: only the SHA-256 of the token is stored, and the token itself
// leaves the hub only inside the command the client shows the person. This is
// the same checkpoint as promote's terminal check, not a sandbox: a process
// with shell access as the user can write trust.json directly.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.ts";

/** Long enough for a person to answer a card a while later; a grant from a declined card dies with it. */
export const GRANT_TTL_MS = 2 * 60 * 60 * 1000;

export interface PromoteGrant {
  id: string;
  hash: string;
  /** What the person was told the plugin can use; config.toml overrides can change it without changing the hash. */
  capabilities: string[];
  standing: boolean;
  /** The client whose permission prompt the person will answer. */
  host?: string;
  tokenHash: string;
  expiresAt: number;
}

export function newGrantToken(): string {
  return randomBytes(24).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function grantFile(dir: string, tokenHash: string): string {
  return join(dir, `${tokenHash.slice(0, 32)}.json`);
}

function readGrant(file: string): PromoteGrant | null {
  try {
    const grant = JSON.parse(readFileSync(file, "utf8")) as PromoteGrant;
    return typeof grant.tokenHash === "string" && typeof grant.expiresAt === "number" ? grant : null;
  } catch {
    return null;
  }
}

/** Stores a grant for `token` and drops expired ones. */
export function saveGrant(
  dir: string,
  token: string,
  request: Pick<PromoteGrant, "id" | "hash" | "capabilities" | "standing" | "host">,
  now = Date.now(),
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const old = readGrant(file);
    if (old && old.expiresAt <= now) rmSync(file, { force: true });
  }
  const tokenHash = hashToken(token);
  const grant: PromoteGrant = { ...request, tokenHash, expiresAt: now + GRANT_TTL_MS };
  writeFileAtomic(grantFile(dir, tokenHash), `${JSON.stringify(grant)}\n`);
}

/** Removes and returns the grant for `token`, or null when it is unknown, used or expired. */
export function takeGrant(dir: string, token: string, now = Date.now()): PromoteGrant | null {
  const tokenHash = hashToken(token);
  const file = grantFile(dir, tokenHash);
  const grant = readGrant(file);
  if (!grant) return null;
  const same =
    grant.tokenHash.length === tokenHash.length &&
    timingSafeEqual(Buffer.from(grant.tokenHash), Buffer.from(tokenHash));
  if (!same) return null;
  rmSync(file, { force: true });
  return grant.expiresAt > now ? grant : null;
}
