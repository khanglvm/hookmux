# Test a plugin

You can check a plugin without opening an agent: `validate` checks the manifest, `test` runs your test cases, and `explain` shows what every plugin decides for one prompt.

## Write test cases

`tests.toml` sits next to `plugin.toml`. Each `[[case]]` is a prompt and the outcome you expect:

```toml
[[case]]
prompt = "redesign the pricing page so it feels more premium"
expect = "fire"

[[case]]
prompt = "fix the crash on the settings screen"
expect = "silent"
```

Write both kinds. Include the near misses you worry about, and write cases in each language you write prompts in. `hookmux new <id>` creates a starting `tests.toml`.

A case takes these keys:

| Key      | Meaning                                                             |
| -------- | ------------------------------------------------------------------- |
| `prompt` | The prompt text. Required for `prompt.submit`                       |
| `expect` | `"fire"` or `"silent"`                                              |
| `host`   | The agent to simulate. Default `"claude-code"`                      |
| `event`  | The event. Default `"prompt.submit"`                                |
| `cwd`    | The working folder the event reports. Default is the current folder |

## Run the checks

```sh
hookmux validate ./my-plugin
hookmux test ./my-plugin
hookmux explain "a prompt to try"
```

- `validate <path>` checks a plugin folder the way `add` would, and prints what each effect will do on each agent. It exits 1 when there are problems.
- `test [<id>|<path>]` runs the cases of one installed plugin or folder, or of every installed plugin when you pass nothing. It exits 1 when a case fails.
- `explain "<prompt>"` shows what every active plugin decides for the prompt and the exact output the agent would receive. It writes no state and no log. Use `--host` and `--event` to simulate another agent or event.

## Scripts and models

A plugin's scripts run only after you promote it. For a folder, or an installed plugin you have not promoted, script checks give unknown and their cases count as skipped. Pass `--run-scripts` to run them anyway, which executes the scripts on disk as they are now. `explain --all` includes unpromoted plugins, and needs `--run-scripts` as well to run their scripts.

Model checks return unknown in tests unless you pass `--live` to `hookmux test`.

## Try it on real prompts first

`hookmux add <dir> --shadow` installs a plugin that is evaluated and logged but adds nothing to what the agent sees. Turn the log on with `hookmux log on`, use your agent for a while, then read the runs with `hookmux log show --plugin <id>`. When the decisions look right, run `hookmux promote <id>`.
