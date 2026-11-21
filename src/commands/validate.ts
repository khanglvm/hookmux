// `hookmux validate <path>`: compile a plugin folder and report its problems.

import "../checks/index.ts";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { type CompatRow, planPlugin } from "../core/compat.ts";
import { ADAPTERS } from "../hosts/index.ts";
import { readConfig } from "../load/config.ts";
import { compileManifest, MANIFEST_FILE, ManifestError, readManifest } from "../load/manifest.ts";
import { capabilitiesOf, hashPlugin, listPluginFiles } from "../load/trust.ts";
import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { compatLines } from "./lib/compat.ts";
import { detail, printJson, say } from "./lib/output.ts";
import { loadDefaults } from "./lib/plugins.ts";

export const usage = `Usage: hookmux validate <path> [--json]

Checks a plugin folder (or its plugin.toml) the way 'hookmux add' would.
Exit 1 when it has problems.`;

export interface ValidateReport {
  ok: boolean;
  path: string;
  id: string | null;
  problems: string[];
  warnings: string[];
  capabilities: string[];
  /** What each effect does on each host and event the plugin reaches; see src/core/compat.ts. */
  compat: CompatRow[];
}

/** Compiles the plugin at `dir`; never throws for plugin problems. */
export function validatePlugin(dir: string): ValidateReport {
  const report: ValidateReport = {
    ok: false,
    path: dir,
    id: null,
    problems: [],
    warnings: [],
    capabilities: [],
    compat: [],
  };
  try {
    listPluginFiles(dir);
    hashPlugin(dir);
    const raw = readManifest(dir);
    if (typeof raw.id === "string") report.id = raw.id;
    const compiled = compileManifest(raw, dir, undefined, loadDefaults(readConfig(homePaths().config)));
    report.warnings = compiled.warnings;
    report.capabilities = capabilitiesOf(compiled.base, Object.values(compiled.variants));
    report.compat = planPlugin(compiled, Object.values(ADAPTERS));
  } catch (error) {
    report.problems = error instanceof ManifestError ? error.problems : [(error as Error).message];
  }
  report.ok = report.problems.length === 0;
  return report;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { json: { type: "boolean" } }, usage, 1);
  if (!parsed) return 0;
  const target = parsed.positionals[0];
  if (!target) throw new UsageError("name the plugin folder to validate");
  let dir = resolve(target);
  if (basename(dir) === MANIFEST_FILE) dir = dirname(dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`${target} is not a folder`);
  const report = validatePlugin(dir);
  if (parsed.values.json) {
    printJson(report);
    return report.ok ? 0 : 1;
  }
  if (report.ok) {
    say("ok", `${report.id} is valid (${report.capabilities.join(", ")})`);
    for (const l of compatLines(report.compat)) detail(l);
  } else
    say(
      "fail",
      `${report.id ?? dir} has ${report.problems.length} problem(s)`,
      `fix them, then: hookmux validate ${target}`,
    );
  for (const p of report.problems) detail(`✗ ${p}`);
  for (const w of report.warnings) detail(`! ${w}`);
  return report.ok ? 0 : 1;
}
