// The relayed approval path of `hookmux promote`. An agent that cannot reach
// the person's terminal gets a card and a code instead. The person answers by
// sending the code in their own prompt, which the hub's prompt hook reads
// (src/hook-main.ts); `--confirm <code>` then pins the plugin if it still
// matches the card. The agent carries the request and the card; only the
// person's reply carries the yes, and relay never grants a standing approval.

import { cardSummary } from "../../core/card.ts";
import { type CliPrefix, CODE_PATTERN, deleteCard, issueCard, type RelayCard, readCard } from "../../runtime/cards.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { cardFor, changeState, type Promotable, pin, readPromotable } from "./approval.ts";
import { syncAfterChange } from "./hosts.ts";
import { say } from "./output.ts";

/** Exit code while the person has not answered yet. */
export const EXIT_WAITING = 3;

/** How this CLI was started, so the lines the agent is told to run work without hookmux on PATH. */
const cli = (): CliPrefix => (process.env.npm_command === "exec" ? "npx -y hookmux" : "hookmux");
const approveCommand = (id: string, code: string) => `${cli()} promote ${id} --confirm ${code}`;
const askAgain = (id: string) => `ask again: ${cli()} promote ${id}`;

/** A standing approval lets later changes in without asking, so a relayed reply never grants one. */
export function refuseStandingRelay(id: string): number {
  say(
    "fail",
    "a standing approval needs your terminal or your client's permission prompt",
    `hookmux promote ${id} --standing`,
  );
  return 1;
}

/** An unexpired card that still describes exactly this content, or null. */
function matchingCard(paths: HomePaths, p: Promotable): RelayCard | null {
  const card = readCard(paths.cards, p.id);
  const same = card && card.hash === p.hash && card.capabilities.join("\n") === p.capabilities.join("\n");
  return card && same && card.expiresAt > Date.now() ? card : null;
}

/**
 * `promote <id>` without a terminal: prints the card for the agent to show and the
 * code the person replies with. Exit code: 0 already approved, 1 refused, 3 waiting.
 */
export function relayPromote(paths: HomePaths, id: string, opts: { standing: boolean }): number {
  if (opts.standing) return refuseStandingRelay(id);
  const p = readPromotable(paths, id);
  if (!p) return 1;
  const state = changeState(paths, p);
  if (state.alreadyApproved) {
    say("ok", `${id} is already promoted and unchanged since ${state.previous?.promotedAt}`);
    return 0;
  }
  const { facts, text } = cardFor(p, state.change);
  const card =
    matchingCard(paths, p) ??
    issueCard(paths.cards, {
      id,
      hash: p.hash,
      capabilities: p.capabilities,
      summary: cardSummary(facts, p.capabilities, p.deadlineMs),
      command: cli(),
    });
  printRelay(id, text, card);
  return EXIT_WAITING;
}

function printRelay(id: string, cardText: string, card: RelayCard): void {
  console.log(`hookmux: approval needed for ${id}`);
  console.log(cardText);
  if (card.approvedAt !== undefined) {
    console.log(`The user has already replied with ${card.code}. Run exactly:\n  ${approveCommand(id, card.code)}`);
    return;
  }
  const until = new Date(card.expiresAt).toTimeString().slice(0, 5);
  console.log(
    [
      "Show this card to the user word for word and ask whether to turn the plugin on.",
      "Do not answer for them. To approve, the user replies `approve " + card.code + "` in their",
      "own message; hookmux reads that reply itself. After they reply, run exactly:",
      `  ${approveCommand(id, card.code)}`,
      `The code expires at ${until} and covers only this content. If the plugin changes,`,
      `run ${cli()} promote ${id} again.`,
    ].join("\n"),
  );
}

/**
 * `promote <id> --confirm <code>`: pins the plugin when the person's reply was seen and
 * the plugin still matches the card. Exit code: 0 activated, 1 refused, 3 not answered yet.
 */
export async function confirmRelay(paths: HomePaths, id: string, rawCode: string): Promise<number> {
  const code = rawCode.toUpperCase();
  const card = CODE_PATTERN.test(code) ? readCard(paths.cards, id) : null;
  if (!card || card.code !== code || card.expiresAt <= Date.now()) {
    say("fail", `this approval code for '${id}' is unknown or expired`, askAgain(id));
    return 1;
  }
  if (card.approvedAt === undefined) {
    say("fail", `the user has not replied with ${code} yet. Ask them, and run this only after they reply`);
    return EXIT_WAITING;
  }
  const p = readPromotable(paths, id);
  if (!p) return 1;
  if (!matchingCard(paths, p)) {
    deleteCard(paths.cards, id);
    say(
      "fail",
      `${id} changed after the card was shown, so it was not turned on`,
      `show the new card: ${cli()} promote ${id}`,
    );
    return 1;
  }
  // Taken before pinning, so one reply turns the plugin on once.
  deleteCard(paths.cards, id);
  const host = card.host ?? "an agent client";
  pin(paths, id, p, false, { via: "relay", host: card.host, approvedAt: new Date(card.approvedAt).toISOString() });
  say("ok", `${id} turned on with the user's approval (relayed through ${host})`, `undo: hookmux disable ${id}`);
  await syncAfterChange(paths);
  return 0;
}
