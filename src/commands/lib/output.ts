// Human and machine output for commands. Human lines start with a status mark
// (✓ ok, ! warning, ✗ problem, · info) and a problem carries the next command to
// run. Colour is used only on a terminal and never when NO_COLOR is set.

export type Status = "ok" | "warn" | "fail" | "info";

const MARKS: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };
/** ANSI SGR codes: green, yellow, red, dim. */
const COLOURS: Record<Status, number> = { ok: 32, warn: 33, fail: 31, info: 2 };

function colourOn(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

function paint(code: number, text: string): string {
  return colourOn() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export function dim(text: string): string {
  return paint(2, text);
}

export function bold(text: string): string {
  return paint(1, text);
}

export function mark(status: Status): string {
  return paint(COLOURS[status], MARKS[status]);
}

/** Prints one status line, plus the command to run next when there is one. */
export function say(status: Status, text: string, next?: string): void {
  console.log(`${mark(status)} ${text}`);
  if (next) console.log(`  ${dim("→")} ${next}`);
}

/** Prints an indented detail line under the previous status line. */
export function detail(text: string): void {
  console.log(`  ${text}`);
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Shortens text to `max` characters for one-line display. */
export function clip(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Bytes as a short human size: 512 B, 3.2 KiB, 1.0 MiB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
