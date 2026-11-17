// `hookmux uninstall`: remove hub entries from hosts, leaving every other hook
// untouched. `--purge` also deletes the home folder, but only after the hub
// entries are gone, so no host is left calling a deleted launcher.

import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HostAdapter } from "../hosts/types.ts";
import { type HomePaths, homePaths } from "../runtime/paths.ts";
import { parseCommand } from "./lib/args.ts";
import { allAdapters, printHostResults } from "./lib/hosts.ts";
import { say } from "./lib/output.ts";
import { confirm, isInteractive } from "./lib/prompt.ts";
import { adapterOrUsage } from "./lib/run.ts";

export const usage = `Usage: hookmux uninstall [--host <id>]... [--purge] [--yes]

Removes hookmux hub entries from host configs. Other hooks stay as they are.

  --host <id>  only this host (repeatable); default: every host with hub entries
  --purge      also delete the hookmux home folder (plugins, trust, logs)
  --yes, -y    do not ask before --purge`;

/** Files and folders only a hookmux home has; purge refuses a folder without any of them. */
const HOME_MARKERS = ["engine", "bin", "plugins", "trust.json", "registry.json"];

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    argv,
    { host: { type: "string", multiple: true }, purge: { type: "boolean" }, yes: { type: "boolean", short: "y" } },
    usage,
  );
  if (!parsed) return 0;
  const paths = homePaths();
  const ids = parsed.values.host ?? [];
  const adapters: HostAdapter[] =
    ids.length > 0
      ? ids.map(adapterOrUsage)
      : allAdapters().filter((a) => a.config.installed(paths.launcher).length > 0);

  let ok = true;
  if (adapters.length === 0) say("info", "no host has hub entries");
  else {
    ok = printHostResults(
      adapters.map((adapter) => {
        try {
          return { adapter, change: adapter.config.uninstall(paths.launcher) };
        } catch (error) {
          return { adapter, error: (error as Error).message };
        }
      }),
    );
  }
  if (!parsed.values.purge) return ok ? 0 : 1;
  if (!ok) {
    say("fail", "home folder kept because a host still has hub entries", "fix the host config, then re-run");
    return 1;
  }
  return purge(paths, parsed.values.yes === true);
}

async function purge(paths: HomePaths, yes: boolean): Promise<number> {
  const root = resolve(paths.root);
  if (!existsSync(root)) {
    say("info", `${root} does not exist`);
    return 0;
  }
  if (root === resolve(homedir()) || root === "/" || !HOME_MARKERS.some((m) => existsSync(join(root, m)))) {
    say("fail", `${root} does not look like a hookmux home; not deleting it`, `delete it by hand if you are sure`);
    return 1;
  }
  if (!yes) {
    if (!isInteractive()) {
      say("fail", `not deleting ${root} without confirmation`, "hookmux uninstall --purge --yes");
      return 1;
    }
    if (!(await confirm(`Delete ${root} and everything in it?`, false))) {
      say("info", "home folder kept");
      return 0;
    }
  }
  rmSync(root, { recursive: true, force: true });
  say("ok", `deleted ${root}`);
  return 0;
}
