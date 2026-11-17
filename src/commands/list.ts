// `hookmux list`: every installed plugin with its status and what it can do.

import { homePaths } from "../runtime/paths.ts";
import { parseCommand } from "./lib/args.ts";
import { detail, dim, printJson, type Status, say } from "./lib/output.ts";
import { type DisplayStatus, inspectInstalled, type PluginRow } from "./lib/plugins.ts";

export const usage = `Usage: hookmux list [--json]

Shows each installed plugin: status (active, untrusted, invalid, shadow,
disabled), phase, events, capabilities, its problem if any, and warnings.`;

const STATUS_MARK: Record<DisplayStatus, Status> = {
  active: "ok",
  shadow: "info",
  disabled: "info",
  untrusted: "warn",
  invalid: "fail",
};

export interface ListItem {
  id: string;
  status: DisplayStatus;
  version: string | null;
  description: string | null;
  phase: string | null;
  events: string[];
  capabilities: string[];
  problem: string | null;
  warnings: string[];
  source: string | null;
}

function toItem(row: PluginRow): ListItem {
  return {
    id: row.id,
    status: row.status,
    version: row.spec?.version ?? null,
    description: row.spec?.description ?? null,
    phase: row.spec?.phase ?? null,
    events: row.spec?.events ?? [],
    capabilities: row.entry.capabilities,
    problem: row.entry.problem ?? null,
    warnings: row.entry.warnings,
    source: row.source?.source ?? null,
  };
}

function nextStep(row: PluginRow): string | undefined {
  if (row.status === "untrusted") return `hookmux promote ${row.id}`;
  if (row.status === "invalid") return `hookmux validate ${row.dir}`;
  if (row.status === "disabled") return `hookmux enable ${row.id}`;
  return undefined;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { json: { type: "boolean" } }, usage);
  if (!parsed) return 0;
  const { rows } = inspectInstalled(homePaths());
  const items = rows.map(toItem);
  if (parsed.values.json) {
    printJson({ plugins: items });
    return rows.some((r) => r.status === "invalid") ? 1 : 0;
  }
  if (rows.length === 0) {
    say("info", "no plugins installed", "hookmux add <source>, or hookmux new <id>");
    return 0;
  }
  rows.forEach((row, i) => {
    const item = items[i] as ListItem;
    const what = item.phase ? `${item.phase} on ${item.events.join(", ")}` : "";
    say(STATUS_MARK[row.status], `${row.id} ${dim(row.status)} ${what}`.trimEnd(), nextStep(row));
    if (item.capabilities.length > 0) detail(dim(`can: ${item.capabilities.join(", ")}`));
    if (item.problem) detail(`problem: ${item.problem}`);
    for (const w of item.warnings) detail(`! ${w}`);
  });
  return rows.some((r) => r.status === "invalid") ? 1 : 0;
}
