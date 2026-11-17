// `hookmux promote <id>`: the person at the terminal reviews and activates a plugin.

import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { installedDir } from "./lib/plugins.ts";
import { promotePlugin } from "./lib/promote.ts";

export const usage = `Usage: hookmux promote <id>

Shows a plugin's capabilities and files, asks to confirm, then trusts its
current content and capabilities and clears its shadow flag. Works only in
your own terminal: it refuses when stdin is not a terminal or when an agent
client's environment is detected, and it never accepts --yes.`;

export async function run(argv: string[]): Promise<number> {
  // --yes is parsed only so promotePlugin can refuse it with a clear message.
  const parsed = parseCommand(argv, { yes: { type: "boolean", short: "y" } }, usage, 1);
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the plugin to promote");
  const paths = homePaths();
  installedDir(paths, id);
  return promotePlugin(paths, id, parsed.values.yes === true);
}
