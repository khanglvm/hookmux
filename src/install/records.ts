// Hub-owned JSON records the CLI keeps beside the plugins: sources.json (where
// each plugin came from) and install.json (choices `init` made that `sync` reuses).

import { readJson, writeFileAtomic } from "../runtime/fsutil.ts";

/** sources.json `source` value for plugins copied from this package by `init`. */
export const BUNDLED_SOURCE = "bundled";
/** Host-side timeout for hub entries when `init --timeout` was not given, in seconds. */
export const DEFAULT_TIMEOUT_SEC = 10;

export interface SourceRecord {
  /** Absolute folder, git URL, or "bundled". */
  source: string;
  ref: string | null;
  commit: string | null;
  /** Content hash at add time, as trust.json records it. */
  hash: string;
  addedAt: string;
}

export type SourceStore = Record<string, SourceRecord>;

export function readSources(file: string): SourceStore {
  const raw = readJson<unknown>(file, {});
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as SourceStore) : {};
}

export function writeSources(file: string, store: SourceStore): void {
  writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`);
}

export interface InstallState {
  timeoutSec: number;
}

export function readInstallState(file: string): InstallState {
  const raw = readJson<Partial<InstallState>>(file, {});
  const timeoutSec = typeof raw.timeoutSec === "number" && raw.timeoutSec > 0 ? raw.timeoutSec : DEFAULT_TIMEOUT_SEC;
  return { timeoutSec };
}

export function writeInstallState(file: string, state: InstallState): void {
  writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}
