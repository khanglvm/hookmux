// `hookmux remove <id>`: delete a plugin's hub copy and every record of it.

import { existsSync, rmSync } from "node:fs";
import { readSources, writeSources } from "../install/records.ts";
import { readFlags, writeFlags } from "../load/flags.ts";
import { readTrust, writeTrust } from "../load/trust.ts";
import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { syncAfterChange } from "./lib/hosts.ts";
import { say } from "./lib/output.ts";
import { installedDir } from "./lib/plugins.ts";

export const usage = `Usage: hookmux remove <id>

Deletes plugins/<id>/ and its trust, flag and source records.`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, {}, usage, 1);
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the plugin to remove");
  const paths = homePaths();
  const dir = installedDir(paths, id);
  const trust = readTrust(paths.trust);
  const flags = readFlags(paths.flags);
  const sources = readSources(paths.sources);
  const known = existsSync(dir) || trust.plugins[id] || sources[id];
  if (!known) {
    say("fail", `plugin '${id}' is not installed`, "hookmux list");
    return 1;
  }
  rmSync(dir, { recursive: true, force: true });
  delete trust.plugins[id];
  delete sources[id];
  writeTrust(paths.trust, trust);
  writeSources(paths.sources, sources);
  writeFlags(paths.flags, {
    shadow: flags.shadow.filter((s) => s !== id),
    disabled: flags.disabled.filter((s) => s !== id),
  });
  say("ok", `removed ${id}`);
  return syncAfterChange(paths) ? 0 : 1;
}
