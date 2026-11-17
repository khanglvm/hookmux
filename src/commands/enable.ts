// `hookmux enable <id>`: take a plugin off the hub's disabled list.

import { setDisabled } from "./lib/toggle.ts";

export const usage = `Usage: hookmux enable <id>

Turns a plugin switched off with 'hookmux disable' back on. It still needs to
be promoted to run.`;

export function run(argv: string[]): Promise<number> {
  return setDisabled(argv, usage, false);
}
