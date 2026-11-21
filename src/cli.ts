#!/usr/bin/env node
// hookmux command-line entry. Each command lives in its own module and is
// loaded only when run, so `hookmux --version` stays instant. Exit codes:
// 0 ok, 1 problems found, 2 usage error. Stack traces only with HOOKMUX_DEBUG=1.

import { resolve } from "node:path";
import { UsageError } from "./commands/lib/args.ts";
import { VERSION } from "./version.ts";

interface Command {
  run(argv: string[]): Promise<number>;
}

const COMMANDS: Record<string, { summary: string; load: () => Promise<Command> }> = {
  init: { summary: "install the engine and wire hosts (re-run to update)", load: () => import("./commands/init.ts") },
  uninstall: {
    summary: "remove hub entries from hosts (--purge: also the home folder)",
    load: () => import("./commands/uninstall.ts"),
  },
  sync: {
    summary: "register the events installed plugins need on wired hosts",
    load: () => import("./commands/sync.ts"),
  },
  add: {
    summary: "install plugins from a folder or git repo (untrusted until promoted)",
    load: () => import("./commands/add.ts"),
  },
  promote: {
    summary: "review and activate a plugin (your own terminal only)",
    load: () => import("./commands/promote.ts"),
  },
  remove: { summary: "delete an installed plugin", load: () => import("./commands/remove.ts") },
  enable: { summary: "turn a disabled plugin back on", load: () => import("./commands/enable.ts") },
  disable: { summary: "turn a plugin off without removing it", load: () => import("./commands/disable.ts") },
  list: { summary: "show installed plugins and their status", load: () => import("./commands/list.ts") },
  new: { summary: "scaffold a plugin.toml and tests.toml", load: () => import("./commands/new.ts") },
  validate: { summary: "check a plugin folder for problems", load: () => import("./commands/validate.ts") },
  test: { summary: "run a plugin's tests.toml cases", load: () => import("./commands/test.ts") },
  explain: {
    summary: "show what each plugin decides for a prompt, and the host output",
    load: () => import("./commands/explain.ts"),
  },
  doctor: {
    summary: "check the install end to end (--fix repairs what it can)",
    load: () => import("./commands/doctor.ts"),
  },
  log: { summary: "turn the decision log on or off, and read it", load: () => import("./commands/log.ts") },
  schema: {
    summary: "print manifest keys, check kinds, effects, events and host support",
    load: () => import("./commands/schema.ts"),
  },
};

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`);
  return [
    `hookmux ${VERSION}: one hook entry for every coding agent`,
    "",
    "Usage: hookmux [--home <dir>] <command> [options]",
    "",
    "Commands:",
    ...rows,
    "",
    "Global options:",
    "  --home <dir>  hookmux home folder (default $HOOKMUX_HOME or ~/.hookmux)",
    "  --version     print the version",
    "",
    "Run 'hookmux <command> --help' for a command's options.",
  ].join("\n");
}

/** Removes `--home <dir>` / `--home=<dir>` from argv and applies it to HOOKMUX_HOME. */
function takeHome(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      out.push(...argv.slice(i));
      break;
    }
    let dir: string | undefined;
    if (arg === "--home") {
      dir = argv[++i];
      if (dir === undefined || dir === "") throw new UsageError("--home needs a folder");
    } else if (arg.startsWith("--home=")) dir = arg.slice("--home=".length);
    else {
      out.push(arg);
      continue;
    }
    process.env.HOOKMUX_HOME = resolve(dir);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  let name: string | undefined;
  try {
    const [first, ...rest] = takeHome(argv);
    name = first;
    if (name === undefined || name === "help" || name === "--help" || name === "-h") {
      console.log(helpText());
      return 0;
    }
    if (name === "--version" || name === "-v" || name === "version") {
      console.log(VERSION);
      return 0;
    }
    const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!command) throw new UsageError(`unknown command '${name}'`);
    return await (await command.load()).run(rest);
  } catch (error) {
    if (process.env.HOOKMUX_DEBUG === "1") console.error((error as Error)?.stack ?? error);
    if (error instanceof UsageError) {
      const help = name && Object.hasOwn(COMMANDS, name) ? `hookmux ${name} --help` : "hookmux help";
      console.error(`hookmux: ${error.message}\nRun '${help}'.`);
      return 2;
    }
    console.error(`✗ hookmux: ${(error as Error)?.message ?? String(error)}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
