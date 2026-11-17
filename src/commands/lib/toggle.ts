// Shared body of `enable` and `disable`: edit the hub's disabled list in flags.json.

import { readFlagsForUpdate, writeFlags } from "../../load/flags.ts";
import { homePaths } from "../../runtime/paths.ts";
import { parseCommand, UsageError } from "./args.ts";
import { syncAfterChange } from "./hosts.ts";
import { say } from "./output.ts";
import { isInstalled } from "./plugins.ts";

export async function setDisabled(argv: string[], usage: string, disabled: boolean): Promise<number> {
  const parsed = parseCommand(argv, {}, usage, 1);
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the plugin");
  const paths = homePaths();
  if (!isInstalled(paths, id)) {
    say("fail", `plugin '${id}' is not installed`, "hookmux list");
    return 1;
  }
  const flags = readFlagsForUpdate(paths.flags);
  const others = flags.disabled.filter((d) => d !== id);
  writeFlags(paths.flags, { ...flags, disabled: disabled ? [...others, id] : others });
  say("ok", `${id} ${disabled ? "disabled" : "enabled"}`);
  if (disabled) return 0;
  return syncAfterChange(paths) ? 0 : 1;
}
