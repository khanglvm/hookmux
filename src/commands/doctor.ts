// `hookmux doctor`: check the install end to end and say what to run next.
// Works with logging off. `--fix` repairs what is safe to repair (launcher Node
// path, broken engine link, missing hub entries, old sessions) before checking.

// compileRegistry needs every check kind registered first.
import "../checks/index.ts";
import { existsSync } from "node:fs";
import { engineStatus, installEngine } from "../install/engine.ts";
import { rerecordNode, writeLauncher } from "../install/launcher.ts";
import { stableNodePath } from "../install/node-path.ts";
import { packageLayout } from "../install/package.ts";
import { compileRegistry } from "../load/registry.ts";
import { type HomePaths, homePaths } from "../runtime/paths.ts";
import { pruneSessions } from "../runtime/state.ts";
import { VERSION } from "../version.ts";
import { parseCommand } from "./lib/args.ts";
import {
  checkEngine,
  checkHealth,
  checkLauncher,
  checkLog,
  checkNode,
  checkRegistry,
  checkSessions,
  type Finding,
} from "./lib/doctor-checks.ts";
import { checkHosts } from "./lib/doctor-hosts.ts";
import { neededEvents, syncHosts } from "./lib/hosts.ts";
import { printJson, say } from "./lib/output.ts";

export const usage = `Usage: hookmux doctor [--json] [--fix]

Checks Node, the engine, the launcher, every wired host (including a real
launcher run), plugins, recorded failures, the log and session state.

  --fix   re-record the launcher's Node path, repair the engine link,
          re-sync hub entries and prune old sessions, then check`;

/** Next actions listed under the verdict. */
const MAX_NEXT = 3;

interface FixResult {
  action: string;
  ok: boolean;
  detail?: string;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { json: { type: "boolean" }, fix: { type: "boolean" } }, usage);
  if (!parsed) return 0;
  const paths = homePaths();
  const fixed = parsed.values.fix ? applyFixes(paths) : [];
  const registry = compileRegistry(paths);
  const checks: Finding[] = [
    ...checkNode(),
    ...checkEngine(paths),
    ...checkLauncher(paths),
    ...(await checkHosts(paths, neededEvents(registry))),
    ...checkRegistry(registry, paths),
    ...checkHealth(paths),
    ...checkLog(paths),
    ...checkSessions(paths),
  ];
  const problems = checks.filter((c) => c.status === "fail").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const next = [
    ...new Set(
      [...checks.filter((c) => c.status === "fail"), ...checks.filter((c) => c.status === "warn")]
        .map((c) => c.fix)
        .filter((f): f is string => f !== undefined),
    ),
  ].slice(0, MAX_NEXT);
  const verdict =
    problems > 0
      ? `${problems} problem(s), ${warnings} warning(s)`
      : warnings > 0
        ? `working, with ${warnings} warning(s)`
        : "hookmux is healthy";

  if (parsed.values.json) {
    printJson({ ok: problems === 0, version: VERSION, home: paths.root, fixed, checks, verdict, next });
    return problems > 0 ? 1 : 0;
  }
  for (const f of fixed) say(f.ok ? "ok" : "fail", `fix: ${f.action}${f.detail ? ` (${f.detail})` : ""}`);
  for (const c of checks) say(c.status, c.title, c.status === "fail" || c.status === "warn" ? c.fix : undefined);
  console.log("");
  say(problems > 0 ? "fail" : warnings > 0 ? "warn" : "ok", verdict);
  if (next.length > 0) console.log(`next: ${next.join("; ")}`);
  return problems > 0 ? 1 : 0;
}

function applyFixes(paths: HomePaths): FixResult[] {
  const results: FixResult[] = [];
  const attempt = (action: string, fn: () => string | undefined) => {
    try {
      const detail = fn();
      results.push({ action, ok: true, ...(detail ? { detail } : {}) });
    } catch (error) {
      results.push({ action, ok: false, detail: (error as Error).message });
    }
  };
  const engine = engineStatus(paths);
  if (!engine.ok) {
    attempt("re-copied the engine", () => installEngine(paths, packageLayout().dist, VERSION).version);
  }
  attempt("re-recorded the launcher's Node path", () => {
    if (existsSync(paths.launcher)) rerecordNode(paths);
    else writeLauncher(paths, packageLayout().launcherTemplate);
    return stableNodePath();
  });
  attempt("re-synced hub entries", () => {
    const { results: hosts } = syncHosts(paths);
    const failed = hosts.filter((h) => h.error);
    if (failed.length > 0) throw new Error(failed.map((h) => `${h.adapter.id}: ${h.error}`).join("; "));
    const added = hosts.flatMap((h) => h.change?.added.map((e) => `${h.adapter.id} ${e}`) ?? []);
    return added.length > 0 ? `added ${added.join(", ")}` : "nothing missing";
  });
  attempt("pruned old sessions", () => `${pruneSessions(paths.sessions)} removed`);
  return results;
}
