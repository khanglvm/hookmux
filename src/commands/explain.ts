// `hookmux explain "<prompt>"`: run the active plugins on a sample event and
// show each decision plus the exact stdout the host would get. It writes no
// session state and no log. With --all, untrusted plugins run too, forced into
// shadow so they never change the stdout shown.

import { runEngine } from "../core/engine.ts";
import { CANONICAL_EVENTS, type CanonicalEvent, type PluginSpec, type PluginTrace } from "../core/types.ts";
import { activeSpecs, type Registry } from "../load/snapshot.ts";
import { homePaths } from "../runtime/paths.ts";
import { parseCommand, UsageError } from "./lib/args.ts";
import { bold, clip, detail, dim, printJson, say } from "./lib/output.ts";
import { type DisplayStatus, inspectInstalled, type PluginRow, specFor } from "./lib/plugins.ts";
import { adapterOrUsage, DEFAULT_HOST, engineSettings, formatSignals, outcomeStatus, sampleEvent } from "./lib/run.ts";

export const usage = `Usage: hookmux explain "<prompt>" [--host <id>] [--event <event>] [--all] [--json]

Shows what every active plugin decides for this prompt, and the exact stdout
the host would receive. Writes no state and no log.

  --host <id>      host to simulate (default ${DEFAULT_HOST})
  --event <event>  ${CANONICAL_EVENTS.join(", ")} (default prompt.submit)
  --all            also run untrusted plugins (labelled; their checks and scripts run)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(
    argv,
    { host: { type: "string" }, event: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
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
  const plugins = pluginsToRun(registry, rows, adapter.id, parsed.values.all === true);
  const event = sampleEvent(adapter, eventName, prompt);
  const result = await runEngine({ event, plugins, settings: engineSettings(registry), firedThisSession: new Set() });
  const stdout = adapter.render(result, event);
  const traces = result.trace.map((t) => ({ ...t, status: labels.get(t.id) ?? "active" }));

  if (parsed.values.json) {
    printJson({
      host: adapter.id,
      event: eventName,
      prompt,
      plugins: traces,
      context: result.context,
      notices: result.notices,
      block: result.block ?? null,
      errors: result.errors,
      stdout,
    });
    return 0;
  }
  console.log(bold(`${adapter.name} · ${eventName} · "${clip(prompt, 50)}"`));
  if (traces.length === 0) say("info", `no ${parsed.values.all ? "" : "active "}plugin listens to ${eventName} here`);
  for (const t of traces) printTrace(t);
  for (const e of result.errors) say("fail", e);
  console.log(dim(`stdout for ${adapter.name}:`));
  console.log(stdout === "" ? dim("(empty: no change to the prompt)") : stdout);
  return 0;
}

/** The hook's own active specs, plus untrusted ones forced into shadow when `all`. */
function pluginsToRun(registry: Registry, rows: PluginRow[], hostId: string, all: boolean): PluginSpec[] {
  const plugins = activeSpecs(registry, hostId);
  if (!all) return plugins;
  for (const row of rows) {
    const spec = row.status === "untrusted" ? specFor(row, hostId) : undefined;
    if (spec) plugins.push({ ...spec, shadow: true });
  }
  return plugins;
}

function printTrace(t: PluginTrace & { status: DisplayStatus }): void {
  const label = t.status === "active" ? t.id : `${t.id} [${t.status}]`;
  say(outcomeStatus(t.outcome), `${label} ${t.outcome} ${dim(`${t.ms} ms`)}`);
  if (Object.keys(t.signals).length > 0) detail(formatSignals(t.signals));
  if (t.note) detail(dim(`note: ${t.note}`));
}
