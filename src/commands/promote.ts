// `hookmux promote <id>`: the person at the terminal reviews and activates a plugin.

import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { installedDir } from "./lib/plugins.ts";
import { endStanding, promotePlugin } from "./lib/promote.ts";

export const usage = `Usage: hookmux promote <id> [--standing | --end-standing]

Shows a plugin's capabilities and files, asks to confirm, then trusts its
current content and capabilities and clears its shadow flag. Works only in
your own terminal: it refuses when stdin is not a terminal or when an agent
client's environment is detected, and it never accepts --yes.

  --standing      also let later \`hookmux add\` runs of this plugin activate
                  without asking while its capabilities stay within today's
  --end-standing  end that standing approval (works anywhere)`;

export async function run(argv: string[]): Promise<number> {
  // --yes is parsed only so promotePlugin can refuse it with a clear message.
  const parsed = parseCommand(
    argv,
    { yes: { type: "boolean", short: "y" }, standing: { type: "boolean" }, "end-standing": { type: "boolean" } },
    usage,
    1,
  );
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the plugin to promote");
  const paths = homePaths();
  installedDir(paths, id);
  if (parsed.values["end-standing"]) {
    if (parsed.values.standing) throw new UsageError("--standing and --end-standing do not go together");
    return endStanding(paths, id);
  }
  return promotePlugin(paths, id, { assumeYes: parsed.values.yes === true, standing: parsed.values.standing === true });
}
