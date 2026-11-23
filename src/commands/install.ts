// `hookmux install <source>`: the one line a plugin author publishes. Sets up
// hookmux when it is missing or old, adds the plugin and then asks for the
// person's answer. It never answers for them: it passes no --yes and grants no
// standing approval, so an agent running it gets a card and a code to relay.

import { existsSync } from "node:fs";
import { readInstallState } from "../install/records.ts";
import { engineNeedsSetup, setupHub } from "../install/setup.ts";
import { type HomePaths, homePaths } from "../runtime/paths.ts";
import { addFromSource } from "./add.ts";
import { agentMarker } from "./lib/agent-env.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { chooseInstallHosts } from "./lib/choose-hosts.ts";
import { allAdapters, wiredAdapters } from "./lib/hosts.ts";
import { say } from "./lib/output.ts";
import { promotePlugin } from "./lib/promote.ts";
import { isInteractive } from "./lib/prompt.ts";
import { EXIT_WAITING } from "./lib/relay.ts";

export const usage = `Usage: hookmux install <source> [--plugin <id>]... [--host <id>]...

Sets up hookmux if it is not set up yet, adds the plugin from <source> and asks
you to approve it. The plugin stays off until you do. Sources are the same as
for hookmux add: a folder, owner/repo, owner/repo/path or a git URL.

  --plugin <id>  only these plugins (repeatable)
  --host <id>    wire this agent client (repeatable); known: ${allAdapters()
    .map((a) => a.id)
    .join(", ")}

At your terminal it asks which clients to wire and shows each plugin's card for
your answer. Run by an agent, it wires the client that is running it (or --host),
prints the card and a code, and exits 3: the user approves by replying with the
code, and the agent then runs the confirm command the card names.

Exit codes: 0 done, 1 failed, 2 usage error, 3 waiting for the person's reply.`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    argv,
    { plugin: { type: "string", multiple: true }, host: { type: "string", multiple: true } },
    usage,
    1,
  );
  if (!parsed) return 0;
  const source = parsed.positionals[0];
  if (!source) throw new UsageError("name a source: a folder, owner/repo[/path] or a git URL");
  const paths = homePaths();
  const atTerminal = isInteractive() && agentMarker(process.env) === undefined;
  const adapters = await chooseInstallHosts(parsed.values.host ?? [], atTerminal, process.env);

  // Bundled plugins stay out: they are trusted on install, and nothing is trusted unasked here.
  const freshSetup = engineNeedsSetup(paths);
  const wired = wiredAdapters(paths);
  const unwired = adapters.filter((a) => !wired.some((w) => w.id === a.id));
  const setUp = freshSetup || unwired.length > 0;
  let setupOk = true;
  if (setUp) {
    const timeoutSec = readInstallState(paths.installState).timeoutSec;
    setupOk = await setupHub(paths, {
      adapters: freshSetup ? adapters : unwired,
      engine: freshSetup || !existsSync(paths.launcher),
      timeoutSec,
      bundled: false,
      skill: false,
    });
  }

  const added = await addFromSource(paths, source, {
    plugins: parsed.values.plugin ?? [],
    shadow: false,
    force: false,
    updateSameSource: true,
  });
  if (!added) return 1;
  const asked = await askForApproval(
    paths,
    added.added.filter((id) => !added.standing.includes(id)),
  );
  if (asked.waiting && setUp) {
    say("info", "hookmux was just set up; if the reply is not picked up, start a new session in your client");
  }
  // A failed setup outranks waiting: the person's reply would not reach a hub that is not wired.
  if (!setupOk) return 1;
  if (asked.waiting) return EXIT_WAITING;
  return added.ok && asked.ok ? 0 : 1;
}

/**
 * Runs the approval step for each added plugin: the card and a question on a terminal,
 * the relayed card and code for an agent. promotePlugin picks the path and refuses --yes.
 */
async function askForApproval(paths: HomePaths, ids: string[]): Promise<{ waiting: boolean; ok: boolean }> {
  let waiting = false;
  let ok = true;
  for (const id of ids) {
    const code = await promotePlugin(paths, id, { assumeYes: false });
    if (code === EXIT_WAITING) waiting = true;
    else if (code !== 0) ok = false;
  }
  return { waiting, ok };
}
