---
name: hookmux
description: Builds hookmux plugins, which make Claude Code, Codex or Gemini CLI act on their own when a prompt or tool call matches. Use when the user asks to make, create, add or set up a hook; states a standing rule ("whenever I … remind/warn/block/suggest …", "every time I …"); or writes it in Vietnamese ("tạo hook", "mỗi khi tôi …", "bất cứ khi nào …"). Code hooks (React hooks, git hooks, webhooks) are a different subject.
---

# hookmux plugin authoring

The user wants an automatic behaviour. You build it as a hookmux plugin, test it, install it in shadow mode, and hand the user the one command that makes it live. You stage; the user approves.

The full documentation is one text file at https://docs.khangle.dev/hookmux/llms-full.txt.

`hookmux schema --json` is the live reference for what the installed engine accepts. When it disagrees with this skill or its references, follow the engine. Each command's `--help` gives its exact arguments.

References, loaded when a step names them:

- `references/plugin-format.md`: manifest keys, `when` logic, phases, overrides, templates, tests.
- `references/check-kinds.md`: every check kind with its tier, whether it is model-backed, and its options.
- `references/effects.md`: effects and what each client supports on each event.
- `references/hosts.md`: event names per client.
- `references/examples/moodboard/`: a complete rules-only plugin with its `tests.toml`.

## Workflow

### 1. Restate the request as a plugin

Write down four values:

- Event: `prompt.submit`, `session.start`, `tool.before` or `tool.after`.
- Trigger: what makes it fire, and the near misses that must stay silent.
- Effect: `inject` (context for the agent), `block`, or `notify` (a message for the user).
- Phase: `guard` for a block, `route` for a suggestion, `enrich` for context added every time.

Ask the user only about a choice that changes the result, such as suggest or block. Check `references/effects.md` that the chosen client supports the effect on that event. Done when all four have a value.

### 2. Look for an existing plugin

Run `hookmux list --json`. When an installed plugin already covers the request, change it with an `[override.<id>]` table in `~/.hookmux/config.toml` (`references/plugin-format.md`, Overrides) instead of adding a near-duplicate. Done when you know whether you are writing a new plugin or an override.

### 3. Scaffold

Run `hookmux new <id>` with a lowercase, dash-separated id. It writes `plugin.toml` and `tests.toml`. `--template tool-guard` starts from a shell-command blocker, `--template session-note` from a script that adds a note at session start (tool and session events have no user origin, so tool-guard is a guard-phase plugin and session-note sets `origins = ["unknown"]`), and `--repo owner/name` adds a README and a CI workflow so the folder can be pushed and installed.

### 4. Write the checks, cheapest first

Use `references/check-kinds.md` for kinds and options:

1. Rules first: `regex`, `keywords` and `regex_groups` for prompt text, and `tool`, `cwd_glob`, `path_exists`, `host` or `origin` for context. Add an exempt check for each near miss and write `when` as `trigger and not exempt`.
2. A model-backed kind only for a trigger that rules cannot express. Always pair it with `when_degraded`: a rules-only expression, or `"false"` to stay quiet when the model is unavailable.
3. A script kind (tier 1) last, only when no built-in kind fits.

A `block` needs a rule check that is true, because model-backed checks cannot justify a block alone. Use TOML literal strings (`'...'`) for regular expressions. Put `\b` only next to ASCII letters; for accented words, use `keywords` or plain substrings. Flags default to case-insensitive.

Done when `hookmux validate <dir>` reports no problems.

### 5. Write the tests

In `tests.toml`, add `[[case]]` entries with a `prompt` and `expect = "fire"` or `expect = "silent"`. Cover:

- each way the user phrased the request;
- the near misses from step 1, as silent cases, at least as many as the fire cases;
- every language the user writes prompts in, judged from this conversation.

### 6. Verify

Run `hookmux validate <dir>`, then `hookmux test`, then `hookmux explain "<prompt>"` for one firing and one silent prompt. Script checks in a folder nobody promoted show as skipped; for a script you wrote yourself, add `--run-scripts` to `hookmux test <dir>`. Fix the checks until every case passes and `explain` shows the outcome you expect. Done when all three agree.

### 7. Install in shadow mode

Run `hookmux add <dir> --shadow`. A shadow plugin is evaluated and logged, and adds nothing to the agent's context.

### 8. Hand over

Tell the user what the plugin does (event, trigger, effect, and whether it can block) and the test results. Then run this as a Bash call by itself, with nothing else on the line:

```sh
hookmux promote <id>
```

What happens next depends on the client:

- In Claude Code and Qwen Code, when an installed plugin listens to `tool.before`, the client shows the user that call and waits. Without such a plugin, promote prints a card and a code as below. If they approve, the plugin goes live; if they decline, it stays off. Say what you are about to ask before you run it.
- In any other client, promote prints a card and a four-character code and exits 3. Show the user the card word for word and ask whether to turn the plugin on. Do not answer for them. If they agree, they reply `approve <code>` in their own message; hookmux reads that reply itself and tells you the exact command to run, `hookmux promote <id> --confirm <code>`. Run only that. If the plugin changes in between, run `hookmux promote <id>` again for a new card.

Running promote through a pseudo-terminal, adding `--yes`, writing a `--grant` yourself, running `--confirm` before the user has replied, feeding the hub a payload of your own, starting another agent client with the code as its prompt, wrapping the command so the hub does not see it, editing `~/.hookmux/trust.json`, the registry or the card files, and turning on `auto_trust_declarative` are all ways around the user's approval, so none of them is yours to do. A relayed approval never grants `--standing`.

Any later edit to the plugin folder un-trusts it until the user promotes it again. Say so when you change a live plugin. If the user granted a standing approval (`hookmux promote <id> --standing`), reinstall the changed plugin with `hookmux add <dir> --force` and it goes live while its capabilities stay within that approval; a new capability still needs the user's promote.

## Installing a plugin for the user

When the user asks you to install a plugin someone else published ("install the X plugin with hookmux"), run the install line you were given:

```sh
npx -y hookmux install <github-username>/<repo-name>
```

The source is the plugin's repository, as `<github-username>/<repo-name>` (for example `khanglvm/hookmux-no-force-push`), with `/<path>` added when the plugin sits in a folder of the repository (`khanglvm/hookmux/plugins/hookmux-authoring`), or its GitHub link.

It sets hookmux up if needed, adds the plugin off, prints the plugin's card and a four-character code, and exits 3. Then:

1. Show the user the card word for word. Do not shorten or reword it: the risk words and the "Can:" lines are what they decide on.
2. Ask whether to turn the plugin on, and wait for their reply. Do not answer for them.
3. When the user has replied with `approve <code>`, hookmux reads the reply itself and tells you the exact command to run, `hookmux promote <id> --confirm <code>`. Run that line and nothing else. If hookmux has not seen a reply, it says so; ask again instead of retrying.

This is the same on every client, Claude Code and Qwen Code included: their permission prompt covers only a bare `hookmux promote <id>` call. The same limits as in step 8 apply: no `--yes`, no `--standing`, no editing hookmux's files.
