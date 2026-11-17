// Strict argument parsing for every command, on top of node:util parseArgs.
// Unknown flags and stray arguments become a UsageError (exit 2), and `--help`
// prints the command's usage instead of running it.

import { type ParseArgsConfig, parseArgs } from "node:util";

/** A mistake in how the command was called. The CLI exits 2 and points at `--help`. */
export class UsageError extends Error {}

type Options = NonNullable<ParseArgsConfig["options"]>;

const HELP = { help: { type: "boolean", short: "h" } } as const;

/**
 * Parses `argv` against `options`. Returns null after printing `usage` when
 * `--help` was given. Accepts at most `maxPositionals` positional arguments.
 * @throws UsageError on unknown flags, missing values or too many arguments.
 */
export function parseCommand<const O extends Options>(argv: string[], options: O, usage: string, maxPositionals = 0) {
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; options: O & typeof HELP; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: { ...options, ...HELP }, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  // `help` is added here, so the generic option type cannot see it.
  if ((parsed.values as { help?: boolean }).help === true) {
    console.log(usage);
    return null;
  }
  const extra = parsed.positionals[maxPositionals];
  if (extra !== undefined) throw new UsageError(`unexpected argument '${extra}'`);
  return parsed;
}

/** Parses a positive whole number flag value, such as `--timeout 10`. */
export function positiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive whole number`);
  return n;
}
