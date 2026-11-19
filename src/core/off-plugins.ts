// The notice shown at session start when a plugin that should be guarding is
// not running. hookmux fails open, so a guard whose files changed after
// promote, or one that no longer parses, stops blocking without a sound; this
// is how the user hears about it.

import type { Registry } from "../load/snapshot.ts";

const MAX_LISTED = 5;

function listed(ids: string[]): string {
  const shown = ids.slice(0, MAX_LISTED).join(", ");
  return ids.length > MAX_LISTED ? `${shown} and ${ids.length - MAX_LISTED} more` : shown;
}

/** One line naming guard plugins waiting for promote and plugins that do not load, or null when all is well. */
export function offPluginsNotice(registry: Registry): string | null {
  const unpromotedGuards = registry.plugins.filter((p) => p.status === "untrusted" && p.phase === "guard");
  const invalid = registry.plugins.filter((p) => p.status === "invalid");
  const parts: string[] = [];
  if (unpromotedGuards.length > 0) {
    const ids = unpromotedGuards.map((p) => p.id);
    parts.push(`guard plugin ${listed(ids)} is off until you run hookmux promote ${ids[0]}`);
  }
  if (invalid.length > 0) parts.push(`plugin ${listed(invalid.map((p) => p.id))} does not load (hookmux doctor)`);
  return parts.length > 0 ? `hookmux: ${parts.join("; ")}.` : null;
}
