# Use hookmux with coding agents

This page is for a coding agent that builds, tests and installs hookmux plugins for a person. It lists the exact commands, the output formats and the limits, and marks the one step you must leave to the person: approving the plugin.

## Setup

- hookmux needs Node.js 22 or later. Install it from npm with `npm i -g hookmux` (or run `npx hookmux <command>`), then run `hookmux init`. To test unreleased changes, build from source as described in [Install](install.md) and run `node dist/cli.mjs <command>`.
- `hookmux init` copies an authoring skill named `hookmux` into the global skill folder of each wired agent that has one. Pass `--no-skill` to skip it. The skill's source is [skills/hookmux/SKILL.md](../skills/hookmux/SKILL.md).
- All the docs as one text file: https://docs.khangle.dev/hookmux/llms-full.txt. The index of every page is https://docs.khangle.dev/llms.txt.
- `hookmux schema --json` is the live reference for what the installed engine accepts. When it disagrees with a doc, follow the engine. `hookmux <command> --help` prints a command's exact arguments.

## Build a plugin for a person

Use this order. Each step ends when its check passes.

1. Write down the event (`prompt.submit`, `session.start`, `tool.before` or `tool.after`), the trigger, the near misses that must stay silent, the effect (`inject`, `block` or `notify`) and the phase (`guard` to block, `route` to suggest, `enrich` for context added every time). Check in [Supported agents](hosts.md) that the person's agent supports the effect on that event.
2. Run `hookmux list --json`. If an installed plugin already covers the request, change it with an `[override.<id>]` table in `~/.hookmux/config.toml` instead of adding a near-duplicate.
3. Run `hookmux new <id>` with a lowercase, dash-separated id. It writes `plugin.toml` and `tests.toml` in `./<id>/`. Add `--dir <path>` to put it elsewhere and `--event <event>` to pick the event.
4. Write the checks, cheapest first: `regex`, `keywords` and `regex_groups` for prompt text; `tool`, `cwd_glob`, `path_exists`, `host` or `origin` for context. Add an exempt check for each near miss and write `when` as `trigger and not exempt`. Use a model-backed kind (`classify`) only when rules cannot express the trigger, and always set `when_degraded`. Use a `script` check last. Done when `hookmux validate <dir>` reports no problems.
5. Write `tests.toml` with at least as many `expect = "silent"` cases as `expect = "fire"` cases, in every language the person writes prompts in.
6. Run `hookmux validate <dir>`, then `hookmux test <dir>`, then `hookmux explain "<prompt>"` for one firing prompt and one silent prompt. For a script you wrote yourself, add `--run-scripts` to `hookmux test`. Done when all three agree.
7. Run `hookmux add <dir> --shadow`. A shadow plugin is evaluated and logged and adds nothing to the agent's context.
8. Tell the person what the plugin does and the test results, then ask for approval as described below.

Rules for writing checks: a `block` needs a check that is true and not model-backed. Use TOML literal strings (`'...'`) for regular expressions. Put `\b` only next to ASCII letters; for accented words use `keywords` or plain substrings. Pattern flags default to case-insensitive.

## Approval belongs to the person

`hookmux promote <id>` turns a plugin on. You may not do it for the person. Run `hookmux promote <id>` as a Bash call by itself, with nothing else on the line, and say what you are asking before you run it. What happens next depends on the client:

- In Claude Code and Qwen Code, when an installed plugin listens to `tool.before`, the client shows the person that call and waits. The plugin goes live only if they approve it. Without such a plugin, promote prints a card and a code as below.
- In any other client, promote prints a card and a four-character code and exits 3. Show the person the card word for word and ask whether to turn the plugin on. Do not answer for them. If they agree, they reply `approve <code>` in their own message; hookmux reads that reply itself and tells you the exact command to run, `hookmux promote <id> --confirm <code>`. Run only that. If the plugin changed in between, run `hookmux promote <id>` again for a new card. The card expires after 30 minutes.

Each of these bypasses the person's approval, so none of them is yours to do: running promote through a pseudo-terminal, adding `--yes`, writing a `--grant` yourself, running `--confirm` before the person has replied, feeding the hub a payload of your own, starting another agent client with the code as its prompt, wrapping the command so the hub does not see it, editing `~/.hookmux/trust.json`, the registry or the card files, and setting `auto_trust_declarative`. A relayed approval never grants `--standing`.

Any later edit to a plugin folder un-trusts the plugin until the person promotes it again. Say so when you change a live plugin. If the person granted a standing approval (`hookmux promote <id> --standing`), reinstall the changed plugin with `hookmux add <dir> --force`; it goes live while its capabilities stay within the approval, and a new capability needs a new promote.

## Install a plugin for the person

When the person asks you to install a plugin someone else published, run the install line you were given: `npx -y hookmux install <github-username>/<repo-name>` (for example `khanglvm/hookmux-no-force-push`; a GitHub link works too). It sets hookmux up if needed, adds the plugin off, prints the plugin's card and a four-character code, and exits 3. Then:

1. Show the person the card word for word. Do not shorten or reword it: the risk words and the "Can:" lines are what they decide on.
2. Ask whether to turn the plugin on, and wait for their reply. Do not answer for them.
3. When they have replied `approve <code>`, hookmux reads the reply itself and tells you the exact command to run, `hookmux promote <id> --confirm <code>`. Run that line and nothing else. If hookmux has not seen a reply, it says so; ask again instead of retrying.

This is the same on every client, Claude Code and Qwen Code included: their permission prompt covers only a bare `hookmux promote <id>` call. The limits above apply: no `--yes`, no `--standing`, no editing hookmux's files.

## Commands with machine-readable output

All exit `0` on success, `1` when they found problems, and `2` on a usage error. See the [command reference](cli.md) for every flag.

| Command                              | JSON fields                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hookmux list --json`                | `{ "plugins": [{ id, status, version, description, phase, events, capabilities, problem, warnings, source }] }`. `status` is `active`, `untrusted`, `invalid`, `shadow` or `disabled` |
| `hookmux validate <path> --json`     | `{ ok, path, id, problems, warnings, capabilities, compat }`                                                                                                                          |
| `hookmux test [<id>\|<path>] --json` | `{ ok, plugins, summary: { passed, failed, skipped } }`                                                                                                                               |
| `hookmux explain "<prompt>" --json`  | `{ host, event, prompt, plugins, context, notices, block, hostFeatures, errors, stdout }`                                                                                             |
| `hookmux doctor --json`              | `{ ok, version, home, fixed, checks, verdict, next }`                                                                                                                                 |
| `hookmux log status --json`          | Whether logging is on, its size and expiry                                                                                                                                            |
| `hookmux log show --json`            | `{ "entries": [...] }`, newest last                                                                                                                                                   |
| `hookmux schema --json`              | Manifest keys, check kinds, effects, events and per-agent support                                                                                                                     |

## Test case format

`tests.toml` is a list of `[[case]]` tables:

| Key      | Meaning                                                         |
| -------- | --------------------------------------------------------------- |
| `prompt` | Prompt text. Required for `prompt.submit`                       |
| `expect` | `"fire"` or `"silent"`. Required                                |
| `host`   | Agent id to simulate. Default `"claude-code"`                   |
| `event`  | Canonical event. Default `"prompt.submit"`                      |
| `cwd`    | Working folder the event reports. Default is the current folder |

Scripts of a plugin that is not promoted give unknown and their cases are skipped, unless you pass `--run-scripts`. Model checks give unknown unless you pass `--live`.

## Script checks

A `script` check runs an executable from the plugin folder with the event as JSON on stdin. The script answers with exit code 0 (true) or 1 (false), or prints `{"value": true, "evidence": "..."}`. Its options are `command`, `args`, `timeout_ms` (default 1000, at most 10000), `needs_raw`, `output`, `env` and `evidence_chars`; see [check kinds](https://github.com/khanglvm/hookmux/blob/main/skills/hookmux/references/check-kinds.md). Environment variables the script receives: `HOOKMUX_PLUGIN_DIR`, `HOOKMUX_HOST`, `HOOKMUX_EVENT`, plus those the check declares in `env`. The script runs from a private copy, so find sibling files through `$HOOKMUX_PLUGIN_DIR`, not `$0`. Each variable in `env` and each `evidence_chars` above 80 is a capability that `promote` shows to the person.

## Limits

| Limit                    | Value                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Plugin folder            | At most 200 files and 4 MiB, no symlinks                                                                                      |
| `plugin.toml`            | At most 256 KiB, owned by the user, not writable by group or others                                                           |
| Plugin id                | Lowercase letters, digits and dashes, at most 64 characters, equal to the folder name                                         |
| Effect text              | At most 4,000 characters                                                                                                      |
| `when` expression        | At most 2,000 characters                                                                                                      |
| Pattern checks           | At most 200 patterns of up to 300 characters each; input cut to 8,000 characters. Nested repeats such as `(a+)+` are rejected |
| `deadline_ms` setting    | 50 to 20000, default 2000. Checks still running at the deadline become unknown                                                |
| Hook run                 | The launcher stops a hook run after 5 seconds and passes nothing on                                                           |
| `context_budget` setting | Default 9000 characters of injected context per event, also capped by each agent's own limit                                  |
| `on_error`               | Only `"open"` is accepted. hookmux always fails open                                                                          |

The hook fails open on every error: it prints nothing and exits 0. An unknown check result never blocks.

## Related pages

- [plugin.toml reference](plugins.md) for every manifest key, check kind, effect and template placeholder.
- [Supported agents](hosts.md) for each agent's events, effects and limits.
- [Safety and approvals](safety.md) for the approval model.
