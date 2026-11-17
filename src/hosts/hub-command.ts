// The shell command a host runs for a hub entry, and how hookmux recognises
// its own entries again. Hosts pass the command to a POSIX shell, so the
// launcher path is single-quoted whenever it holds anything but plain path
// characters, and recognition parses the first shell word instead of matching
// a prefix, so `<launcher>-old` or a path inside another command never counts.

import type { CanonicalEvent } from "../core/types.ts";

/** Characters a launcher path may contain and still be written unquoted. */
const PLAIN_PATH = /^[A-Za-z0-9_./-]+$/;

/** POSIX single-quoting: everything is literal inside '…', and ' itself is written '\''. */
export function shellQuote(value: string): string {
  return PLAIN_PATH.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command string a host runs for one event. */
export function hubCommand(launcher: string, hostId: string, event: CanonicalEvent): string {
  return `${shellQuote(launcher)} --host ${hostId} --event ${event}`;
}

/**
 * Splits off the first shell word. Understands the forms hookmux has written:
 * bare, single-quoted (with '\'' for a quote) and the legacy double-quoted form
 * (with \" for a quote). Returns null for anything it cannot read.
 */
export function firstShellWord(command: string): { word: string; rest: string } | null {
  let i = 0;
  let word = "";
  while (i < command.length && !/\s/.test(command[i] as string)) {
    const ch = command[i] as string;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      const closed = readDoubleQuoted(command, i + 1);
      if (!closed) return null;
      word += closed.text;
      i = closed.end + 1;
    } else if (ch === "\\") {
      if (i + 1 >= command.length) return null;
      word += command[i + 1];
      i += 2;
    } else {
      word += ch;
      i++;
    }
  }
  return word === "" ? null : { word, rest: command.slice(i) };
}

/** Reads a double-quoted run starting after the opening quote; only \" and \\ are unescaped. */
function readDoubleQuoted(command: string, start: number): { text: string; end: number } | null {
  let text = "";
  for (let i = start; i < command.length; i++) {
    const ch = command[i] as string;
    if (ch === '"') return { text, end: i };
    if (ch === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
      text += command[i + 1];
      i++;
    } else text += ch;
  }
  return null;
}

/** The arguments every hub entry carries right after the launcher. */
const HUB_ARGS = /^\s+--host\s+\S+\s+--event\s+\S+/;

/** True when a configured command runs exactly this launcher with --host and --event. */
export function isHubCommand(command: unknown, launcher: string): boolean {
  if (typeof command !== "string") return false;
  const parsed = firstShellWord(command.trim());
  return parsed !== null && parsed.word === launcher && HUB_ARGS.test(parsed.rest);
}
