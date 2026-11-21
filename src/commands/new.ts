// `hookmux new <id>`: scaffold a commented plugin.toml and a tests.toml that
// pass `hookmux test` as written, so authors start from something that works.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CANONICAL_EVENTS, type CanonicalEvent } from "../core/types.ts";
import { PLUGIN_ID } from "../load/manifest.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { detail, say } from "./lib/output.ts";
import { fillReadmeCard, repoFiles } from "./lib/repo-files.ts";
import { type ScaffoldFile, scaffoldFiles, TEMPLATE_EVENT, TEMPLATES, type TemplateName } from "./lib/templates.ts";
import { validatePlugin } from "./validate.ts";

export const usage = `Usage: hookmux new <id> [--template <name>] [--dir <path>] [--event <event>] [--repo [owner/name]]

Creates <dir>/<id>/ with plugin.toml and tests.toml.

  --template <name>    ${TEMPLATES.join(", ")} (default prompt-context)
                         tool-guard blocks a risky shell command (tool.before)
                         session-note injects a note from note.sh (session.start)
  --dir <path>         parent folder (default: the current folder)
  --event <event>      ${CANONICAL_EVENTS.join(", ")} (default prompt.submit);
                       only prompt-context takes a choice
  --repo [owner/name]  make <id>/ a publishable repository: adds a README.md
                       with the install line and a CI workflow`;

const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** `--repo` may stand alone or take owner/name; parseArgs wants a value, so a bare flag becomes `--repo=`. */
function normalizeRepoFlag(argv: string[]): string[] {
  return argv.map((arg, i) => (arg === "--repo" && !OWNER_NAME.test(argv[i + 1] ?? "") ? "--repo=" : arg));
}

/** The template's event; an --event that disagrees with a fixed-event template is a usage error. */
function resolveEvent(template: TemplateName, requested: string | undefined): CanonicalEvent {
  if (template === "prompt-context") {
    const event = (requested ?? "prompt.submit") as CanonicalEvent;
    if (!CANONICAL_EVENTS.includes(event)) throw new UsageError(`unknown event '${event}'`);
    return event;
  }
  const fixed = TEMPLATE_EVENT[template];
  if (requested !== undefined && requested !== fixed) {
    throw new UsageError(`the ${template} template listens to ${fixed}, not '${requested}'`);
  }
  return fixed;
}

function writeFiles(dir: string, files: ScaffoldFile[]): void {
  for (const f of files) {
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, f.content, { mode: f.mode });
  }
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    normalizeRepoFlag(argv),
    { dir: { type: "string" }, event: { type: "string" }, template: { type: "string" }, repo: { type: "string" } },
    usage,
    1,
  );
  if (!parsed) return 0;
  const id = parsed.positionals[0];
  if (!id) throw new UsageError("name the new plugin, e.g. hookmux new my-plugin");
  if (!PLUGIN_ID.test(id)) throw new UsageError(`'${id}' is not a valid id: use lowercase letters, digits and dashes`);
  const template = (parsed.values.template ?? "prompt-context") as TemplateName;
  if (!TEMPLATES.includes(template)) {
    throw new UsageError(`unknown template '${template}': use ${TEMPLATES.join(", ")}`);
  }
  const event = resolveEvent(template, parsed.values.event);
  const repo = parsed.values.repo;
  if (repo !== undefined && repo !== "" && !OWNER_NAME.test(repo)) {
    throw new UsageError(`--repo takes owner/name, not '${repo}'`);
  }
  const dir = join(resolve(parsed.values.dir ?? "."), id);
  if (existsSync(dir)) {
    say("fail", `${dir} already exists`, `pick another id or --dir`);
    return 1;
  }
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFiles(dir, [
    ...scaffoldFiles(id, template, event),
    ...(repo === undefined ? [] : repoFiles(id, template, repo)),
  ]);
  const report = validatePlugin(dir);
  if (!report.ok) {
    say("fail", `scaffold does not validate: ${report.problems.join("; ")}`, "report this as a hookmux bug");
    return 1;
  }
  if (repo !== undefined) fillReadmeCard(dir, id, repo);
  say("ok", `created ${dir}`);
  // A script check stays unknown, and its cases skipped, until the test is told to run scripts.
  const runScripts = template === "session-note" ? " --run-scripts" : "";
  detail(`edit plugin.toml and tests.toml, then: hookmux test ${dir}${runScripts}`);
  detail(`install it: hookmux add ${dir}`);
  if (repo !== undefined) detail("publish it: git init and push to GitHub");
  return 0;
}
