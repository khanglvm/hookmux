// The notice shown at session start when a plugin that should be guarding is
// not running. hookmux fails open, so a guard whose files changed after
// promote, or one that no longer parses, stops blocking without a sound; this
// is how the user hears about it.

import type { Registry } from "../load/snapshot.ts";
import { PLUGIN_ID } from "./types.ts";

const MAX_LISTED = 5;

function listed(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(", ");
  return ids.length > MAX_LISTED ? `${shown} and ${ids.length - MAX_LISTED} more` : shown;
}

/**
 * Security: an invalid plugin's id is its raw folder name, which anyone who can
 * write plugins/ chooses, so a name that is not a plugin id (newlines, terminal
 * escapes, a fake all-clear) never reaches the host's message line.
 */
function shownId(id: string): string {
  return PLUGIN_ID.test(id) ? id : "(a folder with an invalid name)";
}

/** One line naming guard plugins that block nothing and plugins that do not load, or null when all is well. */
export function offPluginsNotice(registry: Registry): string | null {
  const unpromotedGuards = registry.plugins.filter((p) => p.status === "untrusted" && p.phase === "guard");
  const invalid = registry.plugins.filter((p) => p.status === "invalid");
  // `hookmux disable` and `add --shadow` work without promote, so an agent can switch a guard off with them.
  const switchedOff = registry.plugins.filter(
    (p) =>
      p.status === "active" &&
      p.phase === "guard" &&
      [p.base, ...Object.values(p.variants ?? {})].some((s) => s?.enabled === false || s?.shadow === true),
  );
  const parts: string[] = [];
  if (unpromotedGuards.length > 0) {
    const ids = unpromotedGuards.map((p) => p.id);
    parts.push(`guard plugin ${listed(ids)} is off until you run hookmux promote ${ids[0]}`);
  }
  if (switchedOff.length > 0) {
    parts.push(`guard plugin ${listed(switchedOff.map((p) => p.id))} is disabled or in shadow and blocks nothing`);
  }
  if (invalid.length > 0)
    parts.push(`plugin ${listed(invalid.map((p) => shownId(p.id)))} does not load (hookmux doctor)`);
  return parts.length > 0 ? `hookmux: ${parts.join("; ")}.` : null;
}
