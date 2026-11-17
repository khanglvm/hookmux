// `hookmux explain "<prompt>"`: run the active plugins on a sample event and
// show each decision plus the exact stdout the host would get. It writes no
// session state and no log. With --all, untrusted plugins run too, forced into
// shadow so they never change the stdout shown, and their scripts stay unrun
// unless --run-scripts.

import { runEngine } from "../core/engine.ts";
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  type HubResult,
  type PluginSpec,
  type PluginTrace,
} from "../core/types.ts";
import type { HostAdapter } from "../hosts/types.ts";
import { activeSpecs, type Registry } from "../load/snapshot.ts";
import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { bold, clip, detail, dim, printJson, say } from "./lib/output.ts";
import { type DisplayStatus, inspectInstalled, type PluginRow, specFor } from "./lib/plugins.ts";
import {
  adapterOrUsage,
  DEFAULT_HOST,
  engineSettings,
  formatSignals,
  outcomeStatus,
  sampleEvent,
  withoutScripts,
} from "./lib/run.ts";

export const usage = `Usage: hookmux explain "<prompt>" [--host <id>] [--event <event>] [--all] [--json]

Shows what every active plugin decides for this prompt, and the exact stdout
the host would receive. Writes no state and no log.

  --host <id>      host to simulate (default ${DEFAULT_HOST})
  --event <event>  ${CANONICAL_EVENTS.join(", ")} (default prompt.submit)
  --all            also run untrusted plugins (labelled, never in the stdout)
  --run-scripts    with --all, also run untrusted plugins' scripts (default: unknown)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    argv,
    {
      host: { type: "string" },
      event: { type: "string" },
      all: { type: "boolean" },
      "run-scripts": { type: "boolean" },
      json: { type: "boolean" },
    },
    usage,
    1,
  );
  if (!parsed) return 0;
  const prompt = parsed.positionals[0];
  if (prompt === undefined)
    throw new UsageError('give the prompt to explain, e.g. hookmux explain "redesign the page"');
  const adapter = adapterOrUsage(parsed.values.host ?? DEFAULT_HOST);
  const eventName = (parsed.values.event ?? "prompt.submit") as CanonicalEvent;
  if (!CANONICAL_EVENTS.includes(eventName)) throw new UsageError(`unknown event '${eventName}'`);

  const { registry, rows } = inspectInstalled(homePaths());
  const labels = new Map<string, DisplayStatus>(rows.map((r) => [r.id, r.status]));
  const plugins = pluginsToRun(registry, rows, adapter.id, {
    all: parsed.values.all === true,
    runScripts: parsed.values["run-scripts"] === true,
  });
  const event = sampleEvent(adapter, eventName, prompt);
  const result = await runEngine({ event, plugins, settings: engineSettings(registry), firedThisSession: new Set() });
  const stdout = adapter.render(result, event);
  const traces = result.trace.map((t) => ({ ...t, status: labels.get(t.id) ?? "active" }));

  printExplain(
    { adapter, eventName, prompt, traces, result, stdout },
    {
      all: parsed.values.all === true,
      json: parsed.values.json === true,
    },
  );
  return 0;
}

/**
 * The hook's own active specs, plus untrusted ones forced into shadow when `all`.
 * Shadow previews in the registry never carry scripts, so only the `all` rows need the stub.
 */
function pluginsToRun(
  registry: Registry,
  rows: PluginRow[],
  hostId: string,
  opts: { all: boolean; runScripts: boolean },
): PluginSpec[] {
  const plugins = activeSpecs(registry, hostId);
  if (!opts.all) return plugins;
  for (const row of rows) {
    const spec = row.status === "untrusted" ? specFor(row, hostId) : undefined;
    if (!spec) continue;
    const preview = { ...spec, shadow: true };
    plugins.push(opts.runScripts ? preview : withoutScripts(preview));
  }
  return plugins;
}

type ExplainTrace = PluginTrace & { status: DisplayStatus };

interface Explained {
  adapter: HostAdapter;
  eventName: CanonicalEvent;
  prompt: string;
  traces: ExplainTrace[];
  result: HubResult;
  stdout: string;
}

function printExplain(e: Explained, opts: { all: boolean; json: boolean }): void {
  const { adapter, eventName, result } = e;
  if (opts.json) {
    printJson({
      host: adapter.id,
      event: eventName,
      prompt: e.prompt,
      plugins: e.traces,
      context: result.context,
      notices: result.notices,
      block: result.block ?? null,
      errors: result.errors,
      stdout: e.stdout,
    });
    return;
  }
  console.log(bold(`${adapter.name} · ${eventName} · "${clip(e.prompt, 50)}"`));
  if (e.traces.length === 0) say("info", `no ${opts.all ? "" : "active "}plugin listens to ${eventName} here`);
  for (const t of e.traces) printTrace(t);
  for (const err of result.errors) say("fail", err);
  console.log(dim(`stdout for ${adapter.name}:`));
  console.log(e.stdout === "" ? dim("(empty: no change to the prompt)") : e.stdout);
}

function printTrace(t: ExplainTrace): void {
  const label = t.status === "active" ? t.id : `${t.id} [${t.status}]`;
  say(outcomeStatus(t.outcome), `${label} ${t.outcome} ${dim(`${t.ms} ms`)}`);
  if (Object.keys(t.signals).length > 0) detail(formatSignals(t.signals));
  if (t.note) detail(dim(`note: ${t.note}`));
}
