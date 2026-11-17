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

- The launcher is a few lines of POSIX shell. When Node or the engine is missing, it reads stdin and exits.
- The engine has its own deadline, well under the clients' timeouts. Checks still running when it passes become unknown, and the engine answers anyway. A hub that hit the client's timeout would lose every plugin's output, so it stops itself first.
- Stdout is written before logging and bookkeeping, so neither can delay or change what the client receives.
- An unknown signal never blocks. A guard plugin can opt into failing closed with `on_error = "block"`.

## Rules decide blocks

Small models misread prompts. By default a block needs a check that is not model-backed to be true, so a model alone cannot discard your prompt. Model output never becomes free text in the agent's context either: templates can quote evidence only from rule checks.

## Trust is a checkpoint

`hookmux promote` records a hash of the plugin folder, and the engine skips any plugin whose folder no longer matches. Promote runs only on an interactive terminal, so an agent can write, test and stage a plugin in shadow mode, but making it live takes the user.

This does not sandbox anything. An agent with full shell access as you could edit the trust file directly. What the checkpoint stops is an agent that follows an injected instruction and quietly adds code that runs on every prompt.

## Adapters absorb host differences

Plugins name canonical events (`prompt.submit`, `tool.before`) and effects (`inject`, `block`, `notify`). Each adapter maps them to its client and declares which effects the client can perform on each event. When a client cannot do something, the engine falls back where it can: a block becomes a notice where the client cannot block. Otherwise it drops the effect and records why.

When a plugin does need to know the client, it can branch with a `host` check or override parts of itself in a `[host.<id>]` table. Both use the same merge rules as user overrides, so there is one mechanism to learn.

## Private by default

The decision log is off until you turn it on, and it stores a hash and the length of each prompt rather than the text unless you ask for prompts too. hookmux collects no telemetry.

## Not built yet

The original design also covered wrapping existing hooks as plugins, session state shared between plugins, project-scoped plugins with a lockfile, and replaying logged prompts against changed plugins. This version has none of them.
