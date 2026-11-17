---

name: hookmux
description: Builds hookmux plugins, which make Claude Code, Codex or Gemini CLI act on their own when a prompt or tool call matches. Use when the user asks to make, create, add or set up a hook; states a standing rule ("whenever I … remind/warn/block/suggest …", "every time I …"); or writes it in Vietnamese ("tạo hook", "mỗi khi tôi …", "bất cứ khi nào …"). Code hooks (React hooks, git hooks, webhooks) are a different subject.
---

# hookmux plugin authoring

The user wants an automatic behaviour. You build it as a hookmux plugin, test it, install it in shadow mode, and hand the user the one command that makes it live. You stage; the user approves.

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

Run `hookmux new <id>` with a lowercase, dash-separated id. It writes `plugin.toml` and `tests.toml`.

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

Run `hookmux validate <dir>`, then `hookmux test`, then `hookmux explain "<prompt>"` for one firing and one silent prompt. Fix the checks until every case passes and `explain` shows the outcome you expect. Done when all three agree.

### 7. Install in shadow mode

Run `hookmux add <dir> --shadow`. A shadow plugin is evaluated and logged, and adds nothing to the agent's context.

### 8. Hand over

Tell the user what the plugin does (event, trigger, effect, and whether it can block), the test results, and the command to run in their own terminal:

```sh
hookmux promote <id>
```

Promote asks the user to confirm and refuses to run without an interactive terminal; that refusal is the approval step working. Leave promotion entirely to the user: hand over the command and stop there. Running it through a pseudo-terminal, adding `--yes`, editing `~/.hookmux/trust.json` or the registry, and turning on `auto_trust_declarative` are all ways around the user's approval, so none of them is yours to do.

Any later edit to the plugin folder un-trusts it until the user promotes it again. Say so when you change a live plugin.
