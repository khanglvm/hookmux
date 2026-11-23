# Command reference

Every hookmux command, its flags and its exit codes. `hookmux help` lists the commands in your installed version, and `hookmux <command> --help` prints that command's usage.

## Usage

```sh
hookmux [--home <dir>] <command> [options]
```

| Option                       | Meaning                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--home <dir>`               | The hookmux home folder. Default is `$HOOKMUX_HOME`, or `~/.hookmux` when that is not set. Also accepted as `--home=<dir>` |
| `--version`, `-v`, `version` | Print the version                                                                                                          |
| `help`, `--help`, `-h`       | Print the command list. After a command name, print that command's usage                                                   |

Exit codes: `0` for success, `1` when the command found problems, and `2` for a usage error such as an unknown flag. Set `HOOKMUX_DEBUG=1` to print a stack trace with an error.

If you run hookmux from a source checkout, run each command as `node /path/to/hookmux/dist/cli.mjs <command>`. See [Install](install.md).

## Set up and remove

| Command             | What it does                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hookmux init`      | Installs the engine into the home folder and adds one hub entry per event to each chosen agent. Run it again to update                              |
| `hookmux uninstall` | Removes hookmux's hub entries from agent configs. Other hooks stay as they are                                                                      |
| `hookmux sync`      | Registers the events your installed plugins need on each agent that already has hub entries. `add`, `remove`, `enable` and `promote` run it for you |
| `hookmux doctor`    | Checks Node, the engine, the launcher, every wired agent (including a real launcher run), plugins, recorded failures, the log and session state     |

### init

```sh
hookmux init [--host <id>]... [--yes] [--no-skill] [--no-bundled] [--timeout <sec>]
```

| Flag              | Meaning                                                  |
| ----------------- | -------------------------------------------------------- |
| `--host <id>`     | Wire this agent. Repeatable                              |
| `--yes`, `-y`     | Wire every detected agent without asking                 |
| `--no-skill`      | Do not copy the authoring skill into agent skill folders |
| `--no-bundled`    | Do not install the plugins bundled with hookmux          |
| `--timeout <sec>` | Agent-side timeout for new hub entries. Default 10       |

The agent ids are `claude-code`, `codex`, `gemini-cli`, `qwen-code`, `droid`, `qoder`, `codebuddy` and `opencode`. Without a terminal, pass `--host` or `--yes`; a re-run then updates the agents already wired. `init` exits 1 when it wires no agent.

### uninstall

```sh
hookmux uninstall [--host <id>]... [--purge] [--yes]
```

| Flag          | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `--host <id>` | Only this agent. Repeatable. Default is every agent with hub entries |
| `--purge`     | Also delete the hookmux home folder (plugins, trust, logs)           |
| `--yes`, `-y` | Do not ask before `--purge`                                          |

### doctor

```sh
hookmux doctor [--json] [--fix]
```

`--fix` re-records the launcher's Node path, repairs the engine link, re-syncs hub entries and prunes old sessions, then checks. `--json` prints `ok`, `version`, `home`, `fixed`, `checks`, `verdict` and `next`.

## Plugins

| Command                       | What it does                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `hookmux new <id>`            | Creates a plugin folder with `plugin.toml` and `tests.toml`                                       |
| `hookmux validate <path>`     | Checks a plugin folder or its `plugin.toml` the way `add` would                                   |
| `hookmux test [<id>\|<path>]` | Runs the `[[case]]` entries in a plugin's `tests.toml`                                            |
| `hookmux explain "<prompt>"`  | Shows what every active plugin decides for a prompt, and the exact output the agent would receive |
| `hookmux add <source>`        | Copies plugins into the hookmux home. They stay untrusted until promoted                          |
| `hookmux install <source>`    | Sets up hookmux if needed, adds plugins like `add`, then asks you to approve each one             |
| `hookmux promote <id>`        | Shows a plugin's card, asks you to confirm, then trusts its current content                       |
| `hookmux remove <id>`         | Deletes `plugins/<id>/` and its trust, flag and source records                                    |
| `hookmux enable <id>`         | Turns a plugin switched off with `disable` back on. It still has to be promoted to run            |
| `hookmux disable <id>`        | Switches a plugin off without deleting it                                                         |
| `hookmux list`                | Shows each installed plugin with its status, phase, events, capabilities, problem and warnings    |

### new

```sh
hookmux new <id> [--template <name>] [--dir <path>] [--event <event>] [--repo [owner/name]]
```

Creates `<dir>/<id>/` with `plugin.toml` and `tests.toml`. The id uses lowercase letters, digits and dashes.

| Flag                  | Meaning                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--template <name>`   | `prompt-context` (the default), `tool-guard` (blocks a risky shell command on `tool.before`) or `session-note` (injects a note from `note.sh` on `session.start`) |
| `--dir <path>`        | The parent folder. Default is the current folder                                                                                                                  |
| `--event <event>`     | `prompt.submit` (the default), `session.start`, `tool.before` or `tool.after`. Only `prompt-context` takes a choice                                               |
| `--repo [owner/name]` | Make the folder a publishable repository: adds a README with the install line and the plugin's card, and a CI workflow                                            |

### validate

```sh
hookmux validate <path> [--json]
```

Exits 1 when the plugin has problems. `--json` prints `ok`, `path`, `id`, `problems`, `warnings`, `capabilities` and `compat`.

### test

```sh
hookmux test [<id>|<path>] [--json] [--live] [--run-scripts]
```

With no argument it tests every installed plugin. Exits 1 when a case fails.

| Flag            | Meaning                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--live`        | Call model-backed checks. By default they return unknown                                                              |
| `--run-scripts` | Run the scripts of a folder or an unpromoted plugin. By default they return unknown; promoted plugins always run them |
| `--json`        | Print `ok`, `plugins` and a `summary` with `passed`, `failed` and `skipped`                                           |

### explain

```sh
hookmux explain "<prompt>" [--host <id>] [--event <event>] [--all] [--run-scripts] [--json]
```

| Flag              | Meaning                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--host <id>`     | The agent to simulate. Default `claude-code`                                                                     |
| `--event <event>` | The event. Default `prompt.submit`                                                                               |
| `--all`           | Also run untrusted plugins. They are labelled and never reach the printed output                                 |
| `--run-scripts`   | With `--all`, also run those plugins' scripts. By default they return unknown                                    |
| `--json`          | Print `host`, `event`, `prompt`, `plugins`, `context`, `notices`, `block`, `hostFeatures`, `errors` and `stdout` |

`explain` writes no state and no log.

### add

```sh
hookmux add <source> [--plugin <id>]... [--shadow] [--list] [--force]
```

| Source                                        | Meaning                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `./path` or `/path`                           | A local folder. An existing path always wins                     |
| `owner/repo[@ref]`                            | A GitHub repository, optionally at a branch or tag               |
| `owner/repo/path[@ref]`                       | A folder inside a GitHub repository; the ref goes after the path |
| `https://host/o/r(.git)`                      | Any https git URL                                                |
| `https://github.com/o/r/tree/<ref>/<subpath>` | A folder inside a GitHub repository                              |
| `git@host:o/r.git`                            | An SSH git URL. Uses your git credentials                        |

Plugins are found at `plugin.toml`, `plugins/*/`, `hookmux/*/` and `skills/*/hookmux/`.

| Flag            | Meaning                                                 |
| --------------- | ------------------------------------------------------- |
| `--plugin <id>` | Install only these plugins. Repeatable                  |
| `--shadow`      | Mark them shadow: evaluated and logged, output withheld |
| `--list`        | Show what the source contains and install nothing       |
| `--force`       | Replace an installed plugin with the same id            |

A plugin stays untrusted until promoted, unless a standing approval (`hookmux promote <id> --standing`) covers the update.

### install

```sh
hookmux install <source> [--plugin <id>]... [--host <id>]...
```

For a plugin author's published install line. Sets up hookmux when it is not set up yet (engine, launcher and hub entries on the chosen client, with no bundled plugins and no authoring skill), adds the plugin untrusted like `add`, and asks you to approve it. Sources are the same as for `add`.

At your terminal it asks which clients to wire and shows each plugin's card for a `y`. Run by an agent, it wires the client that is running it, prints the card and a code, and exits 3; you approve by replying with the code. With no terminal and no agent marker, name the client with `--host`, or it exits 2.

| Flag            | Meaning                                |
| --------------- | -------------------------------------- |
| `--plugin <id>` | Install only these plugins. Repeatable |
| `--host <id>`   | Wire this agent client. Repeatable     |

Exit codes: 0 done, 1 failed, 2 usage error, 3 waiting for your reply.

### promote

```sh
hookmux promote <id> [--standing | --end-standing]
hookmux promote <id> [--standing] --grant <token>
hookmux promote <id> --confirm <code>
```

Shows the plugin's card (what it can do and where it came from), asks you to confirm, then trusts its current content and capabilities and clears its shadow flag. It never accepts `--yes`. In your own terminal it asks you to type `y`. From an agent client, or a shell with no terminal, it prints the card and a four-character code and exits 3: you approve by replying `approve <code>` in your own message, and `--confirm <code>` then turns the plugin on if it is unchanged since the card. The card expires after 30 minutes, and a relayed approval never grants `--standing`. Exit codes: 0 done, 1 refused or failed, 3 waiting for your reply.

| Flag               | Meaning                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--standing`       | Also let later `hookmux add` runs of this plugin activate without asking while its capabilities stay within today's                                                                        |
| `--end-standing`   | End that standing approval. Works anywhere. Cannot be combined with `--standing`                                                                                                           |
| `--grant <token>`  | A one-time grant from the hub. When an agent in Claude Code or Qwen Code runs `hookmux promote <id>`, the hub makes the client ask you first and adds the grant to the command you approve |
| `--confirm <code>` | Turn the plugin on after you replied with the code from the card                                                                                                                           |

### list

```sh
hookmux list [--json]
```

A plugin's status is `active`, `untrusted`, `invalid`, `shadow` or `disabled`. Exits 1 when any plugin is invalid. `--json` prints `{ "plugins": [...] }`, each with `id`, `status`, `version`, `description`, `phase`, `events`, `capabilities`, `problem`, `warnings` and `source`.

## Inspect

| Command                                            | What it does                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `hookmux log <on\|off\|status\|show\|path\|clear>` | Controls and reads the decision log                                             |
| `hookmux schema`                                   | Prints manifest keys, check kinds, effects, events and what each agent supports |

### log

| Subcommand                                             | What it does                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log on [--for <30m\|24h\|7d>] [--prompts]`            | Starts logging each hook run. Without `--for` it has no expiry. `--prompts` also stores the first 500 characters of every prompt on this machine                                            |
| `log off`                                              | Stops logging                                                                                                                                                                               |
| `log status [--json]`                                  | Shows whether logging is on, the file size and the expiry                                                                                                                                   |
| `log show [-n 20] [--json] [--plugin <id>] [--errors]` | Prints one line per run, newest last. `-n` sets how many, `--plugin` keeps runs that involved one plugin, `--errors` keeps runs with errors. With `--json` it prints `{ "entries": [...] }` |
| `log path`                                             | Prints the log file path                                                                                                                                                                    |
| `log clear`                                            | Deletes the log files                                                                                                                                                                       |

### schema

```sh
hookmux schema [--json]
```

`schema --json` is the live reference for what the installed engine accepts. When it disagrees with these docs, it wins.

## Environment variables

| Variable            | Meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `HOOKMUX_HOME`      | The hookmux home folder. `--home` sets it for one run                                         |
| `HOOKMUX_DISABLE=1` | Set in an agent's environment, turns hookmux off for that session. Guard plugins keep running |
| `HOOKMUX_DEBUG=1`   | Print a stack trace when a command fails                                                      |

A script check also receives `HOOKMUX_PLUGIN_DIR` (the plugin folder), `HOOKMUX_HOST` (the agent id) and `HOOKMUX_EVENT` (the event name).

## The home folder

Everything hookmux writes is under `~/.hookmux`, unless you set `HOOKMUX_HOME` or `--home`.

| Path               | What it holds                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/hookmux-hook` | The launcher script the agents run                                                                                                       |
| `engine/`          | Installed engine versions, with `engine/current` pointing at the active one                                                              |
| `plugins/`         | Installed plugins, one folder each                                                                                                       |
| `config.toml`      | Your settings, provider definitions and per-plugin overrides. See the [plugin.toml reference](plugins.md#overrides-in-hookmuxconfigtoml) |
| `registry.json`    | The compiled snapshot of your plugins that each hook run reads                                                                           |
| `trust.json`       | The recorded approvals                                                                                                                   |
| `logs/hookmux.log` | The decision log, when it is on                                                                                                          |
