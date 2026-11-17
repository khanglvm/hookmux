#!/usr/bin/env node
// hookmux command-line entry. Each command lives in its own module and is
// loaded only when run, so `hookmux --version` stays instant.

import { VERSION } from "./version.ts";

const COMMANDS: Record<string, () => Promise<{ run(argv: string[]): Promise<number> }>> = {};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    console.log(`hookmux ${VERSION}\n\nCommands: ${Object.keys(COMMANDS).sort().join(", ")}`);
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    console.log(VERSION);
    return 0;
  }
  const load = COMMANDS[name];
  if (!load) {
    console.error(`hookmux: unknown command '${name}'. Run 'hookmux help'.`);
    return 2;
  }
  return (await load()).run(rest);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`hookmux: ${(error as Error)?.message ?? String(error)}`);
    process.exitCode = 1;
  },
);
