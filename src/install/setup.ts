// The shared hub setup behind `hookmux init` and `hookmux install`: the engine,
// the launcher, optionally the bundled plugins and the authoring skill, then one
// hub entry per event on each chosen host. Choosing hosts and asking the person
// stay with the commands; this module only does the work and reports it.

import type { HostAdapter } from "../hosts/types.ts";
// compileRegistry needs every check kind registered first.
import "../checks/index.ts";
import { approveHubs, installHub, neededEvents, printHostResults } from "../commands/lib/hosts.ts";
import { say } from "../commands/lib/output.ts";
import { loadDefaults } from "../commands/lib/plugins.ts";
import { readConfig } from "../load/config.ts";
import { compileRegistry } from "../load/registry.ts";
import { saveRegistry } from "../load/snapshot.ts";
import type { HomePaths } from "../runtime/paths.ts";
import { VERSION } from "../version.ts";
import { type BundledResult, installBundled } from "./bundled.ts";
import { engineStatus, installEngine } from "./engine.ts";
import { writeLauncher } from "./launcher.ts";
import { stableNodePath } from "./node-path.ts";
import { packageLayout } from "./package.ts";
import { writeInstallState } from "./records.ts";
import { installSkill } from "./skill.ts";

export interface SetupOptions {
  adapters: HostAdapter[];
  /**
   * Install this CLI's engine and launcher. `install` passes false when the engine is current or
   * newer, so an older npx copy only wires hosts and never replaces a newer engine.
   */
  engine: boolean;
  timeoutSec: number;
  /** Install and trust the plugins bundled with hookmux. `install` passes false so nothing is trusted unasked. */
  bundled: boolean;
  skill: boolean;
}

/** Numeric parts of `x.y.z`, or null for anything else such as a dev build. */
function versionParts(version: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * True when the engine under `paths` is missing, broken or older than this CLI,
 * so `install` sets the hub up first. A newer or equal engine is left alone, and
 * a version that cannot be compared counts as stale.
 */
export function engineNeedsSetup(paths: HomePaths, cliVersion = VERSION): boolean {
  const status = engineStatus(paths);
  if (!status.ok || status.version === null) return true;
  if (status.version === cliVersion) return false;
  const have = versionParts(status.version);
  const want = versionParts(cliVersion);
  if (!have || !want) return true;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return (have[i] as number) < (want[i] as number);
  return false;
}

/** Installs the engine and launcher when asked, and wires `adapters`. Returns true when every host ended fully set up. */
export async function setupHub(paths: HomePaths, opts: SetupOptions): Promise<boolean> {
  const layout = packageLayout();
  if (opts.engine) {
    const engine = installEngine(paths, layout.dist, VERSION);
    say("ok", `engine ${engine.version} ${engine.copied ? "installed" : "already current"} (${engine.dir})`);
    if (engine.pruned.length > 0) say("info", `removed old engines: ${engine.pruned.join(", ")}`);
    writeLauncher(paths, layout.launcherTemplate);
    say("ok", `launcher ${paths.launcher} (node ${stableNodePath()})`);
    writeInstallState(paths.installState, { timeoutSec: opts.timeoutSec });
  }

  if (opts.bundled) printBundled(installBundled(paths, layout.plugins, loadDefaults(readConfig(paths.config))));

  const registry = compileRegistry(paths);
  saveRegistry(paths, registry);
  const events = neededEvents(registry);
  const hostResults = opts.adapters.map((a) => installHub(a, paths, events));
  const printed = printHostResults(hostResults);
  const hostsOk = (await approveHubs(paths, hostResults)) && printed;

  if (opts.skill) printSkill(layout.skill, opts.adapters);
  return hostsOk;
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
