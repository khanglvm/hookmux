# Architecture

## Overview

hookmux sits between agent clients and plugins. Each client runs one hookmux command per event; hookmux runs every installed plugin against the event and answers in that client's format.

```
agent client ──stdin JSON──▶ launcher (sh) ──▶ hook engine (Node)
                                                 │ adapter.parse → HookEvent
                                                 │ engine: plugins from registry.json
                                                 │ compose → HubResult
                                                 ▼ adapter.render
agent client ◀──stdout JSON (or nothing)─────────┘
```

The CLI (`hookmux init`, `add`, `promote`, `test` and the rest) manages the same state: it writes hub entries into client configs, stages and trusts plugins, and rebuilds the registry snapshot.

## Modules

- `launcher/hookmux-hook.sh`: POSIX shell entry point. Runs the engine under a watchdog and prints its answer only when the engine exits 0.
- `src/hook-main.ts`: one hook run. Reads stdin, picks the adapter, runs the engine, writes stdout, then logs.
- `src/hosts/`: one adapter per client (parse, render, sample payloads, config editor). `claude-style.ts` builds the clients that copied Claude Code's contract; `json-config.ts` edits their JSON configs; `codex-trust.ts` approves Codex hub entries; `opencode.ts` installs `launcher/opencode-plugin.js` as an opencode plugin instead of a config entry.
- `src/core/`: the engine (tiered, three-valued evaluation), the `when` expression parser, templates, and `compose.ts`, which merges plugin results and applies effect fallbacks.
- `src/checks/`: check kinds (`regex`, `keywords`, `tool`, `host`, `script`, `classify` and others). Each file registers itself.
- `src/providers/`: the OpenAI-compatible client behind model-backed checks, with a circuit breaker and call policy.
- `src/load/`: manifest parsing and validation, user overrides, trust pins, and the `registry.json` snapshot.
- `src/install/`: `init`, plugin sources and fetch, staging, the launcher writer and the authoring skill installer.
- `src/runtime/`: paths under `~/.hookmux`, state, grants, health, the decision log and process helpers.
- `src/commands/`: one file per CLI command; `src/cli.ts` dispatches.

## Data flow

1. `hookmux init` installs the engine under `~/.hookmux/engine/current`, writes the launcher, and appends one hub entry per canonical event to each detected client's config.
2. `hookmux add` stages a plugin; `hookmux promote` (a person, on a terminal or through Claude Code's permission prompt) pins its content hash and capabilities in the trust file. Both rebuild `registry.json`.
3. On a hook event the client runs `hookmux-hook --host <id> --event <canonical>`. The adapter turns the payload into a `HookEvent`, the engine evaluates trusted plugins from `registry.json` (in-process checks first, then subprocess, then model calls), and the adapter renders the combined result.

## Boundaries

- Agent client configs: written only by `init`, `sync` and `uninstall`, through each adapter's config editor. Hub entries are appended, never reordered.
- Model provider: any OpenAI-compatible endpoint the user configures; reached only by `classify` checks.
- Plugin scripts: run as subprocesses with a deadline; untrusted plugins never run them unless the person asks for a preview with `--run-scripts`.
- Release: release-please on `main` opens the release PR; merging it publishes to npm from `.github/workflows/release.yml` through trusted publishing.

## Decisions

The reasons behind these live in [docs/design.md](docs/design.md).

- 2026-11-17: one hub entry per event, so plugin changes never touch client configs and Codex approval happens once.
- 2026-11-17: fail open on every error path, with a shell launcher and a watchdog.
- 2026-11-17: a model-backed check alone never blocks; templates quote evidence only from rule checks.
- 2026-11-17: making a plugin live needs a person (`promote`).
- 2026-11-21: clients that copied Claude Code's hook contract share one adapter factory, `claude-style.ts`.
