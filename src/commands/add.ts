// `hookmux add <source>`: copy plugins from a folder or git repository into the
// hub. New plugins stay untrusted; only `promote` activates them, and only
// after the person has seen the plugin's card and said yes.

import { existsSync } from "node:fs";
import { relative } from "node:path";
import { renderCardShort } from "../core/card.ts";
import { discoverPlugins } from "../install/discover.ts";
import { type FetchedSource, fetchSource } from "../install/fetch.ts";
import { readSources, writeSources } from "../install/records.ts";
import { parseSource, SourceError } from "../install/source.ts";
import { discardStaged, PluginExistsError, placeStaged, type StagedPlugin, stagePlugin } from "../install/stage.ts";
import { cardFactsOf } from "../load/card-facts.ts";
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

Copies plugins into the hookmux home and prints what each can do. They stay
untrusted until you approve them with hookmux promote, unless a standing
approval (hookmux promote <id> --standing) covers them.

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
  const paths = homePaths();
  const plugins = parsed.values.plugin ?? [];
  if (parsed.values.list) return listSource(paths, sourceText, plugins);
  const result = await addFromSource(paths, sourceText, {
    plugins,
    force: parsed.values.force === true,
    shadow: parsed.values.shadow === true,
  });
  if (!result) return 1;
  // Offer to promote where the person is at the keyboard; elsewhere promote prints a card for them to answer.
  const canAsk = isInteractive() && agentMarker(process.env) === undefined;
  for (const id of result.added.filter((a) => !result.standing.includes(a))) {
    if (canAsk) await promotePlugin(paths, id, { assumeYes: false });
    else say("info", `${id} stays off until the person approves it`, `hookmux promote ${id}`);
  }
  return result.ok ? 0 : 1;
}

export interface AddOptions {
  /** Only these plugin ids; empty means every plugin the source holds. */
  plugins: string[];
  shadow: boolean;
  force: boolean;
  /** Replace an installed plugin only when it came from this same source, so re-running an install line updates it. */
  updateSameSource?: boolean;
}

export interface AddResult {
  added: string[];
  /** Ids a standing approval of the person's own turned on, so they need no new answer. */
  standing: string[];
  ok: boolean;
}

function parseSourceText(sourceText: string): ReturnType<typeof parseSource> {
  try {
    return parseSource(sourceText, existsSync);
  } catch (error) {
    if (error instanceof SourceError) throw new UsageError(error.message);
    throw error;
  }
}

/** `add --list`: shows what a source holds and installs nothing. */
async function listSource(paths: HomePaths, sourceText: string, wanted: string[]): Promise<number> {
  const spec = parseSourceText(sourceText);
  const fetched = await fetchSource(spec);
  try {
    const candidates = stageAll(fetched, paths, wanted);
    return candidates === null ? 1 : listCandidates(candidates, fetched, paths);
  } finally {
    fetched.cleanup();
  }
}

/**
 * Copies a source's plugins into the hub, applies the person's earlier standing approvals and
 * registers the events they need. Never activates anything else. Returns null, after
 * reporting why, when nothing was added.
 * @throws UsageError for a malformed source.
 */
export async function addFromSource(paths: HomePaths, sourceText: string, opts: AddOptions): Promise<AddResult | null> {
  const spec = parseSourceText(sourceText);
  // Fail before fetching or staging anything when flags.json cannot be updated safely.
  readFlagsForUpdate(paths.flags);
  const fetched = await fetchSource(spec);
  let added: string[];
  let ok: boolean;
  try {
    const candidates = stageAll(fetched, paths, opts.plugins);
    if (candidates === null) return null;
    ({ added, ok } = install(candidates, fetched, paths, {
      force: opts.force,
      shadow: opts.shadow,
      updateSameSource: opts.updateSameSource === true,
    }));
  } finally {
    fetched.cleanup();
  }
  if (added.length === 0) return null;
  const standing = applyStandingApprovals(paths, added);
  if (!(await syncAfterChange(paths))) ok = false;
  return { added, standing, ok };
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

function listCandidates(candidates: Candidate[], fetched: FetchedSource, paths: HomePaths): number {
  const deadlineMs = readConfig(paths.config).settings.deadlineMs;
  for (const c of candidates) {
    const where = relative(fetched.root, c.dir) || ".";
    if (!c.staged) {
      say("fail", `${where}: ${c.problem}`, `hookmux validate ${c.dir}`);
      continue;
    }
    const { id, compiled, capabilities } = c.staged;
    say("ok", `${id} ${compiled.base.version} (${where}): ${compiled.base.description || "no description"}`);
    detail(shortCard(c.staged, capabilities, fetched, deadlineMs));
    discardStaged(c.staged);
  }
  return candidates.every((c) => c.staged) ? 0 : 1;
}

/** The short approval card for a staged plugin, as `promote` will show it for this source. */
function shortCard(staged: StagedPlugin, capabilities: string[], fetched: FetchedSource, deadlineMs: number): string {
  const { id, compiled } = staged;
  const source = { source: fetched.source, ref: fetched.ref, commit: fetched.commit };
  const facts = cardFactsOf({ id, base: compiled.base, variants: Object.values(compiled.variants), source });
  return renderCardShort(facts, capabilities, deadlineMs);
}

function install(
  candidates: Candidate[],
  fetched: FetchedSource,
  paths: HomePaths,
  opts: { force: boolean; shadow: boolean; updateSameSource: boolean },
): { added: string[]; ok: boolean } {
  const sources = readSources(paths.sources);
  const flags = readFlagsForUpdate(paths.flags);
  const deadlineMs = readConfig(paths.config).settings.deadlineMs;
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
      // A changed plugin gets a new hash, so the update still needs the person's approval.
      const sameSource = opts.updateSameSource && sources[id]?.source === fetched.source;
      placeStaged(c.staged, paths, opts.force || sameSource);
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
    detail(shortCard(c.staged, capabilities, fetched, deadlineMs));
    for (const w of compiled.warnings) detail(`! ${w}`);
  }
  writeSources(paths.sources, sources);
  writeFlags(paths.flags, flags);
  return { added, ok };
}
