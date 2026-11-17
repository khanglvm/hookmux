// `hookmux disable <id>`: switch a plugin off without removing it.

import { setDisabled } from "./lib/toggle.ts";

export const usage = `Usage: hookmux disable <id>

Switches a plugin off without deleting it. Undo with 'hookmux enable <id>'.`;

export function run(argv: string[]): Promise<number> {
  return setDisabled(argv, usage, true);
}
