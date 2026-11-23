<p align="center"><img src=".github/assets/cover.png" alt="hookmux: one hook entry for every coding agent" width="100%"></p>

# <img src=".github/assets/icon-256.png" alt="" width="36" align="top"> hookmux

Coding agents such as Claude Code, Codex, Gemini CLI and Qwen Code can run a command of yours at fixed moments: when you send a prompt, when a session starts, and before or after the agent uses a tool. That command is called a hook. What it prints back can add a note to what the agent reads, stop the prompt or the tool call, or show you a message.

hookmux takes that hook slot once in each agent and runs small plugins inside it. You write a behaviour once, as a plugin folder, and it works in every agent you use. Adding, changing or removing a plugin never touches an agent's config again.

To use it, run `npx hookmux init` to wire your agents. Then write your own plugins (`hookmux new` starts one from a template) or install ones other people published. Plugins are shared as GitHub repositories, like agent skills, and one line sets hookmux up and installs any of them. A new plugin stays off until you approve it:

```sh
npx -y hookmux install <owner>/<repo>
```

## What you can do with it

A hook sees what is about to happen and answers before the agent carries on, so the range is wide. A few examples:

- Stop a prompt that contains an API key before it reaches the model.
- Refuse a `git push --force` or an `rm -rf` the agent is about to run.
- Remind the agent of a project's rules whenever a session starts in that folder.
- Point the agent at a skill or a doc when a prompt asks for a certain kind of work, such as "redesign the pricing page".
- Tell the agent to run the tests after it edits a file.
- Run your own script and pass what it prints to the agent, such as the current git branch or the ticket you are working on.

The [no-force-push](https://github.com/khanglvm/hookmux-no-force-push) repository is a published plugin for the second item, if you want to see a real one: `npx -y hookmux install khanglvm/hookmux-no-force-push`.

Plugins decide with checks: words, regular expressions, the tool being called, the working folder, your own scripts, or an optional small model. Rules-only plugins run in-process in about a millisecond.

## How it works

```text
 Claude Code ──┐                          ┌── no-secrets
 Codex ────────┤                          │
 Gemini CLI ───┼──▶ hookmux (one hook) ───┼── project-rules
 Qwen Code ────┤                          │
 ...       ────┘                          └── run-the-tests
```

`hookmux init` adds one hookmux entry per event to each agent's hook config. When an agent fires it, hookmux reads the event, runs every plugin listening for that event, and returns one combined answer in that agent's format. A plugin is a folder with a `plugin.toml` and, optionally, scripts and tests.

## Install

<!-- docs:begin install.md -->
hookmux needs Node.js 22 or later. It is published on npm as [`hookmux`](https://www.npmjs.com/package/hookmux).

### Install from npm

```sh
npx hookmux init
```

Or install the CLI globally, so `hookmux` is on your `PATH` for later commands:

```sh
npm i -g hookmux
hookmux init
```

`init` copies the engine into `~/.hookmux`, writes a launcher script there, and asks which agents to wire. Your existing hooks stay as they are. It then offers to install the plugins that ship with hookmux and the authoring skill, which teaches your agent to write plugins. The agents run the local launcher, never `npx`, so a hook never waits on the network.

To update, install the new version (`npm i -g hookmux@latest`, or `npx hookmux@latest init`) and run `init` again. A re-run updates the engine and the agents it already wired.

To install a plugin someone published, pass its GitHub repository. The command sets hookmux up if needed and asks you before it turns each plugin on:

```sh
npx -y hookmux install <owner>/<repo>
```

[Install and share plugins](docs/plugin-sources.md) covers sources, approval and removal.

### Install from source

Use this to try unreleased changes or to work on hookmux itself. You need Node.js 22 or later, git, and pnpm 12 (the version pinned in `package.json`).

1. Clone the repository and install its dependencies:

   ```sh
   git clone https://github.com/khanglvm/hookmux.git
   cd hookmux
   pnpm install
   ```

2. Build the CLI. This writes it to `dist/`:

   ```sh
   pnpm build
   ```

3. Run `init` with the built CLI:

   ```sh
   node dist/cli.mjs init
   ```

A source install puts no `hookmux` command on your `PATH`. Run commands as `node /path/to/hookmux/dist/cli.mjs <command>`, or add a shell alias:

```sh
alias hookmux='node /path/to/hookmux/dist/cli.mjs'
```

To update a source install, pull the latest changes, run `pnpm install` and `pnpm build` again, then run `init` again.

### Choose the agents

Run `init` in a terminal and it asks about each agent it detects. To skip the questions, pass the agents yourself:

```sh
hookmux init --host claude-code --host codex
hookmux init --yes
```

`--host <id>` wires one agent and can repeat. `--yes` wires every detected agent. Without a terminal, `init` needs one of the two. The agent ids are `claude-code`, `codex`, `gemini-cli`, `qwen-code`, `droid`, `qoder`, `codebuddy` and `opencode`; see [Supported agents](docs/hosts.md). `--no-skill` and `--no-bundled` leave out the authoring skill and the bundled plugins.

### Check the install

```sh
hookmux doctor
```

`doctor` checks Node, the engine, the launcher, every agent you wired (including a real launcher run), your plugins and the log. Add `--fix` to let it repair what is safe to repair.

### Uninstall

```sh
hookmux uninstall
```

`uninstall` removes only hookmux's own hook entries and leaves your other hooks alone. Your plugins, config and logs stay in `~/.hookmux`. Add `--purge` to delete that folder too; it asks first unless you pass `--yes`. If you installed the CLI with npm, also run `npm uninstall -g hookmux`.
<!-- docs:end -->

## Write your first plugin

<!-- docs:begin quickstart.md -->
This walkthrough builds a plugin that stops any prompt that looks like it contains an AWS key or a GitHub token, then checks it without opening an agent. It assumes you have already run `hookmux init`; see [Install](docs/install.md).

1. Create the plugin folder:

   ```sh
   hookmux new no-secrets
   ```

2. Replace `no-secrets/plugin.toml` with:

   ```toml
   schema = 1
   id = "no-secrets"
   events = ["prompt.submit"]
   phase = "guard"
   when = "secret_shape"

   [checks.secret_shape]
   kind = "regex"
   patterns = ['AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{36}']

   [[then]]
   effect = "block"
   reason = "The prompt looks like it contains a credential. Remove it and send again."
   ```

3. Install it and turn it on:

   ```sh
   hookmux add ./no-secrets
   hookmux promote no-secrets
   ```

   hookmux runs a plugin only after you approve it. `promote` shows what the plugin is allowed to do (block, add context, run scripts) and asks you to type `y`, so an agent cannot switch on code that runs on every prompt without you. Run it in your own terminal.

4. Check what it decides for a prompt, without opening an agent:

   ```sh
   hookmux explain "deploy with AKIAIOSFODNN7EXAMPLE"
   ```

Every agent you set up with `init` now refuses that prompt and shows the reason.

If you run hookmux from a source checkout, replace `hookmux` in these commands with `node /path/to/hookmux/dist/cli.mjs`, as described in [Install](docs/install.md).

You can also ask your agent to write a plugin for you, for example "make a hook that reminds me to run the tests before a release". hookmux installs an authoring skill into each agent that walks it through writing, testing and installing the plugin. The agent installs the plugin in shadow mode, where it runs and is logged but adds nothing, and you approve it when you are ready.

To see what each part of the manifest means, read [How plugins decide](docs/how-plugins-decide.md). To add test cases, read [Test a plugin](docs/testing.md).
<!-- docs:end -->

## Install and share plugins

<!-- docs:begin plugin-sources.md -->
`hookmux add` installs plugins from a local folder or a git repository. If you maintain a hook, the same command lets other people install yours.

### Install plugins other people wrote

Plugins are shared as GitHub repositories, the way agent skills are. Pass the repository as `owner/repo` or as its GitHub link. For example, with the example plugin [khanglvm/hookmux-no-force-push](https://github.com/khanglvm/hookmux-no-force-push):

```sh
hookmux add khanglvm/hookmux-no-force-push --list   # see what the repository contains
hookmux add khanglvm/hookmux-no-force-push          # install its plugins
hookmux promote no-force-push                      # approve each one you want on
```

`add` finds plugins at the repository root and under `plugins/`, `hookmux/` and `skills/*/hookmux/`. Other sources are a full https or SSH git URL, a `@ref` suffix for a branch or tag, and a GitHub `tree/<ref>/<path>` link. Installed plugins stay untrusted until you promote them. Use `--plugin <id>` to install only some of a repository's plugins, and `--shadow` to install one that runs and is logged but adds nothing.

Read a plugin's `plugin.toml` before you promote it. `promote` also lists what the plugin can do and which files it covers.

### Install a plugin someone sent you

A plugin author may send you one line to run, or a sentence to paste to your coding agent. Both do the same three things: set up hookmux if you do not have it yet, copy the plugin onto your machine and ask whether to turn it on. The plugin stays off until you say yes.

```sh
npx -y hookmux install khanglvm/hookmux-no-force-push
```

Replace `khanglvm/hookmux-no-force-push` with the plugin's repository, as `owner/repo` or the full GitHub link (`https://github.com/khanglvm/hookmux-no-force-push`). `npx` runs hookmux from npm without installing it first. It needs Node.js 22 or later. If you paste the line to your agent, the agent runs the command and shows you what it prints, but it cannot answer for you.

What it prints is a card. It names the plugin, says where it came from, how often it runs and what it can do. Each thing it can do carries a risk word:

- `high` means it can run code as you or stop your work: it runs a script, or it can stop a tool call or discard your prompt.
- `medium` means it reaches further than reading: it adds text the agent reads and may follow, sends your prompt or tool details to your model provider, or passes an environment variable to its script.
- `low` means it only shows you a message.

Approve a `high` line only when you trust where the plugin came from.

You answer in one of two ways:

- At your own terminal, `hookmux install` shows the card and asks you to type `y`.
- When your agent runs it, the agent shows you the card and a four-character code. Reply with `approve K7Q2` (using your code) in your next message. hookmux sees your reply and tells the agent to finish.

[Safety](docs/safety.md) says what each of these proves and what it does not.

To turn an installed plugin off later but keep its files, run `hookmux disable <id>`, for example `hookmux disable no-force-push`. To delete the plugin from your machine, run `hookmux remove <id>`. The id is the name after `hookmux plugin:` on the first line of the card.

### Share a plugin you wrote

If you maintain a hook for one agent, publishing it as a hookmux plugin lets it run in every agent hookmux supports. You describe when it fires and what it does; hookmux handles each agent's config file, payload and output format.

Logic that needs code goes in a script check. hookmux runs the script from your plugin folder, in the agent's working folder, with the event as JSON on stdin. The script answers with exit code 0 (true) or 1 (false), or prints `{"value": true, "evidence": "..."}`, and effect text can quote the evidence with `{evidence.<check>}`.

This plugin tells the agent which git branch it is on when a session starts:

```toml
# branch-note/plugin.toml
schema = 1
id = "branch-note"
events = ["session.start"]
phase = "enrich"
origins = ["unknown"]
when = "on_branch"

[checks.on_branch]
kind = "script"
command = "branch.sh"

[[then]]
effect = "inject"
text = "You are on the git branch {evidence.on_branch}."
```

```sh
#!/bin/sh
# branch-note/branch.sh: exit 1 (false) outside a git checkout.
branch=$(git branch --show-current 2>/dev/null)
[ -n "$branch" ] || exit 1
printf '{"value": true, "evidence": "%s"}\n' "$branch"
```

To ship the branch-note plugin (the [no-force-push](https://github.com/khanglvm/hookmux-no-force-push) repository is a finished example to copy):

1. Add a `tests.toml` with cases that should fire and cases that should stay silent, and run `hookmux test ./branch-note --run-scripts`.
2. Run `hookmux validate ./branch-note` to check the manifest.
3. Push the folder to a git repository. People install it with `hookmux add you/your-repo` and approve it with `hookmux promote branch-note`.

The [plugin.toml reference](docs/plugins.md) lists every manifest key, check kind, effect and template placeholder. `hookmux schema --json` prints the same data for tools. [Test a plugin](docs/testing.md) explains the test cases.
<!-- docs:end -->

## For plugin creators: a one-line install

You can publish a plugin so that people install hookmux and your plugin with one line, and never have to learn how hookmux works.

1. Scaffold a plugin that is also a repository:

   ```sh
   hookmux new my-plugin --template tool-guard --repo you/my-plugin
   ```

   `--template` picks a starting point (`prompt-context`, `tool-guard` or `session-note`). `--repo` adds a `README.md` with the install line and a card showing what your users will approve, and a CI workflow that runs `validate` and `test`.

2. Edit `plugin.toml` and `tests.toml`, then check them on your machine. The generated CI runs the same two commands on every push:

   ```sh
   hookmux validate ./my-plugin
   hookmux test ./my-plugin --run-scripts
   ```

3. Push the folder to GitHub. Put this install line in your README:

   ```sh
   npx -y hookmux install you/my-plugin
   ```

   `npx` works once hookmux is published on npm.

4. Give your users a sentence to paste to their coding agent:

   ```text
   Install the my-plugin plugin with hookmux: run `npx -y hookmux install you/my-plugin`, show me the approval card it prints word for word, and wait for my answer.
   ```

Here is what your users see. The command prints a card with what your plugin does and a risk word on each thing it can do. At a terminal, the user types `y` to turn it on. When their agent runs the line, the agent shows them the card and a short code, and the user replies with the code. The README you scaffolded shows the card, so you can check it matches what you meant to ask for.

Your plugin stays off until the user approves. A change you publish later needs a new approval, unless the user granted a standing one for your plugin (see [Safety](#safety)). The [agent notes](docs/hosts.md) list which clients use which approval.

## Commands

| Command                                       | What it does                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `hookmux init`                                | Installs hookmux and adds its hook to the agents you choose          |
| `hookmux uninstall`                           | Removes hookmux's hook from every agent config                       |
| `hookmux sync`                                | Updates the agent configs to match the events your plugins use       |
| `hookmux new <id>`                            | Creates a plugin folder; `--template` and `--repo` shape it          |
| `hookmux validate <dir>`                      | Checks a plugin folder without installing it                         |
| `hookmux test <id or dir>`                    | Runs a plugin's `tests.toml` cases                                   |
| `hookmux install <source>`                    | Sets up hookmux, adds a plugin and asks you to approve it            |
| `hookmux add <source>`                        | Installs plugins from a folder or git repository                     |
| `hookmux promote <id>`                        | Approves a plugin and turns it on; asks you to confirm               |
| `hookmux promote <id> --standing`             | Also lets later `hookmux add` updates of it go live without asking   |
| `hookmux remove <id>`                         | Uninstalls a plugin                                                  |
| `hookmux enable <id>`, `hookmux disable <id>` | Turns a plugin on or off                                             |
| `hookmux list`                                | Lists installed plugins and their status; `--json` for scripts       |
| `hookmux explain "<prompt>"`                  | Shows how every installed plugin decides on a prompt                 |
| `hookmux doctor`                              | Reports problems with the install, the agent configs and the plugins |
| `hookmux log on`, `hookmux log off`           | Turns the decision log on or off                                     |
| `hookmux schema --json`                       | Prints the manifest schema, check kinds, effects and agents          |

`hookmux help` lists the commands in your installed version. The [command reference](docs/cli.md) covers every flag.

## Safety

<!-- docs:begin safety.md -->
A hook runs on every prompt or tool call, so hookmux is built to fail quietly, to run only code you approved, and to keep what it records to a minimum. This page lists what it guarantees and where the limits are.

- A broken hook never breaks your agent. If Node or hookmux is missing, fails, hangs or runs past its time limit, the hook prints nothing and exits 0, which every agent reads as "no opinion". A check that errors or times out counts as unknown and never blocks. Because a guard that stops running also stops blocking, each session start shows you a notice naming any guard plugin that is waiting for approval or does not load.
- Approvals are pinned to the files. `promote` records a SHA-256 hash of the plugin folder and the capabilities it has. If a file changes afterwards, whether by you, an agent or an update, the plugin stops running until you approve it again. A plugin you change often can get a standing approval (`hookmux promote <id> --standing`): later `hookmux add` updates go live without asking while they need no new capability. Anyone who can run `hookmux add`, agents included, can then replace its files within those capabilities. `hookmux promote <id> --end-standing` ends it.
- Approval needs you. `promote` asks you to type `y`, has no `--yes` flag, and refuses when stdin is not a terminal or when it sees the environment an agent gives the commands it runs. In Claude Code, an agent that runs `hookmux promote <id>` gets Claude Code's own permission prompt, and approving that prompt turns the plugin on. This stops an agent from turning on a plugin because of an injected instruction or by accident. It is not a sandbox: a process running as your user can still edit `~/.hookmux` directly.
- Previews run no unapproved code. `hookmux test` and `hookmux explain --all` skip the scripts of plugins you have not approved unless you pass `--run-scripts`.
- Shadow mode lets you try a plugin safely. A plugin added with `--shadow` (or `shadow = true`) runs and is logged, but adds nothing to what the agent sees.
- Blocks need a rule. By default a block needs a check that is not model-backed to agree, so a model's misreading cannot discard your prompt.
- No telemetry. hookmux collects no usage data.
- Private logs. The decision log is off until you run `hookmux log on`. It keeps a short hash and the length of each prompt, and stores prompt text only when you also pass `--prompts`. It rotates at 1 MiB and keeps one previous file.
<!-- docs:end -->

## Troubleshooting

<!-- docs:begin troubleshooting.md -->
Start with `hookmux doctor`, then use `explain` and the log to see why a plugin did or did not fire.

- Run `hookmux doctor` first. It reports problems with the install, the agent configs and your plugins. `hookmux doctor --fix` repairs what is safe to repair.
- To see why a plugin did or did not fire, run `hookmux explain "<the prompt>"`.
- To trace real hook runs, turn the log on, reproduce the problem, then read `~/.hookmux/logs/hookmux.log`:

  ```sh
  hookmux log on
  # ...use your agent...
  hookmux log off
  ```

- To switch hookmux off for one session without uninstalling it, start the agent with `HOOKMUX_DISABLE=1` in its environment. Guard plugins keep running, because a session can set that variable itself; turn one off with `hookmux disable <id>`, which the next session start reports.
<!-- docs:end -->

## Supported agents

<details>
<summary>Agents, events and what a plugin can do in each</summary>

hookmux uses four events across agents: `prompt.submit` (you send a prompt), `session.start`, `tool.before` and `tool.after`. A plugin's effects are `inject` (add text for the agent), `block` and `notify` (show you a message). Where an agent cannot block on an event, a block becomes a notice.

<!-- hosts:begin -->
<!-- Generated by scripts/gen-skill-refs.ts from src/hosts. Do not edit; run `pnpm gen:refs`. -->
| Host           | `prompt.submit`       | `session.start` | `tool.before`         | `tool.after`          |
| -------------- | --------------------- | --------------- | --------------------- | --------------------- |
| Claude Code    | inject, block, notify | inject, notify  | inject, block, notify | inject, block, notify |
| CodeBuddy Code | inject, block, notify | inject, notify  | inject, block, notify | inject, notify        |
| Codex          | inject, block, notify | inject, notify  | inject, block, notify | inject, block, notify |
| Factory Droid  | inject, block, notify | inject, notify  | block, notify         | inject, block, notify |
| Gemini CLI     | inject, block, notify | inject, notify  | block, notify         | inject, block, notify |
| opencode       | inject, notify        | inject, notify  | block, notify         | inject, notify        |
| Qoder CLI      | inject, block, notify | inject, notify  | inject, block, notify | inject, notify        |
| Qwen Code      | inject, block, notify | inject, notify  | inject, block, notify | inject, block, notify |
<!-- hosts:end -->

Tested versions:

- Claude Code 2.1.325 and Codex 0.167.1 have been run live: adding context and blocking a prompt both work.
- The Gemini CLI adapter was written from the Gemini CLI source (v0.68.0). The Qwen Code (0.28.0), Factory Droid (1.16.0), Qoder CLI (1.1.94) and CodeBuddy Code (2.185.0) adapters were written from each client's hooks documentation. All five are covered by tests but have not been run against a live client yet.
- opencode 1.19.6 has been run live with a scripted model: context on prompts, at session start and after tool calls, and blocking a tool call, all work. hookmux installs a small plugin file there instead of a hook entry.
- Cursor and Devin CLI read Claude Code's `~/.claude/settings.json`, so they run hookmux's Claude Code entries too. That path is untested.

Codex runs a new or changed hook entry only after it is approved. `init`, `sync` and every command that changes a plugin approve hookmux's own entries through `codex app-server` and leave every other hook as it was; if that fails, approve them in Codex's `/hooks` screen.

[Supported agents](docs/hosts.md) covers each agent's config file, event names and limits.

</details>

## Documentation

The docs are published at [docs.khangle.dev/hookmux](https://docs.khangle.dev/hookmux). The pages live in `docs/`:

- [Install](docs/install.md) and [Write your first plugin](docs/quickstart.md)
- [How plugins decide](docs/how-plugins-decide.md) and [Test a plugin](docs/testing.md)
- [Command reference](docs/cli.md) and [plugin.toml reference](docs/plugins.md)
- [Supported agents](docs/hosts.md)
- [Use hookmux with coding agents](docs/agents.md)
- [Design notes](docs/design.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

MIT
