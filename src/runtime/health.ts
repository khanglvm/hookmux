// A tiny always-on error record, written only when something fails, so
// `doctor` can say "plugin X failed 3 times, last at ..." even with logging off.
// Overlapping hook runs read, update and rename the file without a lock, so
// the last writer wins and a count can come out a little low. That is fine for
// a "how often, and when last" hint; nothing decides anything from it.

import { readJson, writeFileAtomic } from "./fsutil.ts";

const MAX_ENTRIES = 50;
const MAX_MESSAGE_CHARS = 300;

export interface HealthEntry {
  key: string;
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

export interface Health {
  entries: HealthEntry[];
}

export function readHealth(file: string): Health {
  const h = readJson<Health>(file, { entries: [] });
  return Array.isArray(h.entries) ? h : { entries: [] };
}

/** Records failures keyed by "<plugin>/<check>" or "hub". */
export function recordFailures(file: string, failures: { key: string; message: string }[], now = new Date()): void {
  if (failures.length === 0) return;
  const health = readHealth(file);
  const at = now.toISOString();
  for (const f of failures) {
    const message = f.message.slice(0, MAX_MESSAGE_CHARS);
    const existing = health.entries.find((e) => e.key === f.key);
    if (existing) {
      existing.count++;
      existing.lastAt = at;
      existing.message = message;
    } else health.entries.push({ key: f.key, message, count: 1, firstAt: at, lastAt: at });
  }
  health.entries.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  health.entries = health.entries.slice(0, MAX_ENTRIES);
  writeFileAtomic(file, `${JSON.stringify(health, null, 2)}\n`);
}

export function clearHealth(file: string): void {
  writeFileAtomic(file, `${JSON.stringify({ entries: [] })}\n`);
}
