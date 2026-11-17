// `hookmux sync`: add hub entries for every event the active plugins need, on
// every host that already has hub entries. It never removes entries.

import { homePaths } from "../runtime/paths.ts";
import { parseCommand } from "./lib/args.ts";
import { printHostResults, syncHosts } from "./lib/hosts.ts";
import { say } from "./lib/output.ts";

export const usage = `Usage: hookmux sync

Registers the events installed plugins need on each host that already has
hookmux hub entries. add, remove, enable and promote run it for you.`;

export async function run(argv: string[]): Promise<number> {
  if (!parseCommand(argv, {}, usage)) return 0;
  const { events, results } = syncHosts(homePaths());
  if (results.length === 0) {
    say("warn", "no host has hub entries yet", "hookmux init");
    return 1;
  }
  say("info", `events needed: ${events.join(", ")}`);
  return printHostResults(results) ? 0 : 1;
}
