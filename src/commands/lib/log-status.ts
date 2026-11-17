// Log state as one record and one line, shared by `log status` and `doctor`.

import { existsSync, statSync } from "node:fs";
import { loggingActive, readLogSettings } from "../../runtime/log.ts";
import type { HomePaths } from "../../runtime/paths.ts";
import { formatBytes } from "./output.ts";

export interface LogStatus {
  enabled: boolean;
  active: boolean;
  prompts: boolean;
  until: string | null;
  file: string;
  bytes: number;
}

export function readLogStatus(paths: HomePaths): LogStatus {
  const settings = readLogSettings(paths.logSettings);
  const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
  return {
    enabled: settings.enabled,
    active: loggingActive(settings),
    prompts: settings.prompts,
    until: settings.until ?? null,
    file: paths.logFile,
    bytes: size(paths.logFile) + size(`${paths.logFile}.1`),
  };
}

/** One-line description of the log state, shared with doctor. */
export function describeLogStatus(s: LogStatus): string {
  const state = s.active ? "on" : s.enabled ? "off (expired)" : "off";
  const expiry = s.active && s.until ? `, until ${s.until}` : "";
  return `log ${state}${expiry}${s.prompts && s.active ? ", with prompt text" : ""}, ${formatBytes(s.bytes)}`;
}
