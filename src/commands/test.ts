// `hookmux test [<id>|<path>]`: run a plugin's tests.toml cases through the
// real engine. Shadow and dedupe are forced off so each case sees the plugin's
// own decision; model checks return unknown unless --live.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { runEngine } from "../core/engine.ts";
import type { PluginOutcome, PluginSpec, Signal } from "../core/types.ts";
import { ADAPTERS } from "../hosts/index.ts";
import { readConfig } from "../load/config.ts";
import { compileManifest, ManifestError, PLUGIN_ID, readManifest } from "../load/manifest.ts";
import { compileRegistry } from "../load/registry.ts";
import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { parseCases, TESTS_FILE, type TestCase } from "./lib/cases.ts";
import { clip, detail, printJson, say } from "./lib/output.ts";
import { loadDefaults } from "./lib/plugins.ts";
import {
  adapterOrUsage,
  engineSettings,
  formatSignals,
  STUBBED_MODEL_ERROR,
  sampleEvent,
  stubModelChecks,
} from "./lib/run.ts";

export const usage = `Usage: hookmux test [<id>|<path>] [--json] [--live]

Runs the [[case]] entries in a plugin's tests.toml. With no argument, tests
every installed plugin. Exit 1 when a case fails.

  --live  call model-backed checks (default: they return unknown)`;

type CaseStatus = "pass" | "fail" | "skip";

interface CaseResult {
  index: number;
  prompt: string;
  host: string;
  event: string;
  expect: TestCase["expect"];
  cwd?: string;
  /** "not-selected" when the plugin does not listen to this host, event or origin. */
  outcome: PluginOutcome | "not-selected";
  status: CaseStatus;
  signals: Record<string, Signal>;
  note?: string;
}

interface PluginReport {
  id: string;
  path: string;
  problems: string[];
  /** Set when the plugin has no tests.toml: not a failure, but nothing was tested. */
  untested?: boolean;
  cases: CaseResult[];
}

interface Summary {
  passed: number;
  failed: number;
  skipped: number;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { json: { type: "boolean" }, live: { type: "boolean" } }, usage, 1);
  if (!parsed) return 0;
  if (!parsed.values.live) stubModelChecks();
  const paths = homePaths();
  const targets = resolveTargets(parsed.positionals[0], paths.plugins);
  const settings = engineSettings(compileRegistry(paths));
  const config = readConfig(paths.config);
  const reports: PluginReport[] = [];
  for (const { dir, installed } of targets) {
    reports.push(await testPlugin(dir, installed ? config.overrides : {}, loadDefaults(config), settings));
  }
  const all = reports.flatMap((r) => r.cases);
  const summary: Summary = {
    passed: all.filter((c) => c.status === "pass").length,
    failed: all.filter((c) => c.status === "fail").length,
    skipped: all.filter((c) => c.status === "skip").length,
  };
  const ok = summary.failed === 0 && reports.every((r) => r.problems.length === 0);
  if (parsed.values.json) printJson({ ok, plugins: reports, summary });
  else printReports(reports, summary, targets.length);
  return ok ? 0 : 1;
}

function resolveTargets(arg: string | undefined, pluginsDir: string): { dir: string; installed: boolean }[] {
  if (arg === undefined) {
    if (!existsSync(pluginsDir)) return [];
    return readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && PLUGIN_ID.test(d.name))
      .map((d) => ({ dir: join(pluginsDir, d.name), installed: true }))
      .sort((a, b) => a.dir.localeCompare(b.dir));
  }
  if (PLUGIN_ID.test(arg) && existsSync(join(pluginsDir, arg)))
    return [{ dir: join(pluginsDir, arg), installed: true }];
  if (existsSync(arg)) return [{ dir: resolve(arg), installed: false }];
  throw new UsageError(`'${arg}' is neither an installed plugin nor a folder`);
}

async function testPlugin(
  dir: string,
  overrides: Record<string, Record<string, unknown>>,
  defaults: ReturnType<typeof loadDefaults>,
  settings: ReturnType<typeof engineSettings>,
): Promise<PluginReport> {
  const report: PluginReport = { id: basename(dir), path: dir, problems: [], cases: [] };
  let compiled: ReturnType<typeof compileManifest>;
  try {
    const raw = readManifest(dir);
    if (typeof raw.id === "string") report.id = raw.id;
    compiled = compileManifest(raw, dir, overrides[report.id], defaults);
  } catch (error) {
    report.problems = error instanceof ManifestError ? error.problems : [(error as Error).message];
    return report;
  }
  const testsFile = join(dir, TESTS_FILE);
  if (!existsSync(testsFile)) {
    report.untested = true;
    return report;
  }
  const { cases, problems } = parseCases(readFileSync(testsFile, "utf8"), Object.keys(ADAPTERS));
  report.problems.push(...problems);
  for (const [i, c] of cases.entries()) {
    const spec = compiled.variants[c.host] ?? compiled.base;
    report.cases.push(await runCase(i + 1, c, spec, settings));
  }
  return report;
}

async function runCase(
  index: number,
  c: TestCase,
  spec: PluginSpec,
  settings: ReturnType<typeof engineSettings>,
): Promise<CaseResult> {
  const event = sampleEvent(adapterOrUsage(c.host), c.event, c.prompt, c.cwd);
  const plugin: PluginSpec = { ...spec, shadow: false, dedupe: "none", enabled: true };
  const result = await runEngine({ event, plugins: [plugin], settings, firedThisSession: new Set() });
  const trace = result.trace.find((t) => t.id === spec.id);
  const outcome = trace?.outcome ?? "not-selected";
  const signals = trace?.signals ?? {};
  const stubbed = Object.values(signals).some((s) => s.error === STUBBED_MODEL_ERROR);
  // Only a clean decision passes: an unknown outcome (a check errored) is not "silent".
  const expected = c.expect === "fire" ? outcome === "fire" : outcome === "silent" || outcome === "not-selected";
  const status: CaseStatus = outcome === "unknown" && stubbed ? "skip" : expected ? "pass" : "fail";
  const note =
    trace?.note ?? (outcome === "not-selected" ? "plugin does not listen to this host, event or origin" : undefined);
  return {
    index,
    prompt: c.prompt,
    host: c.host,
    event: c.event,
    expect: c.expect,
    ...(c.cwd ? { cwd: c.cwd } : {}),
    outcome,
    status,
    signals,
    ...(note ? { note } : {}),
  };
}

function printReports(reports: PluginReport[], summary: Summary, targetCount: number): void {
  if (targetCount === 0) say("info", "no plugins installed", "hookmux test <path>");
  for (const r of reports) {
    if (r.untested) say("warn", `${r.id}: no ${TESTS_FILE}, nothing tested`, `add ${TESTS_FILE} next to plugin.toml`);
    for (const p of r.problems) say("fail", `${r.id}: ${p}`, `hookmux validate ${r.path}`);
    for (const c of r.cases) {
      const label = `${r.id} #${c.index} ${c.expect}: ${clip(c.prompt || c.cwd || c.event, 50)}`;
      if (c.status === "pass") say("ok", label);
      else if (c.status === "skip")
        say("warn", `${label} (unknown: model check stubbed)`, `hookmux test ${r.id} --live`);
      else {
        say("fail", `${label} → got ${c.outcome}`);
        if (Object.keys(c.signals).length > 0) detail(`signals: ${formatSignals(c.signals)}`);
        if (c.note) detail(`note: ${c.note}`);
      }
    }
  }
  say(
    summary.failed > 0 ? "fail" : "ok",
    `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
  );
}
