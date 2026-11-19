// `hookmux init`: install or update the engine, the launcher, bundled plugins
// and the authoring skill, then add hub entries to the chosen hosts. Safe to run
// again; a second run refreshes the engine and changes nothing else that is current.

import type { HostAdapter } from "../hosts/types.ts";
import { type BundledResult, installBundled } from "../install/bundled.ts";
import { installEngine } from "../install/engine.ts";
import { writeLauncher } from "../install/launcher.ts";
import { stableNodePath } from "../install/node-path.ts";
import { packageLayout } from "../install/package.ts";
import { readInstallState, writeInstallState } from "../install/records.ts";
import { installSkill } from "../install/skill.ts";
// compileRegistry needs every check kind registered first.
import "../checks/index.ts";
import { readConfig } from "../load/config.ts";
import { compileRegistry } from "../load/registry.ts";
import { saveRegistry } from "../load/snapshot.ts";
import { homePaths } from "../runtime/paths.ts";
import { VERSION } from "../version.ts";
import { parseCommand, positiveInt, UsageError } from "./lib/args.ts";
import { allAdapters, approveHubs, installHub, neededEvents, printHostResults, wiredAdapters } from "./lib/hosts.ts";
import { say } from "./lib/output.ts";
import { loadDefaults } from "./lib/plugins.ts";
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
  const layout = packageLayout();

  const engine = installEngine(paths, layout.dist, VERSION);
  say("ok", `engine ${engine.version} ${engine.copied ? "installed" : "already current"} (${engine.dir})`);
  if (engine.pruned.length > 0) say("info", `removed old engines: ${engine.pruned.join(", ")}`);
  writeLauncher(paths, layout.launcherTemplate);
  say("ok", `launcher ${paths.launcher} (node ${stableNodePath()})`);
  writeInstallState(paths.installState, { timeoutSec });

  if (!v["no-bundled"] && (await offer("Install the plugins bundled with hookmux?"))) {
    printBundled(installBundled(paths, layout.plugins, loadDefaults(readConfig(paths.config))));
  }

  const registry = compileRegistry(paths);
  saveRegistry(paths, registry);
  const events = neededEvents(registry);
  const hostResults = adapters.map((a) => installHub(a, paths, events));
  const printed = printHostResults(hostResults);
  const hostsOk = (await approveHubs(paths, hostResults)) && printed;

  if (!v["no-skill"] && (await offer("Install the hookmux authoring skill for these hosts?"))) {
    printSkill(layout.skill, adapters);
  }
  if (adapters.length === 0) {
    say("warn", "no host wired: no agent client detected", "hookmux init --host <id>");
    return 1;
  }
  say("info", "next: check the install end to end", "hookmux doctor");
  return hostsOk ? 0 : 1;
}

/** Hosts to wire: the --host list, every detected host with --yes, or the person's picks. */
async function chooseHosts(ids: string[], yes: boolean, wired: HostAdapter[]): Promise<HostAdapter[]> {
  const all = allAdapters();
  if (ids.length > 0) {
    return [...new Set(ids)].map((id) => {
      const adapter = all.find((a) => a.id === id);
      if (!adapter) throw new UsageError(`unknown host '${id}'; known hosts: ${all.map((a) => a.id).join(", ")}`);
      if (!adapter.config.detect()) say("warn", `${adapter.name} was not detected; wiring it anyway`);
      return adapter;
    });
  }
  const detected = all.filter((a) => a.config.detect());
  if (yes) return detected;
  if (isInteractive()) {
    const picked: HostAdapter[] = [];
    for (const adapter of detected) if (await confirm(`Wire ${adapter.name}?`, true)) picked.push(adapter);
    return picked;
  }
  if (wired.length > 0) {
    say("info", `updating hosts already wired: ${wired.map((a) => a.id).join(", ")}`);
    return wired;
  }
  const found = detected.map((a) => a.id).join(", ") || "none";
  throw new UsageError(`stdin is not a terminal: pass --host <id> or --yes (detected: ${found})`);
}

/** Asks on a terminal; elsewhere the default is yes and the --no-* flags opt out. */
async function offer(question: string): Promise<boolean> {
  return isInteractive() ? confirm(question, true) : true;
}

function printBundled(results: BundledResult[]): void {
  if (results.length === 0) say("info", "no bundled plugins in this package");
  for (const r of results) {
    if (r.status === "installed") say("ok", `bundled plugin ${r.id} installed and trusted`);
    else if (r.status === "unchanged") say("ok", `bundled plugin ${r.id} already current`);
    else if (r.status === "skipped") say("warn", `bundled plugin ${r.id} skipped: ${r.detail}`, `hookmux list`);
    else say("fail", `bundled plugin ${r.id} is invalid: ${r.detail}`, "reinstall hookmux");
  }
}

function printSkill(skillDir: string, adapters: HostAdapter[]): void {
  const results = installSkill(skillDir, adapters);
  if (results.length === 0) {
    say("info", "authoring skill not installed (not in this package, or no host has a skill folder)");
  }
  for (const r of results) {
    if (r.error) say("fail", `${r.adapter.name} skill: ${r.error}`, "hookmux init");
    else say("ok", `${r.adapter.name} skill: ${r.target}`);
  }
}
