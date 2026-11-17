// Builders for calling a check kind's run() directly, without the engine.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckContext, ProviderSettings } from "../../src/checks/registry.ts";
import type { CheckSpec, HookEvent, PluginSpec } from "../../src/core/types.ts";

/** Points HOOKMUX_HOME at a fresh temp folder so no test touches the real ~/.hookmux. */
export function useTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "hookmux-home-"));
  process.env.HOOKMUX_HOME = home;
  return home;
}

export function promptEvent(prompt: string, cwd = tmpdir()): HookEvent {
  return {
    name: "prompt.submit",
    host: {
      id: "claude-code",
      name: "Claude Code",
      version: null,
      adapterContract: 1,
      nativeEvent: "UserPromptSubmit",
      canonicalEvent: "prompt.submit",
      supports: ["inject", "block"],
      limits: { contextChars: 10_000 },
    },
    sessionId: "s1",
    cwd,
    origin: "user",
    prompt,
    raw: { hook_event_name: "UserPromptSubmit", prompt },
  };
}

export function pluginSpec(
  dir: string,
  checks: Record<string, CheckSpec>,
  fileHashes?: Record<string, string>,
): PluginSpec {
  return {
    id: "test-plugin",
    version: "1.0.0",
    description: "test",
    dir,
    events: ["prompt.submit"],
    hosts: [],
    phase: "enrich",
    priority: 0,
    enabled: true,
    shadow: false,
    origins: ["user"],
    checks,
    when: Object.keys(checks)[0] ?? "true",
    effects: [],
    dedupe: "none",
    params: { greeting: "hi" },
    ...(fileHashes ? { fileHashes } : {}),
  };
}

export interface ContextOptions {
  event?: HookEvent;
  signal?: AbortSignal;
  remainingMs?: number;
  providers?: Record<string, ProviderSettings>;
}

export function checkContext(plugin: PluginSpec, options: ContextOptions = {}): CheckContext {
  return {
    event: options.event ?? promptEvent("hello"),
    plugin,
    signal: options.signal ?? new AbortController().signal,
    remainingMs: () => options.remainingMs ?? 5000,
    settings: { providers: options.providers ?? {} },
  };
}
