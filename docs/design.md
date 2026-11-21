# Design notes

These notes explain why hookmux is built the way it is. The [plugin reference](plugins.md) describes what it does.

## One hub entry per event

Agent clients run hooks from their own config files, in three formats. Once you have several hooks across several clients, every new behaviour means editing each client's config and keeping the copies in sync.

hookmux registers one entry per event with each client, and everything else is a plugin folder. Adding, changing or reordering a plugin never touches a client's config. That matters most on Codex, which asks you to approve every new or changed hook entry: with one stable entry per event, you approve once.

## Plugins are data

A plugin is a TOML manifest: events, named checks, a `when` expression and effects. Check kinds register themselves from their own source files, so the engine never names a kind, and adding one is a new file in `src/checks/`. The engine validates a manifest when the plugin is added or promoted, or when the saved registry is out of date, and stores the result in `registry.json`. A hook run reads that snapshot and never loads the TOML parser.

## Cheapest check first

Checks have cost tiers: in-process, subprocess and model call. The engine evaluates the cheapest tier for every plugin first, using three-valued logic in which a check that has not run yet counts as unknown. A plugin whose `when` is already decided drops out, and a costlier check runs only when its answer could still change some plugin's result.

Kleene logic is monotone, which makes this safe: a result decided while some checks are unknown stays the same once they resolve. It also means plugin authors write logic only. `regex and model` costs the same as `model and regex`.

## Fail open

A hook that breaks the agent client is worse than no hook, so every failure path ends in empty output and exit code 0, which every client reads as "no opinion":

- The launcher is a short POSIX shell script. When Node or the engine is missing, it exits at once without reading stdin.
- The engine writes its answer to a private temp file, and the launcher prints it only when the engine exits 0, so a crash halfway through an answer prints nothing. A watchdog stops an engine still running after 5 seconds, for example one stuck on a backtracking regex.
- The engine has its own deadline, well under the clients' timeouts. Checks still running when it passes become unknown, and the engine answers anyway. A hub that hit the client's timeout would lose every plugin's output, so it stops itself first.
- Stdout is written before logging and bookkeeping, so neither can delay or change what the client receives.
- An unknown signal never blocks, and no setting changes that: `on_error = "block"` is rejected.

## Rules decide blocks

Small models misread prompts. By default a block needs a check that is not model-backed to be true, so a model alone cannot discard your prompt. Model output never becomes free text in the agent's context either: templates can quote evidence only from rule checks.

## Trust is a checkpoint

`hookmux promote` records a hash of the plugin folder and the capabilities the plugin has with the user's overrides, and the engine skips any plugin whose folder no longer matches or whose overrides add a capability. Promote runs only on an interactive terminal, refuses `--yes`, and refuses when an agent client's environment variables are present. An agent can write, test and stage a plugin in shadow mode, but making it live takes the user typing `y`. The one exception is a standing approval the user granted the same way (`promote --standing`): `hookmux add` then pins a new version of that plugin while its capabilities stay within the approved ones. An edit made in place under `plugins/` still un-trusts the plugin.

In Claude Code the user can approve without a terminal. When an agent's Bash call is exactly `hookmux promote <id>`, the hub returns an `ask` decision: the client shows the call and waits for the user. The hub adds a one-time grant to the command, bound to the plugin, the content hash and capabilities the user was shown, and the `--standing` flag. Only its hash is stored, and promote consumes it. In normal use the token reaches the agent only inside the call the user approved. An agent that feeds the hub launcher a made-up payload can read a token from its output; that is the same kind of bypass as the pseudo-terminal below, not something the grant prevents. The prompt is answered by whatever answers Claude Code's permission prompts: in an Agent SDK app that is the app's `canUseTool` callback, so an app that approves every call approves this one too.

A terminal is not proof of a person: an agent can open a pseudo-terminal and clear its environment. This does not sandbox anything, and an agent with full shell access as you could edit the trust file directly. What the checkpoint stops is an agent that follows an injected instruction, or a normal CLI call, and quietly turns on code that runs on every prompt. Previews follow the same line: `test` and `explain --all` leave an unpromoted plugin's scripts unrun unless the person passes `--run-scripts`.

## Adapters absorb host differences

Plugins name canonical events (`prompt.submit`, `tool.before`) and effects (`inject`, `block`, `notify`). Each adapter maps them to its client and declares which effects the client can perform on each event. When a client cannot do something, the engine falls back where it can: a block becomes a notice where the client cannot block. Otherwise it drops the effect and records why.

When a plugin does need to know the client, it can branch with a `host` check or override parts of itself in a `[host.<id>]` table. Both use the same merge rules as user overrides, so there is one mechanism to learn.

Supported effects are too coarse for some plugins. A block after a tool call exists on several clients, but the tool has already run, and the same inject can arrive with its `<` and `>` escaped. So each adapter also states a small fixed list of features per event, each yes, no or unknown, and the `host` check tests them with `features` and `lacks`. This works like CSS `@supports`: the plugin asks what the client does, not which client it is. Unknown is a real answer. An adapter writes yes or no only when it can cite the client's docs or source, and a check that needs an unknown feature is unknown, not false.

An effect can carry a `fallback` list too. It says what to do where the client cannot perform the effect, and the engine's default (a block becomes a notice, everything else is dropped) applies only when the list is absent. A fallback never adds a block, and a block dropped for lacking a rule never falls back. One function, `resolveEffect`, makes this decision for the hook (and so for `explain`, which runs the engine), `validate` and `test`, so the compatibility report cannot disagree with what the engine does.

## Private by default

The decision log is off until you turn it on, and it stores a hash and the length of each prompt rather than the text unless you ask for prompts too. hookmux collects no telemetry.

## Not built yet

The original design also covered wrapping existing hooks as plugins, session state shared between plugins, project-scoped plugins with a lockfile, and replaying logged prompts against changed plugins. This version has none of them.
