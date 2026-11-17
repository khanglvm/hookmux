# Plugin reference

A hookmux plugin is a folder with a `plugin.toml` manifest and, usually, a `tests.toml` with test prompts. The engine reads manifests when you add or promote a plugin, or when its saved registry is out of date. It never parses TOML while it evaluates a prompt. `hookmux schema --json` prints what the installed engine accepts, and it wins when it disagrees with this page.

## Folder layout

```
my-plugin/
  plugin.toml   # required
  tests.toml    # optional, used by `hookmux test`
```

- The folder name must equal the manifest `id`.
- `plugin.toml` must be 256 KiB or smaller, owned by you, and not writable by group or others (`chmod go-w`).
- A plugin folder may not contain symlinks, and it holds at most 200 files and 4 MiB.

## A complete example

```toml
schema = 1
id = "changelog-reminder"
version = "1.0.0"
description = "Remind the agent to update the changelog when a prompt mentions a release."
events = ["prompt.submit"]
phase = "route"
dedupe = "session"
when = "mentions_release and not is_question"

[checks.mentions_release]
kind = "keywords"
words = ["release", "ship it", "cut a version"]

[checks.is_question]
kind = "regex"
patterns = ['^\s*(what|why|how|when)\b']

[[then]]
effect = "inject"
text = "This prompt mentions a release. Update CHANGELOG.md as part of the change."
```

TOML literal strings (`'...'`) keep regular expressions readable, because backslashes stay as written.

## Manifest keys

| Key                | Type           | Default    | Meaning                                                                                        |
| ------------------ | -------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `schema`           | integer        | required   | Manifest format. Must be `1`.                                                                  |
| `id`               | string         | required   | Lowercase letters, digits and dashes, up to 64 characters. Must match the folder name.         |
| `version`          | string         | `"0.0.0"`  | The plugin's own version.                                                                      |
| `description`      | string         | `""`       | One line shown by `hookmux list`.                                                              |
| `events`           | list           | required   | Canonical events the plugin listens to (see [Events](#events)).                                |
| `hosts`            | list           | every host | Host ids the plugin is limited to, such as `["claude-code"]`.                                  |
| `phase`            | string         | `"route"`  | `guard`, `route`, `enrich` or `observe` (see [Phases and order](#phases-and-order)).           |
| `priority`         | integer        | `100`      | Lower runs earlier within a phase.                                                             |
| `enabled`          | boolean        | `true`     | `false` turns the plugin off.                                                                  |
| `shadow`           | boolean        | `false`    | Evaluate and log, but add nothing to the output.                                               |
| `origins`          | list           | see below  | Prompt origins the plugin runs on: `user`, `system`, `unknown`.                                |
| `dedupe`           | string         | `"none"`   | `"session"` fires the plugin at most once per session.                                         |
| `exclusive`        | string         | none       | Group name. Of the plugins in one group that fire, only the first in output order contributes. |
| `on_error`         | string         | `"open"`   | Only `"open"` is accepted, and it changes nothing: hookmux always fails open.                  |
| `when`             | string         | required   | Expression over the plugin's checks that decides whether it fires.                             |
| `when_degraded`    | string         | none       | Fallback expression, used when `when` stays unknown.                                           |
| `params`           | table          | `{}`       | Strings, numbers or booleans for templates, stored as strings.                                 |
| `checks`           | table          | `{}`       | Named checks, one `[checks.<name>]` table each.                                                |
| `then`             | list of tables | required   | Effects, one `[[then]]` table each. At least one.                                              |
| `host`             | table          | none       | Per-host changes, one `[host.<id>]` table each.                                                |
| `requires_hookmux` | string         | none       | Accepted, but this version does not check it.                                                  |

The default for `origins` depends on the phase. Guard plugins run on every origin. Every other phase uses the `route_origins` setting, which defaults to `["user"]`, so background-task notifications never trigger a suggestion. The engine ignores unknown keys and reports each as a warning.

## Events

| Event           | When it fires                           | Text a check can read     |
| --------------- | --------------------------------------- | ------------------------- |
| `prompt.submit` | The user sends a prompt                 | `prompt`                  |
| `session.start` | A session starts, resumes or is cleared | none                      |
| `tool.before`   | Before a tool call                      | `tool.name`, `tool.input` |
| `tool.after`    | After a tool call                       | `tool.name`, `tool.input` |

`cwd` is available on every event. Pattern checks pick their text with `field`: `prompt` (the default), `cwd`, `tool.name`, `tool.input` (the whole input as JSON) or a path into it such as `tool.input.command`. Each host adapter maps these names to its client's own hook names, and `hookmux schema --json` lists the mapping.

## Checks

Each check has a lowercase snake_case name and a `kind`:

```toml
[checks.secret_shape]
kind = "regex"
patterns = ['AKIA[0-9A-Z]{16}', 'ghp_[A-Za-z0-9]{36}']
```

A check returns true, false or unknown. Score checks return a number from 0 to 1, which `when` must compare (`fit >= 0.7`). Unknown means the check errored, ran out of time, or could not tell, such as a host version range when the host reports no version.

Kinds have a cost tier. The engine runs tier 0 checks for every plugin first and stops as soon as each plugin's `when` is decided, so a subprocess or model check runs only when its answer could still change the result. By default a model-backed kind cannot justify a block on its own, and its output never reaches a template.

These are the kinds in this version. The authoring skill's `references/check-kinds.md` lists each kind's options.

<!-- check-kinds:begin -->
<!-- Generated by scripts/gen-skill-refs.ts from src/checks. Do not edit; run `pnpm gen:refs`. -->
| Kind           | Tier           | Model-backed | What it does                                                                                                                          |
| -------------- | -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `classify`     | 2 (model call) | yes          | Score from 0 to 1 that the field is the target label, decided by a configured model provider.                                         |
| `cwd_glob`     | 0 (in-process) | no           | True when the working folder matches one of the globs.                                                                                |
| `host`         | 0 (in-process) | no           | True when the agent client matches: its id, a version range, or the effects it supports on this event. Unknown version gives unknown. |
| `keywords`     | 0 (in-process) | no           | True when any (or all) of the words appear as whole words, case-insensitive by default.                                               |
| `origin`       | 0 (in-process) | no           | True when the prompt origin is one of the listed values.                                                                              |
| `path_exists`  | 0 (in-process) | no           | True when any (or all) paths exist, relative to the working folder.                                                                   |
| `regex`        | 0 (in-process) | no           | True when any (or all) of the patterns match the field.                                                                               |
| `regex_groups` | 0 (in-process) | no           | Named groups of patterns; true when every group in at least one fire_when combination matches.                                        |
| `script`       | 1 (subprocess) | no           | Runs an executable from the plugin folder; it reads the event as JSON on stdin and prints its value.                                  |
| `tool`         | 0 (in-process) | no           | True when the tool call names one of these tools (canonical or host name).                                                            |
<!-- check-kinds:end -->

Pattern checks cut their input to 8,000 characters before matching, and accept at most 200 patterns of up to 300 characters each. A pattern that repeats a group which already repeats, such as `(a+)+` or `(\w+\s?)+`, is rejected, because it can take exponential time on some input. The check is a heuristic; the launcher's watchdog is what stops a hook run that hangs. Flags default to `iu` (case-insensitive, Unicode). JavaScript's `\b` only knows ASCII letters, so put it next to ASCII characters only; the `keywords` kind handles word edges for any script.

## Effects

<!-- effects:begin -->
<!-- Generated by scripts/gen-skill-refs.ts from its effect table. Do not edit; run `pnpm gen:refs`. -->
| Effect   | Fields                                                                   | Behaviour                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inject` | `text`                                                                   | Adds the text to the agent's context. Dropped when the host cannot add context on this event or the context budget is used up.                                                                                                                                                        |
| `block`  | `reason`, `suppress_original_prompt` (prompt.submit only, default false) | Stops the prompt or tool call and shows the reason. The first block in output order wins. With `block_requires_rule` on (the default), a check that is not model-backed must be true. Where the host cannot block, it becomes a notice; where it cannot notify either, it is dropped. |
| `notify` | `text`                                                                   | Shows the text to the user, not the agent. Dropped when the host cannot notify on this event.                                                                                                                                                                                         |
<!-- effects:end -->

Effect text may be up to 4,000 characters and may use [templates](#templates).

```toml
[[then]]
effect = "block"
reason = "The prompt looks like it contains a credential. Remove it and send again."
suppress_original_prompt = true
```

## When expressions

`when` combines check names with `and`, `or`, `not`, parentheses, and the literals `true` and `false`. Score checks appear only in comparisons: `<`, `<=`, `>`, `>=`, `==`, `!=` against a number. `not` binds tightest, then `and`, then `or`. An expression is at most 2,000 characters, and validation rejects names that are not declared checks.

Evaluation uses three-valued logic, so an unknown signal only matters when it could change the answer:

| Expression          | Result  |
| ------------------- | ------- |
| `false and unknown` | false   |
| `true and unknown`  | unknown |
| `true or unknown`   | true    |
| `false or unknown`  | unknown |
| `not unknown`       | unknown |

This is also why the order of terms does not matter. `cheap and costly` and `costly and cheap` both skip `costly` when `cheap` is false.

When `when` is true the plugin fires, and when it is false the plugin stays silent. When it stays unknown, the engine evaluates `when_degraded`. If that is unknown too, or missing, the plugin contributes nothing. A failed check never makes a plugin fire, so an error can never block the agent. A plugin that adds a model check should set `when_degraded` to a rules-only expression, or to `"false"` to stay quiet when the model is unavailable.

All checks share one deadline, `deadline_ms` (2,000 ms by default). Checks still running at the deadline become unknown. The launcher stops any hook run after 5 seconds and passes nothing on, so keep `deadline_ms` well under that; a longer deadline only lets a slow check end the run with no output.

## Phases and order

| Phase     | Typical use                                                     |
| --------- | --------------------------------------------------------------- |
| `guard`   | Stop a prompt or tool call. Runs on every origin by default.    |
| `route`   | Suggest a skill or a next step.                                 |
| `enrich`  | Always-on context.                                              |
| `observe` | Last in output order. This version gives it no other behaviour. |

Output order is phase (in the order above), then `priority` (lower first), then `id`. In this version the phase sets output order and the default origins. It does not limit which effects a plugin may use.

How plugins that fire together combine:

- The first block in output order wins, and the host shows the block in place of any added context.
- In an `exclusive` group, the first plugin in output order takes the group, and later ones in the same group are dropped.
- Injected text is joined in output order. The total is capped by the `context_budget` setting (9,000 characters by default) and by the host's own limit, whichever is lower. Text that does not fit is dropped whole.
- A `shadow` plugin is evaluated and logged, and contributes nothing.
- With `dedupe = "session"`, a plugin that fired once is skipped for the rest of that session.

## Per-host tables

A `[host.<id>]` table changes the plugin for one client. It uses the same keys as the manifest and merges over it:

```toml
[[then]]
effect = "inject"
text = "Load the `moodboard` skill and start at its first step."

[host.codex]
then = [{ effect = "inject", text = "Use the `moodboard` skill for this request." }]
```

Tables merge key by key, and lists and plain values replace the base value. A table for a host id this engine has no adapter for is ignored with a warning, so a plugin written for a future adapter still loads. To branch inside `when` instead, use a `host` check.

## Overrides in ~/.hookmux/config.toml

You can change an installed plugin without editing its files. An `[override.<id>]` table takes the same keys as the manifest:

```toml
[override.moodboard]
priority = 20
shadow = true

[override.hookmux-authoring]
enabled = false

[override.moodboard.host.codex]
enabled = false
```

Merge order, lowest first: the plugin, its `[host.<id>]` table, your override, then your override's `host.<id>` table.

The same file holds hub settings and model providers:

```toml
[settings]
deadline_ms = 2000              # 50 to 20000
block_requires_rule = true      # a block needs a true check that is not model-backed
route_origins = ["user"]        # default origins for plugins outside the guard phase
context_budget = 9000           # characters of injected context per event
auto_trust_declarative = false  # see Trust below

[providers.fast]
kind = "..."                    # provider kind, used by model-backed checks
url = "http://127.0.0.1:8090"
model = "..."
timeout_ms = 300
api_key_env = "MY_PROVIDER_KEY" # name of an environment variable; the key is never stored
```

`hookmux doctor` reports an invalid config file. Until you fix it, the hook keeps running on default settings.

## Templates

Effect text can use these placeholders:

| Placeholder                   | Value                                                       |
| ----------------------------- | ----------------------------------------------------------- |
| `{params.<key>}`              | A value from `[params]`                                     |
| `{host.id}`, `{host.name}`    | The calling client, such as `claude-code` and `Claude Code` |
| `{host.version}`              | The client version, or `unknown`                            |
| `{event.name}`, `{event.cwd}` | The canonical event and the working folder                  |
| `{evidence.<check>}`          | The text a check matched, cut to 80 characters              |

`{evidence.<check>}` is empty for model-backed checks, so model output never becomes text in the agent's context. It is also empty for a check that matched nothing or does not exist. Any other placeholder with an unknown key stays as written.

## Tests

`tests.toml` lists prompts and the outcome each should have:

```toml
[[case]]
prompt = "redesign the pricing page so it feels more premium"
expect = "fire"

[[case]]
prompt = "fix the crash on the settings screen"
expect = "silent"
```

`hookmux test` runs them. Write both kinds of case, in each language you write prompts in, and include the near misses you worry about.

`hookmux test` runs a plugin's scripts only once it is promoted. For a folder, or an installed plugin nobody promoted yet, script checks give unknown and their cases count as skipped. Pass `--run-scripts` to run them, which executes the scripts on disk as they are now. `hookmux explain --all` follows the same rule for unpromoted plugins.

A script runs from a private copy of the bytes that matched its hash, in `~/.hookmux/cache/scripts`, so `$0` is not inside the plugin folder. Find files next to the script through `$HOOKMUX_PLUGIN_DIR`.

## Trust

`hookmux promote <id>` records a SHA-256 hash of the plugin folder and the capabilities it has with your `config.toml` overrides applied. If any file in the folder changes afterwards, or an override adds a capability (an event, a block effect, a script or model check), the plugin stops running until you promote it again.

Promote asks you to type `y` and never takes `--yes`. It refuses when stdin is not a terminal, and when it finds the environment variables Claude Code, Codex or Gemini CLI set on the commands they run, even on a terminal. That is a checkpoint against an agent activating a plugin because of an injected instruction or by accident. It is not a sandbox: a process running as you can still edit `trust.json` or clear its environment.

With `auto_trust_declarative = true`, plugins whose effects are only inject or notify and that run no scripts are trusted without promote. Plugins that block or run a script always need it.
