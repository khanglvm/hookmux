// Doctor checks that read only the home folder: Node, engine, launcher,
// registry, recorded failures, log and session state. Each returns findings;
// none of them changes anything.

import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { engineStatus } from "../../install/engine.ts";
import { readLauncherInfo } from "../../install/launcher.ts";
import type { Registry } from "../../load/snapshot.ts";
import { readHealth } from "../../runtime/health.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { VERSION } from "../../version.ts";
import { type LogRecord, readRecords } from "./log-read.ts";
import { describeLogStatus, readLogStatus } from "./log-status.ts";
import type { Status } from "./output.ts";

export interface Finding {
  id: string;
  status: Status;
  title: string;
  /** The command (or action) that resolves a warning or problem. */
  fix?: string;
}

const MIN_NODE_MAJOR = 22;
/** Recorded failures shown in full; the rest are counted. */
const HEALTH_SHOWN = 5;
/** Above this many session files, suggest pruning. */
const MANY_SESSIONS = 1000;
/** Fewer logged runs than this say too little about speed to name a slow plugin. */
const MIN_RUNS_FOR_TIMING = 20;
const SLOWEST_SHOWN = 3;
const P95 = 0.95;

export function checkNode(): Finding[] {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? [{ id: "node", status: "ok", title: `Node ${process.versions.node}` }]
    : [
        {
          id: "node",
          status: "fail",
          title: `Node ${process.versions.node} is too old`,
          fix: `install Node ${MIN_NODE_MAJOR} or later`,
        },
      ];
}

export function checkEngine(paths: HomePaths): Finding[] {
  const s = engineStatus(paths);
  if (!s.ok)
    return [{ id: "engine", status: "fail", title: s.problem ?? "engine missing", fix: "hookmux doctor --fix" }];
  if (s.version !== VERSION) {
    return [
      {
        id: "engine",
        status: "warn",
        title: `engine ${s.version} differs from this CLI (${VERSION})`,
        fix: "hookmux init",
      },
    ];
  }
  return [{ id: "engine", status: "ok", title: `engine ${s.version}` }];
}

export function checkLauncher(paths: HomePaths): Finding[] {
  const l = readLauncherInfo(paths);
  if (!l.exists)
    return [{ id: "launcher", status: "fail", title: `no launcher at ${paths.launcher}`, fix: "hookmux init" }];
  const out: Finding[] = [];
  if (!l.executable)
    out.push({ id: "launcher", status: "fail", title: "launcher is not executable", fix: "hookmux doctor --fix" });
  if (!l.node || !isExecutable(l.node)) {
    out.push({
      id: "launcher.node",
      status: "fail",
      title: `launcher's Node '${l.node ?? "?"}' is missing`,
      fix: "hookmux doctor --fix",
    });
  }
  if (l.root !== paths.root) {
    out.push({
      id: "launcher.root",
      status: "fail",
      title: `launcher points at home '${l.root ?? "?"}'`,
      fix: "hookmux init",
    });
  }
  return out.length > 0 ? out : [{ id: "launcher", status: "ok", title: `launcher (node ${l.node})` }];
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function checkRegistry(registry: Registry, paths: HomePaths): Finding[] {
  const out: Finding[] = registry.problems.map((p) => ({
    id: "config",
    status: "fail" as const,
    title: p,
    fix: `edit ${paths.config}`,
  }));
  for (const p of registry.plugins) {
    if (p.status === "invalid") {
      out.push({
        id: `plugin.${p.id}`,
        status: "fail",
        title: `${p.id} is invalid: ${p.problem}`,
        fix: `hookmux validate ${paths.plugins}/${p.id}`,
      });
    } else if (p.status === "untrusted") {
      out.push({
        id: `plugin.${p.id}`,
        status: "warn",
        title: `${p.id} is untrusted: ${p.problem}`,
        fix: `hookmux promote ${p.id}`,
      });
    }
    for (const w of p.warnings) out.push({ id: `plugin.${p.id}`, status: "warn", title: `${p.id}: ${w}` });
  }
  const active = registry.plugins.filter((p) => p.status === "active").length;
  out.unshift({ id: "plugins", status: "ok", title: `${registry.plugins.length} plugin(s), ${active} active` });
  return out;
}

export function checkHealth(paths: HomePaths): Finding[] {
  const entries = readHealth(paths.health).entries;
  if (entries.length === 0) return [{ id: "health", status: "ok", title: "no recorded hook failures" }];
  const out: Finding[] = entries.slice(0, HEALTH_SHOWN).map((e) => ({
    id: `health.${e.key}`,
    status: "warn" as const,
    title: `${e.key} failed ${e.count}x, last ${e.lastAt}: ${e.message}`,
    fix: "hookmux log on --for 30m, then hookmux log show --errors",
  }));
  if (entries.length > HEALTH_SHOWN) {
    out.push({ id: "health", status: "info", title: `${entries.length - HEALTH_SHOWN} more recorded failure(s)` });
  }
  return out;
}

export function checkLog(paths: HomePaths): Finding[] {
  return [{ id: "log", status: "info", title: describeLogStatus(readLogStatus(paths)) }];
}

export interface PluginTiming {
  id: string;
  event: string;
  p95Ms: number;
}

/** Plugins by 95th-percentile time per event (nearest rank), slowest first; empty below MIN_RUNS_FOR_TIMING runs. */
export function slowestPlugins(records: LogRecord[], top = SLOWEST_SHOWN): PluginTiming[] {
  if (records.length < MIN_RUNS_FOR_TIMING) return [];
  const samples = new Map<string, { id: string; event: string; times: number[] }>();
  for (const r of records) {
    for (const p of r.plugins ?? []) {
      if (typeof p.ms !== "number") continue;
      const event = String(r.event ?? "?");
      const entry = samples.get(`${p.id}\0${event}`) ?? { id: p.id, event, times: [] };
      entry.times.push(p.ms);
      samples.set(`${p.id}\0${event}`, entry);
    }
  }
  return [...samples.values()]
    .map(({ id, event, times }) => {
      times.sort((a, b) => a - b);
      return { id, event, p95Ms: times[Math.ceil(P95 * times.length) - 1] as number };
    })
    .sort((a, b) => b.p95Ms - a.p95Ms || a.id.localeCompare(b.id))
    .slice(0, top);
}

/** Names the slowest plugins from the decision log; says nothing when the log is off or short. */
export function checkTiming(paths: HomePaths): Finding[] {
  if (!readLogStatus(paths).active) return [];
  const slowest = slowestPlugins(readRecords(paths));
  if (slowest.length === 0) return [];
  const list = slowest.map((t) => `${t.id} p95 ${t.p95Ms} ms on ${t.event}`).join(", ");
  return [{ id: "timing", status: "info", title: `slowest: ${list}` }];
}

export function checkSessions(paths: HomePaths): Finding[] {
  const count = existsSync(paths.sessions) ? readdirSync(paths.sessions).length : 0;
  return count > MANY_SESSIONS
    ? [{ id: "sessions", status: "warn", title: `${count} session files`, fix: "hookmux doctor --fix" }]
    : [{ id: "sessions", status: "info", title: `${count} session file(s)` }];
}
