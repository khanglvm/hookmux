// The adapter contract. One module per agent client turns its payload into a
// HookEvent, renders a HubResult back in the client's format, and edits the
// client's hook config. Plugins and the engine never see host formats.

import type { CanonicalEvent, EffectKind, HookEvent, HubResult } from "../core/types.ts";

export interface HostAdapter {
  id: string;
  name: string;
  contractVersion: 1;
  /** The client's own event name per canonical event; null when it has none. */
  nativeEvents: Record<CanonicalEvent, string | null>;
  /** Effects the client can perform per canonical event. */
  supports: Record<CanonicalEvent, EffectKind[]>;
  contextChars: number;
  /**
   * Builds the event from stdin. Returns null when the payload is not usable,
   * in which case the hook produces the safe no-op output.
   */
  parse(event: CanonicalEvent, payload: unknown, env: NodeJS.ProcessEnv): HookEvent | null;
  /** The exact stdout for this result. An empty string is always a valid no-op. */
  render(result: HubResult, event: HookEvent): string;
  /** A minimal valid stdin payload for this event, used by `doctor` and tests. */
  sample(event: CanonicalEvent, prompt?: string): Record<string, unknown>;
  config: HostConfigEditor;
  /** Where the authoring skill goes; absent when the client has no skill folder. */
  skills?: { global: string };
}

export interface HubEntry {
  /** Absolute path of the launcher; hub entries are found by this command prefix. */
  launcher: string;
  events: CanonicalEvent[];
  /** Host-side timeout for the hub entry, in seconds. The adapter converts units. */
  timeoutSec: number;
}

export interface ConfigChange {
  file: string;
  changed: boolean;
  backup?: string;
  added: CanonicalEvent[];
  removed: CanonicalEvent[];
  notes: string[];
}

export interface HostConfigEditor {
  /** Config file the hub entries live in. */
  file(env?: NodeJS.ProcessEnv): string;
  /** True when the client looks installed on this machine. */
  detect(env?: NodeJS.ProcessEnv): boolean;
  /** Canonical events that already have a hub entry. */
  installed(launcher: string, env?: NodeJS.ProcessEnv): CanonicalEvent[];
  /** Adds missing hub entries, appending after existing ones. Leaves other entries untouched. */
  install(entry: HubEntry, env?: NodeJS.ProcessEnv): ConfigChange;
  /** Removes hub entries only. */
  uninstall(launcher: string, env?: NodeJS.ProcessEnv): ConfigChange;
}

/** The command string a host runs for one event. */
export function hubCommand(launcher: string, hostId: string, event: CanonicalEvent): string {
  const quoted = /^[A-Za-z0-9_./~-]+$/.test(launcher) ? launcher : `"${launcher.replaceAll('"', '\\"')}"`;
  return `${quoted} --host ${hostId} --event ${event}`;
}

/** True when a configured command is a hub entry for this launcher. */
export function isHubCommand(command: unknown, launcher: string): boolean {
  if (typeof command !== "string") return false;
  const trimmed = command.trim().replace(/^"/, "");
  return trimmed.startsWith(launcher) && trimmed.includes("--host ");
}
