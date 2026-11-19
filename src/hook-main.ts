// The hook run: read the host payload, evaluate plugins, print the host's
// output. It must never break the agent client. Every failure path, including a
// deadline overrun, prints nothing (a valid no-op on every host) and exits 0.
// Logging and state writes happen after stdout is written, so they cannot delay
// or change what the client receives.

import { writeSync } from "node:fs";
import { flushCompileCache } from "node:module";
import "./checks/index.ts";
import { runEngine, selectPlugins } from "./core/engine.ts";
import { offPluginsNotice } from "./core/off-plugins.ts";
import { CANONICAL_EVENTS, type CanonicalEvent, type HookEvent, type HubResult } from "./core/types.ts";
import { getAdapter } from "./hosts/index.ts";
import { activeSpecs, loadRegistry } from "./load/snapshot.ts";
import { recordFailures } from "./runtime/health.ts";
import { appendLog, buildLogLine, loggingActive, readLogSettings } from "./runtime/log.ts";
import { homePaths } from "./runtime/paths.ts";
import { killTrackedGroups } from "./runtime/process-group.ts";
import { readFired, recordFired } from "./runtime/state.ts";
import { readStdin } from "./runtime/stdin.ts";

/** Extra time past the engine deadline before the watchdog gives up and exits. */
const WATCHDOG_GRACE_MS = 1000;
const DEFAULT_DEADLINE_MS = 2000;
const MAX_STDIN_BYTES = 8 * 1024 * 1024;

let written = false;

/** Writes stdout once, synchronously, so process.exit cannot cut it short. */
function emit(text: string): void {
  if (written) return;
  written = true;
  let buffer = Buffer.from(text, "utf8");
  while (buffer.length > 0) {
    try {
      const n = writeSync(1, buffer);
      buffer = buffer.subarray(n);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
      return;
    }
  }
}

function parseArgs(argv: string[]): { host: string; event: string } {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
  };
  return { host: value("--host"), event: value("--event") };
}

async function run(): Promise<void> {
  const started = performance.now();
  const args = parseArgs(process.argv.slice(2));
  const watchdog = setTimeout(() => finish(), DEFAULT_DEADLINE_MS + WATCHDOG_GRACE_MS);
  const errors: string[] = [];
  const paths = homePaths();
  let hookEvent: HookEvent | undefined;
  let result: HubResult | undefined;
  let output = "";

  try {
    const adapter = getAdapter(args.host);
    if (!adapter || !CANONICAL_EVENTS.includes(args.event as CanonicalEvent) || process.env.HOOKMUX_DISABLE === "1") {
      return finish();
    }
    const event = args.event as CanonicalEvent;
    const input = await readStdin(MAX_STDIN_BYTES, DEFAULT_DEADLINE_MS);
    const registry = await loadRegistry(paths);
    const specs = activeSpecs(registry, adapter.id);
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      errors.push("stdin is not JSON");
      return;
    }
    hookEvent = adapter.parse(event, payload, process.env) ?? undefined;
    if (!hookEvent) return;
    const offNotice = event === "session.start" ? offPluginsNotice(registry) : null;
    if (selectPlugins(hookEvent, specs).length === 0 && offNotice === null) return;

    clearTimeout(watchdog);
    const deadline = registry.settings.deadlineMs;
    setTimeout(() => finish(), deadline + WATCHDOG_GRACE_MS).unref();
    result = await runEngine({
      event: hookEvent,
      plugins: specs,
      settings: {
        deadlineMs: deadline,
        blockRequiresRule: registry.settings.blockRequiresRule,
        contextBudget: registry.settings.contextBudget,
        runtime: { providers: registry.providers },
      },
      firedThisSession: readFired(paths.sessions, hookEvent.sessionId),
    });
    if (offNotice !== null && hookEvent.host.supports.includes("notify")) {
      result.notices.push({ pluginId: "hookmux", text: offNotice });
    }
    output = adapter.render(result, hookEvent);
  } catch (error) {
    errors.push((error as Error)?.message ?? String(error));
    output = "";
  } finally {
    emit(output);
    afterOutput(paths, args, performance.now() - started, hookEvent, result, output, errors);
  }
}

/** Best-effort bookkeeping once the client already has its answer. */
function afterOutput(
  paths: ReturnType<typeof homePaths>,
  args: { host: string; event: string },
  ms: number,
  hookEvent: HookEvent | undefined,
  result: HubResult | undefined,
  output: string,
  errors: string[],
): void {
  try {
    if (hookEvent && result) {
      const fired = result.trace
        .filter((t) => t.outcome === "fire" && !t.shadow && !(t.note ?? "").includes("dropped"))
        .map((t) => t.id);
      recordFired(paths.sessions, hookEvent.sessionId, fired);
    }
    const failures = errors.map((message) => ({ key: "hub", message }));
    for (const t of result?.trace ?? []) {
      if (t.outcome === "error") failures.push({ key: t.id, message: t.note ?? "error" });
      for (const [name, s] of Object.entries(t.signals)) {
        if (s.error) failures.push({ key: `${t.id}/${name}`, message: s.error });
      }
    }
    recordFailures(paths.health, failures);
    const settings = readLogSettings(paths.logSettings);
    if (loggingActive(settings)) {
      appendLog(
        paths.logFile,
        buildLogLine(
          { host: args.host, event: args.event, ms, hookEvent, result, outputBytes: Buffer.byteLength(output), errors },
          settings,
        ),
      );
    }
  } catch {
    // Bookkeeping never affects the client.
  }
}

function finish(): void {
  emit("");
  exit();
}

/** Exits 0 after saving the compile cache (process.exit would skip the automatic flush). */
function exit(): never {
  try {
    flushCompileCache?.();
  } catch {
    // Optimisation only.
  }
  process.exit(0);
}

/**
 * A host that gives up on the hook (its own timeout, or the user interrupting)
 * sends a signal. The process groups of the scripts the hook started die with
 * it, and the answer is the same empty no-op as every other failure.
 */
function onHostSignal(): void {
  try {
    killTrackedGroups();
  } finally {
    finish();
  }
}

for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, onHostSignal);

run()
  .catch(() => emit(""))
  .finally(() => exit());
