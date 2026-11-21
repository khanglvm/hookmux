<p align="center"><img src=".github/assets/cover.png" alt="hookmux: one hook entry for every coding agent" width="100%"></p>

# <img src=".github/assets/icon-256.png" alt="" width="36" align="top"> hookmux

Coding agents such as Claude Code, Codex, Gemini CLI and Qwen Code can run a command of yours at fixed moments: when you send a prompt, when a session starts, and before or after the agent uses a tool. That command is called a hook. What it prints back can add a note to what the agent reads, stop the prompt or the tool call, or show you a message.

hookmux takes that hook slot once in each agent and runs small plugins inside it. You write a behaviour once, as a plugin folder, and it works in every agent you use. Adding, changing or removing a plugin never touches an agent's config again.

## What you can do with it

A hook sees what is about to happen and answers before the agent carries on, so the range is wide. A few examples:

- Stop a prompt that contains an API key before it reaches the model.
- Refuse a `git push --force` or an `rm -rf` the agent is about to run.
- Remind the agent of a project's rules whenever a session starts in that folder.
- Point the agent at a skill or a doc when a prompt asks for a certain kind of work, such as "redesign the pricing page".
- Tell the agent to run the tests after it edits a file.
- Run your own script and pass what it prints to the agent, such as the current git branch or the ticket you are working on.

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

hookmux needs Node.js 22 or later.

```sh
npx hookmux init
```

Or install the CLI globally first:

```sh
npm i -g hookmux
hookmux init
```

`init` installs hookmux under `~/.hookmux` and adds its hook to the agents you choose. Your existing hooks stay as they are. The agents run a local launcher script, never `npx`, so a hook never waits on the network.

## Write your first plugin

This plugin stops any prompt that looks like it contains an AWS key or a GitHub token.

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

You can also ask your agent to write a plugin for you, for example "make a hook that reminds me to run the tests before a release". hookmux installs an authoring skill into each agent that walks it through writing, testing and installing the plugin.

## Install plugins other people wrote

`hookmux add` takes a local folder or a git repository:

```sh
hookmux add owner/repo --list   # see what the repository contains
hookmux add owner/repo          # install its plugins
hookmux promote <id>            # approve each one you want on
```

It finds plugins at the repository root and under `plugins/`, `hookmux/` and `skills/*/hookmux/`. Other sources are a full https or SSH git URL, a `@ref` suffix for a branch or tag, and a GitHub `tree/<ref>/<path>` link.

## For hook authors

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

To ship it:

1. Add a `tests.toml` with cases that should fire and cases that should stay silent, and run `hookmux test ./branch-note --run-scripts`.
2. Run `hookmux validate ./branch-note` to check the manifest.
3. Push the folder to a git repository. People install it with `hookmux add you/your-repo` and approve it with `hookmux promote branch-note`.

The [plugin reference](docs/plugins.md) lists every manifest key, check kind, effect and template placeholder. `hookmux schema --json` prints the same data for tools.

## Commands

| Command                                       | What it does                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `hookmux init`                                | Installs hookmux and adds its hook to the agents you choose          |
| `hookmux uninstall`                           | Removes hookmux's hook from every agent config                       |
| `hookmux sync`                                | Updates the agent configs to match the events your plugins use       |
| `hookmux new <id>`                            | Creates a plugin folder with `plugin.toml` and `tests.toml`          |
| `hookmux validate <dir>`                      | Checks a plugin folder without installing it                         |
| `hookmux test <id or dir>`                    | Runs a plugin's `tests.toml` cases                                   |
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

`hookmux help` lists the commands in your installed version.

## Safety

- A broken hook never breaks your agent. If Node or hookmux is missing, fails, hangs or runs past its time limit, the hook prints nothing and exits 0, which every agent reads as "no opinion". A check that errors or times out counts as unknown and never blocks. Because a guard that stops running also stops blocking, each session start shows you a notice naming any guard plugin that is waiting for approval or does not load.
- Approvals are pinned to the files. `promote` records a SHA-256 hash of the plugin folder and the capabilities it has. If a file changes afterwards, whether by you, an agent or an update, the plugin stops running until you approve it again. A plugin you change often can get a standing approval (`hookmux promote <id> --standing`): later `hookmux add` updates go live without asking while they need no new capability. Anyone who can run `hookmux add`, agents included, can then replace its files within those capabilities. `hookmux promote <id> --end-standing` ends it.
- Approval needs you. `promote` asks you to type `y`, has no `--yes` flag, and refuses when stdin is not a terminal or when it sees the environment an agent gives the commands it runs. In Claude Code, an agent that runs `hookmux promote <id>` gets Claude Code's own permission prompt, and approving that prompt turns the plugin on. This stops an agent from turning on a plugin because of an injected instruction or by accident. It is not a sandbox: a process running as your user can still edit `~/.hookmux` directly.
- Previews run no unapproved code. `hookmux test` and `hookmux explain --all` skip the scripts of plugins you have not approved unless you pass `--run-scripts`.
- Shadow mode lets you try a plugin safely. A plugin added with `--shadow` (or `shadow = true`) runs and is logged, but adds nothing to what the agent sees.
- Blocks need a rule. By default a block needs a check that is not model-backed to agree, so a model's misreading cannot discard your prompt.
- No telemetry. hookmux collects no usage data.
- Private logs. The decision log is off until you run `hookmux log on`. It keeps a short hash and the length of each prompt, and stores prompt text only when you also pass `--prompts`. It rotates at 1 MiB and keeps one previous file.

## Troubleshooting

- Run `hookmux doctor` first. It reports problems with the install, the agent configs and your plugins.
- To see why a plugin did or did not fire, run `hookmux explain "<the prompt>"`.
- To trace real hook runs, turn the log on, reproduce the problem, then read `~/.hookmux/logs/hookmux.log`:

  ```sh
  hookmux log on
  # ...use your agent...
  hookmux log off
  ```

- To switch hookmux off for one session without uninstalling it, start the agent with `HOOKMUX_DISABLE=1` in its environment. Guard plugins keep running, because a session can set that variable itself; turn one off with `hookmux disable <id>`, which the next session start reports.

## Uninstall

```sh
hookmux uninstall
npm uninstall -g hookmux
```

`uninstall` removes only hookmux's own hook entries and leaves your other hooks alone. Your plugins, config and logs stay in `~/.hookmux`; delete that folder to remove them too.

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

[docs/hosts.md](docs/hosts.md) covers each agent's config file, event names and limits.

</details>

## Documentation

- [Plugin reference](docs/plugins.md)
- [Agent notes](docs/hosts.md)
- [Design notes](docs/design.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

MIT
