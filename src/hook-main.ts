// The hook run: read the host payload, evaluate plugins, print the host's
// output. It must never break the agent client. Every failure path, including a
// deadline overrun, prints nothing (a valid no-op on every host) and exits 0.
// Logging and state writes happen after stdout is written, so they cannot delay
// or change what the client receives.

import { writeSync } from "node:fs";
import { flushCompileCache } from "node:module";
import "./checks/index.ts";
import { renderCardShort } from "./core/card.ts";
import { runEngine, selectPlugins } from "./core/engine.ts";
import { offPluginsNotice } from "./core/off-plugins.ts";
import { grantedCommand, type PromoteRequest, parsePromoteCommand } from "./core/promote-command.ts";
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  emptyResult,
  type HookEvent,
  type HubResult,
  type PluginSpec,
} from "./core/types.ts";
import { getAdapter } from "./hosts/index.ts";
import type { HostAdapter } from "./hosts/types.ts";
import { activeSpecs, loadRegistry, type Registry, type RegistryPlugin } from "./load/snapshot.ts";
import { approveFromPrompt, type RelayCard } from "./runtime/cards.ts";
import { newGrantToken, saveGrant } from "./runtime/grants.ts";
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

/** A promote command the hub answers by asking the person, and the grant that approval will carry. */
interface PromoteConfirmation {
  request: PromoteRequest;
  hash: string;
  capabilities: string[];
  /** The client whose prompt the person will answer; recorded with the approval. */
  host: string;
  token: string;
  output: string;
}

/**
 * When the tool call is exactly `hookmux promote <id> [--standing]` for an installed
 * plugin, on a client that can ask the person: the output that asks, with the grant
 * added to the command. Null for everything else, which then runs untouched.
 */
function promoteConfirmation(adapter: HostAdapter, registry: Registry, event: HookEvent): PromoteConfirmation | null {
  if (event.name !== "tool.before" || !adapter.confirm || event.tool?.canonicalName !== "Bash") return null;
  const input = event.tool.input;
  if (typeof input !== "object" || input === null) return null;
  const request = parsePromoteCommand((input as Record<string, unknown>).command);
  if (!request) return null;
  const plugin = registry.plugins.find((p) => p.id === request.id);
  if (!plugin || plugin.status === "invalid" || plugin.hash === undefined) return null;
  const token = newGrantToken();
  const card = plugin.card
    ? renderCardShort(plugin.card, plugin.capabilities, registry.settings.deadlineMs)
    : `hookmux: approve to turn on ${request.id}.`;
  const reason = [
    card,
    `Now: ${currentState(plugin)}.`,
    request.standing
      ? "Standing approval: later versions installed with hookmux add go live without asking while they need no more than this."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const output = adapter.confirm(event, {
    reason,
    // Security: the description sits beside the command on the person's card, so the agent's wording is not kept.
    input: {
      ...(input as Record<string, unknown>),
      command: grantedCommand(request, token),
      description: `hookmux: activate plugin ${request.id}`,
    },
  });
  return { request, hash: plugin.hash, capabilities: plugin.capabilities, host: adapter.id, token, output };
}

/**
 * Approvals of relayed cards (src/commands/lib/relay.ts): a prompt the client marked as the
 * user's that carries a card's code. One stat when no card exists. Fails open: a card that
 * cannot be read stays unapproved and the agent is told nothing.
 */
function relayApprovals(paths: ReturnType<typeof homePaths>, event: HookEvent): RelayCard[] {
  if (event.name !== "prompt.submit" || event.origin !== "user" || typeof event.prompt !== "string") return [];
  // Claude Code wraps a background task's output, which the agent controls, in this tag. Origin only
  // checks the start of the prompt, so a prompt carrying the tag anywhere approves nothing.
  if (event.prompt.includes("<task-notification>")) return [];
  try {
    return approveFromPrompt(paths.cards, event.submittedPrompt ?? event.prompt, event.host.id);
  } catch {
    return [];
  }
}

/**
 * Tells the person, from hookmux itself, what they just approved (the agent may have worded the card
 * differently), and tells the agent the one command that finishes it.
 */
function addApprovalMessages(result: HubResult, event: HookEvent, approvals: RelayCard[]): void {
  for (const card of approvals) {
    if (event.host.supports.includes("notify")) {
      const text = `hookmux: you approved ${card.summary} Undo: hookmux disable ${card.id}`;
      result.notices.push({ pluginId: "hookmux", text });
    }
    const prefix = card.command === "npx -y hookmux" ? card.command : "hookmux";
    const run = `${prefix} promote ${card.id} --confirm ${card.code}`;
    result.context.push({
      pluginId: "hookmux",
      text: `hookmux: the user approved ${card.id} with code ${card.code}. Run exactly: ${run}`,
    });
  }
}

/** What the plugin is before approval; approving pins it and clears its shadow flag. */
function currentState(plugin: RegistryPlugin): string {
  if (plugin.status !== "active" || !plugin.trusted) return plugin.problem ?? "not promoted yet";
  if (plugin.base && !plugin.base.enabled) return "turned off; approving does not turn it on";
  if (plugin.base?.shadow) return "in shadow mode; approving makes it live";
  return "active now";
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
  let granted: PromoteConfirmation | undefined;

  try {
    const adapter = getAdapter(args.host);
    if (!adapter || !CANONICAL_EVENTS.includes(args.event as CanonicalEvent)) return finish();
    const event = args.event as CanonicalEvent;
    const input = await readStdin(MAX_STDIN_BYTES, DEFAULT_DEADLINE_MS);
    const registry = await loadRegistry(paths);
    // Security: a session can set its hooks' environment through project settings, so HOOKMUX_DISABLE=1
    // switches off every plugin except guards; it must not be a way for an agent to lift a guard.
    const specs = activeSpecs(registry, adapter.id, process.env.HOOKMUX_DISABLE === "1");
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
    const confirmation = promoteConfirmation(adapter, registry, hookEvent);
    // Before the early return below, so an approval is seen even when no plugin listens to prompts.
    const approvals = relayApprovals(paths, hookEvent);
    const hasPlugins = selectPlugins(hookEvent, specs).length > 0 || offNotice !== null;
    if (!hasPlugins && approvals.length === 0) {
      if (confirmation) {
        granted = confirmation;
        output = confirmation.output;
      }
      return;
    }

    clearTimeout(watchdog);
    const deadline = registry.settings.deadlineMs;
    setTimeout(() => finish(), deadline + WATCHDOG_GRACE_MS).unref();
    result = hasPlugins ? await evaluate(registry, specs, hookEvent, paths) : emptyResult();
    if (offNotice !== null && hookEvent.host.supports.includes("notify")) {
      result.notices.push({ pluginId: "hookmux", text: offNotice });
    }
    addApprovalMessages(result, hookEvent, approvals);
    // A guard plugin's block on the command wins over the question.
    if (confirmation && !result.block) {
      granted = confirmation;
      output = confirmation.output;
    } else output = adapter.render(result, hookEvent);
  } catch (error) {
    errors.push((error as Error)?.message ?? String(error));
    output = "";
  } finally {
    emit(output);
    if (granted && output === granted.output) storeGrant(paths.grants, granted);
    afterOutput(paths, args, performance.now() - started, hookEvent, result, output, errors);
  }
}

/** Runs the active plugins for this event under the hub deadline. */
function evaluate(
  registry: Registry,
  specs: PluginSpec[],
  event: HookEvent,
  paths: ReturnType<typeof homePaths>,
): Promise<HubResult> {
  return runEngine({
    event,
    plugins: specs,
    settings: {
      deadlineMs: registry.settings.deadlineMs,
      blockRequiresRule: registry.settings.blockRequiresRule,
      contextBudget: registry.settings.contextBudget,
      runtime: { providers: registry.providers },
    },
    firedThisSession: readFired(paths.sessions, event.sessionId),
  });
}

/** The person answers the card long after this process exits, so the grant is on disk before then. */
function storeGrant(dir: string, granted: PromoteConfirmation): void {
  try {
    saveGrant(dir, granted.token, {
      id: granted.request.id,
      hash: granted.hash,
      capabilities: granted.capabilities,
      standing: granted.request.standing,
      host: granted.host,
    });
  } catch {
    // Without the grant the approved command is refused and says how to ask again.
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
