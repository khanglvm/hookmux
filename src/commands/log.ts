// `hookmux log`: switch the opt-in decision log on and off, and read it.
// The hook writes the log (src/runtime/log.ts); this command only edits its
// settings and pretty-prints its JSON lines.

import { rmSync } from "node:fs";
import { readLogSettings, writeLogSettings } from "../runtime/log.ts";
import { type HomePaths, homePaths } from "../runtime/paths.ts";
import { parseCommand, positiveInt, UsageError } from "./lib/args.ts";
import { type LogRecord, readRecords } from "./lib/log-read.ts";
import { describeLogStatus, readLogStatus } from "./lib/log-status.ts";
import { detail, dim, printJson, say } from "./lib/output.ts";

export const usage = `Usage: hookmux log <on|off|status|show|path|clear> [options]

  on [--for <30m|24h|7d>] [--prompts]  start logging each hook run (no expiry without --for)
  off                                  stop logging
  status [--json]                      on or off, size and expiry
  show [-n 20] [--json] [--plugin <id>] [--errors]
                                       one line per run, newest last
  path                                 print the log file path
  clear                                delete the log files

--prompts also stores the first 500 characters of every prompt on this machine.`;

const DURATION = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const DEFAULT_SHOW = 20;

/** Milliseconds for "30m", "24h" or "7d". */
export function parseDuration(text: string): number {
  const m = DURATION.exec(text);
  if (!m || Number(m[1]) === 0) throw new UsageError(`--for must look like 30m, 24h or 7d, not '${text}'`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === "--help" || sub === "-h") {
    console.log(usage);
    return sub === undefined ? 2 : 0;
  }
  const paths = homePaths();
  switch (sub) {
    case "on":
      return logOn(paths, rest);
    case "off":
      return simple(rest, () => {
        writeLogSettings(paths.logSettings, { ...readLogSettings(paths.logSettings), enabled: false });
        say("ok", "logging off");
      });
    case "status":
      return logStatus(paths, rest);
    case "show":
      return logShow(paths, rest);
    case "path":
      return simple(rest, () => console.log(paths.logFile));
    case "clear":
      return simple(rest, () => {
        for (const f of [paths.logFile, `${paths.logFile}.1`]) rmSync(f, { force: true });
        say("ok", "log cleared");
      });
    default:
      throw new UsageError(`unknown log command '${sub}'`);
  }
}

function simple(argv: string[], action: () => void): number {
  if (!parseCommand(argv, {}, usage)) return 0;
  action();
  return 0;
}

function logOn(paths: HomePaths, argv: string[]): number {
  const parsed = parseCommand(argv, { for: { type: "string" }, prompts: { type: "boolean" } }, usage);
  if (!parsed) return 0;
  const forMs = parsed.values.for === undefined ? undefined : parseDuration(parsed.values.for);
  const until = forMs === undefined ? undefined : new Date(Date.now() + forMs).toISOString();
  const prompts = parsed.values.prompts === true;
  writeLogSettings(paths.logSettings, { enabled: true, prompts, ...(until ? { until } : {}) });
  say("ok", `logging on${until ? ` until ${until}` : " with no expiry"}: ${paths.logFile}`);
  if (prompts) say("warn", "prompt text (first 500 characters) will be stored locally in that file", "hookmux log off");
  else detail(dim("prompts are stored only as a short hash and length"));
  return 0;
}

function logStatus(paths: HomePaths, argv: string[]): number {
  const parsed = parseCommand(argv, { json: { type: "boolean" } }, usage);
  if (!parsed) return 0;
  const status = readLogStatus(paths);
  if (parsed.values.json) printJson(status);
  else
    say(
      status.active ? "ok" : "info",
      describeLogStatus(status),
      status.active ? undefined : "hookmux log on --for 24h",
    );
  return 0;
}

function hasErrors(r: LogRecord): boolean {
  if ((r.errors?.length ?? 0) > 0) return true;
  return (r.plugins ?? []).some(
    (p) =>
      p.outcome === "error" ||
      Object.values(p.signals ?? {}).some((v) => typeof v === "string" && v.startsWith("error:")),
  );
}

function logShow(paths: HomePaths, argv: string[]): number {
  const parsed = parseCommand(
    argv,
    {
      n: { type: "string", short: "n" },
      json: { type: "boolean" },
      plugin: { type: "string" },
      errors: { type: "boolean" },
    },
    usage,
  );
  if (!parsed) return 0;
  const limit = positiveInt(parsed.values.n, "-n", DEFAULT_SHOW);
  const id = parsed.values.plugin;
  const records = readRecords(paths)
    .filter((r) => !id || (r.plugins ?? []).some((p) => p.id === id))
    .filter((r) => !parsed.values.errors || hasErrors(r))
    .slice(-limit);
  if (parsed.values.json) {
    printJson({ entries: records });
    return 0;
  }
  if (records.length === 0) {
    const status = readLogStatus(paths);
    say("info", "no matching log entries", status.active ? undefined : "hookmux log on --for 24h");
    return 0;
  }
  for (const r of records) console.log(formatRecord(r));
  return 0;
}

function formatRecord(r: LogRecord): string {
  const time = typeof r.ts === "string" ? `${r.ts.replace("T", " ").slice(0, 19)}Z` : "?";
  const fired = (r.plugins ?? []).filter((p) => p.outcome === "fire").map((p) => p.id);
  const failed = (r.plugins ?? []).filter((p) => p.outcome === "error").map((p) => p.id);
  const parts = [
    dim(time),
    String(r.host ?? "?"),
    String(r.event ?? "?"),
    `${String(r.ms ?? "?")}ms`,
    fired.length > 0 ? `fired: ${fired.join(", ")}` : dim("fired: none"),
  ];
  if (failed.length > 0) parts.push(`plugin errors: ${failed.join(", ")}`);
  if ((r.errors?.length ?? 0) > 0) parts.push(`errors: ${(r.errors ?? []).join("; ")}`);
  return parts.join("  ");
}
