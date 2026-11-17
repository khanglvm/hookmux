// Small file helpers shared by the hook and the CLI. Writes are atomic
// (temp file plus rename) and private (mode 0600), so a crash mid-write
// never leaves a half-written registry or state file behind.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, data, { mode });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Reads JSON, returning `fallback` when the file is missing or unreadable. */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
