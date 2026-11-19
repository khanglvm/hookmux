// `hookmux add <source>`: copy plugins from a folder or git repository into the
// hub. New plugins stay untrusted; only `promote`, run by a person in a
// terminal, activates them.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { discoverPlugins } from "../install/discover.ts";
import { type FetchedSource, fetchSource } from "../install/fetch.ts";
import { readSources, writeSources } from "../install/records.ts";
import { parseSource, SourceError } from "../install/source.ts";
import { discardStaged, PluginExistsError, placeStaged, type StagedPlugin, stagePlugin } from "../install/stage.ts";
import { readConfig } from "../load/config.ts";
import { readFlagsForUpdate, writeFlags } from "../load/flags.ts";
import { type HomePaths, homePaths } from "../runtime/paths.ts";
import { agentMarker } from "./lib/agent-env.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { syncAfterChange } from "./lib/hosts.ts";
import { detail, say } from "./lib/output.ts";
import { loadDefaults } from "./lib/plugins.ts";
import { applyStandingApprovals, promotePlugin } from "./lib/promote.ts";
import { isInteractive } from "./lib/prompt.ts";

export const usage = `Usage: hookmux add <source> [--plugin <id>]... [--shadow] [--list] [--force]

Copies plugins into the hookmux home. They stay untrusted until promoted,
unless a standing approval (hookmux promote <id> --standing) covers them.

Sources:
  ./path or /path                 a local folder (an existing path always wins)
  owner/repo[@ref]                a GitHub repository
  https://host/o/r(.git)          any https git URL
  https://github.com/o/r/tree/<ref>/<subpath>
  git@host:o/r.git                an SSH git URL (uses your git credentials)

Plugins are found at plugin.toml, plugins/*/, hookmux/*/ and skills/*/hookmux/.

  --plugin <id>  only these plugins (repeatable)
  --shadow       mark them shadow: evaluated and logged, output withheld
  --list         show what the source contains; install nothing
  --force        replace an installed plugin with the same id`;

interface Candidate {
  dir: string;
  staged?: StagedPlugin;
  problem?: string;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    argv,
    {
      plugin: { type: "string", multiple: true },
      shadow: { type: "boolean" },
      list: { type: "boolean" },
      force: { type: "boolean" },
    },
    usage,
    1,
  );
  if (!parsed) return 0;
  const sourceText = parsed.positionals[0];
  if (!sourceText) throw new UsageError("name a source: a folder, owner/repo or a git URL");
  let spec: ReturnType<typeof parseSource>;
  try {
    spec = parseSource(sourceText, existsSync);
  } catch (error) {
    if (error instanceof SourceError) throw new UsageError(error.message);
    throw error;
  }
  const paths = homePaths();
  // Fail before fetching or staging anything when flags.json cannot be updated safely.
  readFlagsForUpdate(paths.flags);
  const fetched = await fetchSource(spec);
  let added: string[];
  let ok: boolean;
  try {
    const candidates = stageAll(fetched, paths, parsed.values.plugin ?? []);
    if (candidates === null) return 1;
    if (parsed.values.list) return listCandidates(candidates, fetched.root);
    ({ added, ok } = install(candidates, fetched, paths, {
      force: parsed.values.force === true,
      shadow: parsed.values.shadow === true,
    }));
  } finally {
    fetched.cleanup();
  }
  if (added.length === 0) return 1;
  const standing = applyStandingApprovals(paths, added);
  if (!(await syncAfterChange(paths))) ok = false;
  // Offer to promote only where promote itself would ask; elsewhere print the command.
  const canAsk = isInteractive() && agentMarker(process.env) === undefined;
  for (const id of added.filter((a) => !standing.includes(a))) {
    if (canAsk) await promotePlugin(paths, id, { assumeYes: false });
    else say("info", `${id} is untrusted until you promote it in your own terminal`, `hookmux promote ${id}`);
  }
  return ok ? 0 : 1;
}

/** Finds and stages the plugins in a source. Returns null (after reporting) when none match. */
function stageAll(fetched: FetchedSource, paths: HomePaths, wanted: string[]): Candidate[] | null {
  const dirs = discoverPlugins(fetched.root);
  if (dirs.length === 0) {
    say("fail", `no plugin.toml found in ${fetched.source}`, "hookmux new <id> to start one");
    return null;
  }
  const defaults = loadDefaults(readConfig(paths.config));
  const candidates: Candidate[] = dirs.map((dir) => {
    try {
      return { dir, staged: stagePlugin(dir, paths, defaults) };
    } catch (error) {
      return { dir, problem: (error as Error).message };
    }
  });
  if (wanted.length === 0) return candidates;
  const picked = candidates.filter((c) => c.staged && wanted.includes(c.staged.id));
  for (const c of candidates) if (c.staged && !picked.includes(c)) discardStaged(c.staged);
  const missing = wanted.filter((id) => !picked.some((c) => c.staged?.id === id));
  if (missing.length > 0) {
    for (const c of picked) if (c.staged) discardStaged(c.staged);
    say("fail", `not found in the source: ${missing.join(", ")}`, `hookmux add ${fetched.source} --list`);
    return null;
  }
  return picked;
}

function listCandidates(candidates: Candidate[], root: string): number {
  for (const c of candidates) {
    const where = relative(root, c.dir) || ".";
    if (!c.staged) {
      say("fail", `${where}: ${c.problem}`, `hookmux validate ${c.dir}`);
      continue;
    }
    const { id, compiled, capabilities } = c.staged;
    say("ok", `${id} ${compiled.base.version} (${where}): ${compiled.base.description || "no description"}`);
    detail(`capabilities: ${capabilities.join(", ")}`);
    discardStaged(c.staged);
  }
  return candidates.every((c) => c.staged) ? 0 : 1;
}

function install(
  candidates: Candidate[],
  fetched: FetchedSource,
  paths: HomePaths,
  opts: { force: boolean; shadow: boolean },
): { added: string[]; ok: boolean } {
  const sources = readSources(paths.sources);
  const flags = readFlagsForUpdate(paths.flags);
  const added: string[] = [];
  let ok = true;
  for (const c of candidates) {
    if (!c.staged) {
      ok = false;
      say("fail", `${relative(fetched.root, c.dir) || "."}: ${c.problem}`, `hookmux validate <folder> after fixing it`);
      continue;
    }
    const { id, hash, capabilities, compiled } = c.staged;
    try {
      placeStaged(c.staged, paths, opts.force);
    } catch (error) {
      if (!(error instanceof PluginExistsError)) throw error;
      ok = false;
      say("fail", error.message, `hookmux add ${fetched.source} --force, or hookmux remove ${id}`);
      continue;
    }
    sources[id] = {
      source: fetched.source,
      ref: fetched.ref,
      commit: fetched.commit,
      hash,
      addedAt: new Date().toISOString(),
    };
    if (opts.shadow) flags.shadow.push(id);
    added.push(id);
    say("ok", `added ${id} ${compiled.base.version}${opts.shadow ? " (shadow)" : ""}`);
    detail(`capabilities: ${capabilities.join(", ")}`);
    for (const w of compiled.warnings) detail(`! ${w}`);
  }
  writeSources(paths.sources, sources);
  writeFlags(paths.flags, flags);
  return { added, ok };
}
