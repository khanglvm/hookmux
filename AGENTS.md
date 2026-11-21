# hookmux

hookmux is a hook multiplexer for coding agents. It writes one command hook per event into each agent client's own hook config (Claude Code, Codex, Gemini CLI, Qwen Code, Factory Droid, Qoder CLI, CodeBuddy Code; `src/hosts/index.ts` lists them). When the client fires that hook, hookmux reads the event JSON on stdin, runs every installed plugin, and prints one combined answer in that client's output format. A plugin is a folder with a `plugin.toml`: the events it listens to, named checks, a `when` expression over the checks, and effects (`inject` context, `block`, `notify` the user). Plugin authors never see host formats.

## Request path

1. The client runs the launcher (`launcher/hookmux-hook.sh`, installed under `~/.hookmux`) with `--host <id> --event <canonical event>`.
2. `src/hook-main.ts` reads stdin, and the host adapter in `src/hosts/<id>.ts` turns the payload into a `HookEvent` (`src/core/types.ts`).
3. `src/core/engine.ts` evaluates plugins from the compiled snapshot (`registry.json`, built by `src/load/`), cheapest check tier first, with three-valued logic.
4. `src/core/compose.ts` merges the results; the adapter's `render` prints the client's JSON, or nothing.

Canonical events: `prompt.submit`, `session.start`, `tool.before`, `tool.after`. Each adapter maps them to native names and declares the effects it supports per event.

## Where things live

- `src/hosts/`: one adapter per client. `types.ts` is the contract, `json-config.ts` edits the shared `{ hooks: { Event: [ { hooks: [...] } ] } }` config shape, `codex-trust.ts` approves Codex hub entries. Clients that copied Claude Code's contract are built by `claude-style.ts` from a short spec of their differences; start there for a new one.
- `src/checks/`: check kinds; each file calls `registerCheck`. `src/providers/`: the OpenAI-compatible model client for model-backed checks.
- `src/commands/`: one file per CLI command; `src/cli.ts` dispatches.
- `src/install/`: `init`, `add`, staging and the launcher writer. `src/load/`: manifest parsing, trust pins, the registry snapshot.
- `plugins/`: bundled plugins. `examples/`: example plugins. `skills/hookmux/`: the authoring skill hookmux installs into each client.
- `docs/design.md` explains why; `docs/plugins.md` is the manifest reference; `docs/hosts.md` holds per-client behaviour. `CONTRIBUTING.md` has the steps to add a check kind or a host adapter.

## Invariants

- **Fail open.** Every error path ends in empty stdout and exit 0. `render` returns `""` when there is nothing to say.
- **Promote needs a person.** `hookmux promote` refuses agent environments and non-terminals; keep that guard when touching promote, grants or trust pins.
- **Append, never reorder** hub entries in a client config: Codex keys hook approval by position.
- **Blocks need a rule.** A model-backed check alone never justifies a block or supplies template evidence.

## Working here

- Run `pnpm check` (lint, typecheck, test, build) before you commit.
- `pnpm build` regenerates `skills/hookmux/references/`, the host table in `README.md` and the tables in `docs/plugins.md`. Commit them with the change; CI fails on drift. Edit the generators, not the marked blocks.
- Commit subjects follow Conventional Commits; release-please cuts releases from them.
- Each adapter cites the client source or docs it was written against (version and file:line). Keep that habit for new adapters, and say in `docs/hosts.md` whether it was run against the real client.
- A CodeGraph index lives in `.codegraph/` (git-ignored). Query it for symbols, callers and change impact before broad searches, e.g. `codegraph explore "<area or symbol>"`, `codegraph callers <symbol>` or `codegraph impact <symbol>`. In a fresh clone, build it with `codegraph init -y` (needs the `codegraph` CLI); without it, search with `rg`.
