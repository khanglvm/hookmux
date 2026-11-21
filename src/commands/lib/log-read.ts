// Reads the decision log's JSON lines (written by src/runtime/log.ts), shared
// by `log show` and the slowest-plugin line in `doctor`.

import { existsSync, readFileSync } from "node:fs";
import type { HomePaths } from "../../runtime/paths.ts";

export type LogRecord = Record<string, unknown> & {
  ts?: string;
  plugins?: { id: string; outcome: string; ms?: number; signals?: Record<string, unknown> }[];
  errors?: string[];
};

/** Every readable record, oldest first: the rotated file, then the current one. */
export function readRecords(paths: HomePaths): LogRecord[] {
  const out: LogRecord[] = [];
  for (const file of [`${paths.logFile}.1`, paths.logFile]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as LogRecord);
      } catch {
        // A line cut off by a crash or rotation; skip it.
      }
    }
  }
  return out;
}
