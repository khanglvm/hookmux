// Printing for compatibility rows (src/core/compat.ts), shared by `validate`
// and `test`: a one-line summary of the hosts where everything works, then one
// line per row that needs a mention.

import { type CompatCaveat, type CompatRow, isPlain } from "../../core/compat.ts";

const WIDTHS = { host: 11, event: 14, effect: 7 };

function outcomeText(row: CompatRow): string {
  if (row.outcome === "works") return "works";
  if (row.outcome === "fallback") return `→ ${row.as} (${row.via === "author" ? "fallback" : "engine"})`;
  return `dropped: ${row.note ?? "host cannot do this here"}`;
}

function caveatText(c: CompatCaveat): string {
  return `${c.value === false ? "✗" : "?"} ${c.feature}: ${c.note}`;
}

function line(row: CompatRow): string {
  const head = [
    row.host.padEnd(WIDTHS.host),
    row.event.padEnd(WIDTHS.event),
    row.effect.padEnd(WIDTHS.effect),
    outcomeText(row),
  ].join(" ");
  return [head, ...row.caveats.map(caveatText)].join("  ");
}

/** Lines to print under a result; empty when there are no rows. */
export function compatLines(rows: CompatRow[]): string[] {
  if (rows.length === 0) return [];
  const hosts = [...new Set(rows.map((r) => r.host))];
  const plainHosts = hosts.filter((h) => rows.filter((r) => r.host === h).every(isPlain));
  const lines: string[] = [];
  if (plainHosts.length > 0) lines.push(`compat: works everywhere on ${plainHosts.join(", ")}`);
  for (const row of rows) if (!plainHosts.includes(row.host)) lines.push(line(row));
  return lines;
}
