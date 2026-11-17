// Interactive questions. They run only when stdin is a terminal; callers check
// isInteractive() first and choose a non-interactive path (a flag, or refusing)
// otherwise. There is deliberately no environment switch that fakes a terminal,
// because `promote` relies on this check to keep agents from activating plugins.

import { createInterface } from "node:readline/promises";

export function isInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/** Asks a yes/no question. Returns false without asking when stdin is not a terminal. */
export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!isInteractive()) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    return answer === "" ? defaultYes : answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
