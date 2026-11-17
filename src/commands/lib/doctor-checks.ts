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

export function checkSessions(paths: HomePaths): Finding[] {
  const count = existsSync(paths.sessions) ? readdirSync(paths.sessions).length : 0;
  return count > MANY_SESSIONS
    ? [{ id: "sessions", status: "warn", title: `${count} session files`, fix: "hookmux doctor --fix" }]
    : [{ id: "sessions", status: "info", title: `${count} session file(s)` }];
}
