// Opt-in decision log for tracing issues (`hookmux log on`). One JSON line per
// hook run: timings, each plugin's outcome and signals, output size and errors.
// Prompt text is never stored unless the user also turns on `--prompts`; by
// default only a short hash and the length are kept. The file rotates at 1 MiB
// with one previous file kept, so the log never grows past about 2 MiB.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { HookEvent, HubResult } from "../core/types.ts";
import { readJson, writeFileAtomic } from "./fsutil.ts";

export const LOG_ROTATE_BYTES = 1024 * 1024;
const PROMPT_TEXT_CHARS = 500;

export interface LogSettings {
  enabled: boolean;
  /** Also keep the first 500 characters of each prompt. */
  prompts: boolean;
  /** ISO time after which logging switches itself off; absent means no expiry. */
  until?: string;
}

export function readLogSettings(file: string): LogSettings {
  const s = readJson<Partial<LogSettings>>(file, {});
  return {
    enabled: s.enabled === true,
    prompts: s.prompts === true,
    ...(typeof s.until === "string" ? { until: s.until } : {}),
  };
}

export function writeLogSettings(file: string, settings: LogSettings): void {
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function loggingActive(settings: LogSettings, now = Date.now()): boolean {
  if (!settings.enabled) return false;
  return settings.until === undefined || Date.parse(settings.until) > now;
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export interface RunRecord {
  host: string;
  event: string;
  ms: number;
  hookEvent?: HookEvent;
  result?: HubResult;
  outputBytes: number;
  errors: string[];
}

export function buildLogLine(run: RunRecord, settings: LogSettings, now = new Date()): string {
  const e = run.hookEvent;
  const record: Record<string, unknown> = {
    ts: now.toISOString(),
    host: run.host,
    event: run.event,
    ms: Math.round(run.ms),
  };
  if (e) {
    record.origin = e.origin;
    if (e.sessionId) record.session = shortHash(e.sessionId);
    if (e.prompt !== undefined) {
      record.prompt = { hash: shortHash(e.prompt), chars: e.prompt.length };
      if (settings.prompts) (record.prompt as Record<string, unknown>).text = e.prompt.slice(0, PROMPT_TEXT_CHARS);
    }
    if (e.tool) record.tool = e.tool.canonicalName;
  }
  if (run.result) {
    record.plugins = run.result.trace.map((t) => ({
      id: t.id,
      outcome: t.outcome,
      ms: t.ms,
      ...(t.shadow ? { shadow: true } : {}),
      ...(t.note ? { note: t.note } : {}),
      signals: Object.fromEntries(
        Object.entries(t.signals).map(([name, s]) => [name, s.error ? `error: ${s.error}` : s.value]),
      ),
    }));
    record.out = {
      bytes: run.outputBytes,
      context: run.result.context.map((c) => c.pluginId),
      ...(run.result.block ? { block: run.result.block.pluginId } : {}),
      ...(run.result.notices.length > 0 ? { notices: run.result.notices.length } : {}),
    };
  }
  if (run.errors.length > 0) record.errors = run.errors;
  return `${JSON.stringify(record)}\n`;
}

export function appendLog(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    if (statSync(file).size + line.length > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No log yet.
  }
  appendFileSync(file, line, { mode: 0o600 });
}
