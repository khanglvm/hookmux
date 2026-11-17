// Evaluates every plugin that listens to an event and returns their outcomes.
// Checks run cheapest tier first; a plugin whose `when` is already decided never
// pays for its expensive checks. Every check and plugin is isolated: an error or
// timeout makes that signal unknown and never stops other plugins.

import { type CheckContext, getCheck, type RuntimeSettings } from "../checks/registry.ts";
import { compose } from "./compose.ts";
import { type Expr, evalExpr, exprRefs, parseExpr } from "./expr.ts";
import type { HookEvent, HubResult, PluginOutcome, PluginSpec, PluginTrace, Signal, Tri } from "./types.ts";

export interface EngineSettings {
  /** Wall-clock budget for all checks, in milliseconds. */
  deadlineMs: number;
  /** A block needs at least one non-model check that is true. */
  blockRequiresRule: boolean;
  /** Upper bound on injected characters, further capped by the host limit. */
  contextBudget: number;
  runtime: RuntimeSettings;
}

export interface EngineInput {
  event: HookEvent;
  plugins: PluginSpec[];
  settings: EngineSettings;
  /** Plugin ids that already fired in this session (for dedupe = "session"). */
  firedThisSession: ReadonlySet<string>;
}

interface Candidate {
  plugin: PluginSpec;
  when: Expr;
  degraded?: Expr;
  refs: string[];
  signals: Record<string, Signal>;
  started: number;
  decided: Tri;
  error?: string;
}

/** Plugins that should run for this event, before any check is evaluated. */
export function selectPlugins(event: HookEvent, plugins: PluginSpec[]): PluginSpec[] {
  return plugins.filter(
    (p) =>
      p.enabled &&
      p.events.includes(event.name) &&
      (p.hosts.length === 0 || p.hosts.includes(event.host.id)) &&
      p.origins.includes(event.origin),
  );
}

export async function runEngine(input: EngineInput): Promise<HubResult> {
  const { event, settings } = input;
  const deadlineAt = performance.now() + settings.deadlineMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.deadlineMs);
  timer.unref();

  const skipped: PluginTrace[] = [];
  const candidates: Candidate[] = [];
  for (const plugin of selectPlugins(event, input.plugins)) {
    if (plugin.dedupe === "session" && input.firedThisSession.has(plugin.id)) {
      skipped.push(trace(plugin, "skipped", {}, 0, "already fired this session"));
      continue;
    }
    const candidate = prepare(plugin);
    if (typeof candidate === "string") skipped.push(trace(plugin, "error", {}, 0, candidate));
    else candidates.push(candidate);
  }

  const ctxFor = (plugin: PluginSpec): CheckContext => ({
    event,
    plugin,
    signal: controller.signal,
    remainingMs: () => Math.max(0, deadlineAt - performance.now()),
    settings: settings.runtime,
  });

  try {
    for (const tier of [0, 1, 2] as const) {
      const jobs: Promise<void>[] = [];
      for (const c of candidates) {
        c.decided = evalExpr(c.when, c.signals);
        if (c.decided !== null) continue;
        for (const name of c.refs) {
          if (c.signals[name] !== undefined) continue;
          const spec = c.plugin.checks[name];
          const kind = spec ? getCheck(spec.kind) : undefined;
          if (!spec || !kind) {
            c.signals[name] = { value: null, error: `unknown check '${name}'` };
            continue;
          }
          if (kind.tier !== tier) continue;
          jobs.push(
            runCheck(() => kind.run(spec, ctxFor(c.plugin)), controller.signal).then((s) => {
              c.signals[name] = s;
            }),
          );
        }
      }
      await Promise.all(jobs);
    }
  } finally {
    clearTimeout(timer);
  }

  const traces: PluginTrace[] = [...skipped];
  const fired: PluginSpec[] = [];
  for (const c of candidates) {
    const outcome = decide(c);
    traces.push(trace(c.plugin, outcome, c.signals, performance.now() - c.started, c.error));
    if (outcome === "fire") fired.push(c.plugin);
  }
  return compose(event, fired, traces, settings);
}

function prepare(plugin: PluginSpec): Candidate | string {
  try {
    const when = parseExpr(plugin.when);
    const degraded = plugin.whenDegraded ? parseExpr(plugin.whenDegraded) : undefined;
    const refs = exprRefs(when);
    if (degraded) exprRefs(degraded, refs);
    return { plugin, when, degraded, refs: [...refs], signals: {}, started: performance.now(), decided: null };
  } catch (error) {
    return `invalid when: ${(error as Error).message}`;
  }
}

function decide(c: Candidate): PluginOutcome {
  const value = evalExpr(c.when, c.signals);
  if (value === true) return "fire";
  if (value === false) return "silent";
  if (c.degraded) {
    const fallback = evalExpr(c.degraded, c.signals);
    if (fallback === true) return "fire";
    if (fallback === false) return "silent";
  }
  // Guards may choose to fail closed; everything else fails open.
  return c.plugin.onError === "block" ? "fire" : "unknown";
}

/** Runs one check; any throw, rejection or deadline abort becomes an unknown signal. */
async function runCheck(run: () => Signal | Promise<Signal>, abort: AbortSignal): Promise<Signal> {
  const started = performance.now();
  try {
    if (abort.aborted) return { value: null, error: "deadline reached", ms: 0 };
    const pending = Promise.resolve().then(run);
    const aborted = new Promise<Signal>((done) => {
      abort.addEventListener("abort", () => done({ value: null, error: "deadline reached" }), { once: true });
    });
    const signal = await Promise.race([pending, aborted]);
    return { ...signal, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      value: null,
      error: (error as Error)?.message ?? String(error),
      ms: Math.round(performance.now() - started),
    };
  }
}

function trace(
  plugin: PluginSpec,
  outcome: PluginOutcome,
  signals: Record<string, Signal>,
  ms: number,
  note?: string,
): PluginTrace {
  return { id: plugin.id, outcome, shadow: plugin.shadow, signals, ms: Math.round(ms), ...(note ? { note } : {}) };
}
