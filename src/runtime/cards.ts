// Relay approval cards. When an agent cannot reach the person's terminal or a
// native permission prompt, `hookmux promote <id>` issues a card here: a short
// code the person must send in their own next prompt. The hub's own
// prompt.submit hook marks the card approved when it sees that code in a prompt
// the client marked as the user's, and `promote <id> --confirm <code>` pins the
// plugin only when the card is approved and the plugin still matches it.
//
// Security: the code is not a secret. What carries the evidence is where it is
// read: the hub's hook, on a prompt with origin "user", after the card existed.
// The folder is writable by the same user as trust.json, so this is a
// checkpoint against an agent following an injected instruction, not a sandbox.

import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PLUGIN_ID } from "../core/types.ts";
import { writeFileAtomic } from "./fsutil.ts";

/** How long a card, and an approval of it, can wait for the next step. */
export const CARD_TTL_MS = 30 * 60 * 1000;

/** No I, O, 0 or 1, so a code read aloud or from a screenshot is not mistyped. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
export const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}$/;

export interface RelayCard {
  id: string;
  code: string;
  hash: string;
  capabilities: string[];
  /** The card's short summary as issued, so the approval notice quotes what the person was shown. */
  summary: string;
  issuedAt: number;
  expiresAt: number;
  /** Set by the hub when the person's prompt carried the code. */
  approvedAt?: number;
  /** The client the approving prompt came from. */
  host?: string;
  /** How the agent started hookmux, repeated in the line the hub tells it to run. */
  command?: CliPrefix;
}

/** The only command prefixes a card may name; anything else in a card file reads as plain `hookmux`. */
export type CliPrefix = "hookmux" | "npx -y hookmux";

/**
 * A code with at least one letter and one digit. The hub matches it as a word in any prompt, so a
 * code that is an ordinary word ("TEST", "DATA") or a number ("8888") could be typed for another
 * reason and approve a card nobody read; an agent could also re-issue cards until it drew one.
 */
export function newCode(): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (/[A-Z]/.test(code) && /\d/.test(code)) return code;
  }
}

function cardFile(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function parseCard(text: string): RelayCard | null {
  try {
    const card = JSON.parse(text) as RelayCard;
    const valid =
      PLUGIN_ID.test(card.id) &&
      CODE_PATTERN.test(card.code) &&
      typeof card.hash === "string" &&
      Array.isArray(card.capabilities) &&
      typeof card.expiresAt === "number";
    return valid ? card : null;
  } catch {
    return null;
  }
}

function loadCard(file: string): RelayCard | null {
  try {
    return parseCard(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The card for `id`, or null when there is none or it is unreadable. Expiry is the caller's call. */
export function readCard(dir: string, id: string): RelayCard | null {
  return loadCard(cardFile(dir, id));
}

function writeCard(dir: string, card: RelayCard): void {
  writeFileAtomic(cardFile(dir, card.id), `${JSON.stringify(card)}\n`);
}

export function deleteCard(dir: string, id: string): void {
  rmSync(cardFile(dir, id), { force: true });
  removeIfEmpty(dir);
}

/** Drops the folder once no card is left, so the hub's check on every prompt is one failed stat. */
function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or already gone.
  }
}

/** Issues a card for `id`, replacing any earlier one (the latest wins), and drops expired cards. */
export function issueCard(
  dir: string,
  content: Pick<RelayCard, "id" | "hash" | "capabilities" | "summary" | "command">,
  now = Date.now(),
): RelayCard {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  dropExpired(dir, now);
  const card: RelayCard = { ...content, code: newCode(), issuedAt: now, expiresAt: now + CARD_TTL_MS };
  writeCard(dir, card);
  return card;
}

function dropExpired(dir: string, now: number): void {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const card = loadCard(join(dir, name));
    if (!card || card.expiresAt <= now) rmSync(join(dir, name), { force: true });
  }
}

/**
 * Whether `text` answers the card: it has `code` as a whole word, ignoring case ("approve k7q2" and
 * "K7Q2." match, "xK7Q2" does not), and it is not a paste of promote's own output, which carries the
 * code in the `--confirm` line it prints for the agent.
 */
export function mentionsCode(text: string, code: string): boolean {
  if (new RegExp(`--confirm\\s+${code}(?![A-Za-z0-9])`, "i").test(text)) return false;
  return new RegExp(`(?<![A-Za-z0-9])${code}(?![A-Za-z0-9])`, "i").test(text);
}

/**
 * Marks every unexpired, not yet approved card whose code appears in the prompt as
 * approved by `host`, and returns them. One stat when no card folder exists.
 */
export function approveFromPrompt(dir: string, text: string, host: string, now = Date.now()): RelayCard[] {
  if (!existsSync(dir)) return [];
  const approved: RelayCard[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const card = loadCard(join(dir, name));
    if (!card || card.expiresAt <= now) {
      rmSync(join(dir, name), { force: true });
      continue;
    }
    if (card.approvedAt !== undefined || !mentionsCode(text, card.code)) continue;
    const marked = { ...card, approvedAt: now, host };
    writeCard(dir, marked);
    approved.push(marked);
  }
  removeIfEmpty(dir);
  return approved;
}
