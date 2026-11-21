// `hookmux init`: install or update the engine, the launcher, bundled plugins
// and the authoring skill, then add hub entries to the chosen hosts. Safe to run
// again; a second run refreshes the engine and changes nothing else that is current.

import { readInstallState } from "../install/records.ts";
import { setupHub } from "../install/setup.ts";
import { homePaths } from "../runtime/paths.ts";
import { parseCommand, positiveInt } from "./lib/args.ts";
import { chooseHosts } from "./lib/choose-hosts.ts";
import { allAdapters, wiredAdapters } from "./lib/hosts.ts";
import { say } from "./lib/output.ts";
import { confirm, isInteractive } from "./lib/prompt.ts";

export const usage = `Usage: hookmux init [--host <id>]... [--yes] [--no-skill] [--no-bundled] [--timeout <sec>]

Installs the hookmux engine into the home folder and adds one hub entry per
event to each chosen host. Run it again to update.

  --host <id>      wire this host (repeatable); known: ${allAdapters()
    .map((a) => a.id)
    .join(", ")}
  --yes, -y        wire every detected host without asking
  --no-skill       do not copy the authoring skill into host skill folders
  --no-bundled     do not install the plugins bundled with hookmux
  --timeout <sec>  host-side timeout for new hub entries (default 10)

Without a terminal, pass --host or --yes (a re-run updates the hosts already wired).`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    argv,
    {
      host: { type: "string", multiple: true },
      yes: { type: "boolean", short: "y" },
      "no-skill": { type: "boolean" },
      "no-bundled": { type: "boolean" },
      timeout: { type: "string" },
    },
    usage,
  );
  if (!parsed) return 0;
  const v = parsed.values;
  const paths = homePaths();
  const timeoutSec = positiveInt(v.timeout, "--timeout", readInstallState(paths.installState).timeoutSec);
  const adapters = await chooseHosts(v.host ?? [], v.yes === true, wiredAdapters(paths));
  const bundled = !v["no-bundled"] && (await offer("Install the plugins bundled with hookmux?"));
  const skill = !v["no-skill"] && (await offer("Install the hookmux authoring skill for these hosts?"));

  const hostsOk = await setupHub(paths, { adapters, engine: true, timeoutSec, bundled, skill });
  if (adapters.length === 0) {
    say("warn", "no host wired: no agent client detected", "hookmux init --host <id>");
    return 1;
  }
  say("info", "next: check the install end to end", "hookmux doctor");
  return hostsOk ? 0 : 1;
}

/** Asks on a terminal; elsewhere the default is yes and the --no-* flags opt out. */
async function offer(question: string): Promise<boolean> {
  return isInteractive() ? confirm(question, true) : true;
}
