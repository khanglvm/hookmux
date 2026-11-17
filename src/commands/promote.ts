// `hookmux promote <id>`: the person at the terminal reviews and activates a plugin.

import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { installedDir } from "./lib/plugins.ts";
import { promotePlugin } from "./lib/promote.ts";

export const usage = `Usage: hookmux promote <id> [--yes]

Shows a plugin's capabilities and files, asks to confirm, then trusts its
current content and clears its shadow flag. Works only in your own terminal:
when stdin is not a terminal it refuses, even with --yes.

  --yes, -y  skip the question (terminal only)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { yes: { type: "boolean", short: "y" } }, usage, 1);
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the plugin to promote");
  const paths = homePaths();
  installedDir(paths, id);
  return promotePlugin(paths, id, parsed.values.yes === true);
}
