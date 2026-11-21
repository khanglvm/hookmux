// `hookmux promote <id>`: the person reviews and activates a plugin, at their terminal,
// in their client's permission prompt, or by replying to a card an agent relays.

import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { installedDir } from "./lib/plugins.ts";
import { endStanding, promotePlugin, promoteWithGrant } from "./lib/promote.ts";
import { confirmRelay, refuseStandingRelay } from "./lib/relay.ts";

export const usage = `Usage: hookmux promote <id> [--standing | --end-standing]
       hookmux promote <id> [--standing] --grant <token>
       hookmux promote <id> --confirm <code>

Shows a plugin's card (what it can do and where it came from), asks to
confirm, then trusts its current content and capabilities and clears its
shadow flag. In your own terminal it asks you. It never accepts --yes.

From an agent client or a shell with no terminal, it prints the card and a
code instead and exits 3: the person approves by replying with that code in
their own message, and \`--confirm <code>\` then turns the plugin on if it is
unchanged since the card. A relayed approval never grants --standing.

  --standing      also let later \`hookmux add\` runs of this plugin activate
                  without asking while its capabilities stay within today's
  --end-standing  end that standing approval (works anywhere)
  --grant <token> a one-time grant from the hub. When an agent in Claude Code
                  or Qwen Code runs \`hookmux promote <id>\`, the hub makes the
                  client ask you first and adds the grant to the command you
                  approve.
  --confirm <code> turn the plugin on after the person replied with the code
                  from the card

Exit codes: 0 done, 1 refused or failed, 3 waiting for the person's reply.`;

export async function run(argv: string[]): Promise<number> {
  // --yes is parsed only so promotePlugin can refuse it with a clear message.
  const parsed = parseCommand(
    argv,
    {
      yes: { type: "boolean", short: "y" },
      standing: { type: "boolean" },
      "end-standing": { type: "boolean" },
      grant: { type: "string" },
      confirm: { type: "string" },
    },
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
  if (parsed.values.confirm !== undefined) {
    if (parsed.values.grant !== undefined) throw new UsageError("--confirm and --grant do not go together");
    if (parsed.values.yes) return promotePlugin(paths, id, { assumeYes: true });
    if (parsed.values.standing) return refuseStandingRelay(id);
    return confirmRelay(paths, id, parsed.values.confirm);
  }
  if (parsed.values.grant !== undefined) {
    return promoteWithGrant(paths, id, { token: parsed.values.grant, standing: parsed.values.standing === true });
  }
  return promotePlugin(paths, id, { assumeYes: parsed.values.yes === true, standing: parsed.values.standing === true });
}
