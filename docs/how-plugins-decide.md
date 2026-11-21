# How plugins decide

A plugin listens for an event, runs a few checks, and combines their answers with a `when` expression. If the expression is true, the plugin's effects run. This page explains each part; the [plugin.toml reference](plugins.md) lists every key.

## Events

hookmux uses four events, and each agent maps them to its own hook names.

| Event           | When it fires                           |
| --------------- | --------------------------------------- |
| `prompt.submit` | You send a prompt                       |
| `session.start` | A session starts, resumes or is cleared |
| `tool.before`   | Before the agent runs a tool            |
| `tool.after`    | After the agent runs a tool             |

A plugin lists the events it cares about in `events`. The working folder (`cwd`) is available on every event.

## Checks

A check is a named test of the event, written as a `[checks.<name>]` table with a `kind`. The built-in kinds are `keywords`, `regex`, `regex_groups`, `tool`, `cwd_glob`, `path_exists`, `origin`, `host`, `script` and `classify`. The `classify` kind asks a small model you configure; every other kind uses rules or your own script.

```toml
[checks.mentions_release]
kind = "keywords"
words = ["release", "ship it", "cut a version"]
```

A check answers true, false or unknown. Unknown means the check failed, ran out of time or could not tell. A check never makes a plugin fire by failing, so an error cannot block your agent.

hookmux runs the cheap checks first. Rules run in-process, scripts run as a subprocess, and model checks call out. A costlier check runs only when its answer could still change the result, so `regex and model` costs the same as `model and regex`. By default a model check cannot justify a block on its own.

## The when expression

`when` combines check names with `and`, `or`, `not` and parentheses:

```toml
when = "mentions_release and not is_question"
```

The plugin fires when `when` is true and stays silent when it is false. When it is unknown, hookmux tries `when_degraded` if you set one, and otherwise the plugin does nothing. A plugin that uses a model check should set `when_degraded` to a rules-only expression, or to `"false"` to stay quiet when the model is unavailable.

## Effects

When a plugin fires, its `[[then]]` tables run:

| Effect   | What it does                                       |
| -------- | -------------------------------------------------- |
| `inject` | Adds text to what the agent reads                  |
| `block`  | Stops the prompt or tool call and shows the reason |
| `notify` | Shows a message to you, not the agent              |

Not every agent can do every effect on every event. Where an agent cannot block, a block becomes a notice unless you pick another fallback with `fallback`. The [Supported agents](hosts.md) page and the [plugin.toml reference](plugins.md#effects) cover the details.

## Phases and order

Every plugin has a phase: `guard` to stop something, `route` to suggest a skill or a next step (the default), `enrich` for context added every time, and `observe`. Plugins are combined in that order, then by `priority` (lower first), then by `id`.

When several plugins fire on the same event:

- The first block wins.
- Injected text is joined in order and capped by a context budget. Text that does not fit is dropped whole.
- Plugins in the same `exclusive` group contribute only once.
- A plugin with `shadow = true` is evaluated and logged but adds nothing.

## Before it runs

A plugin does nothing until you approve it with `hookmux promote`. See [Safety and approvals](safety.md).
