# Contributing

## Set up

You need Node.js 22 or later and pnpm 12, the version pinned in `package.json` under `packageManager`.

```sh
git clone https://github.com/khanglvm/hookmux.git
cd hookmux
pnpm install
```

`pnpm-workspace.yaml` holds back any dependency version published less than a week ago, so a brand-new release of a dev tool will not install until it is seven days old.

## Checks

| Command          | What it runs                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`      | Biome lint and format check (`pnpm format` fixes formatting)                                                              |
| `pnpm typecheck` | TypeScript, no emit                                                                                                       |
| `pnpm test`      | `node --test` over `test/**/*.test.ts`                                                                                    |
| `pnpm build`     | Regenerates the skill references and doc tables, then bundles `dist/`                                                     |
| `pnpm smoke`     | Installs the built engine into a temporary `HOOKMUX_HOME` and pipes payloads through the launcher; run `pnpm build` first |
| `pnpm check`     | Lint, typecheck, test and build in that order                                                                             |

CI runs these on Linux and macOS with Node 22, 24 and 26. It also checks the contents of the npm package and keeps `dist/` under 300 KB.

`pnpm build` rewrites `skills/hookmux/references/`, the host table in `README.md` and the tables in `docs/plugins.md` and `docs/hosts.md` from the engine's registries. Commit those files with your change. CI fails when they differ from a fresh build.

## Commit messages

Releases are cut by release-please from the commit history on `main`, so commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add a glob option to the tool check` for a feature (minor version)
- `fix: keep the launcher silent when stdin is closed` for a bug fix (patch version)
- `feat!: rename the session.start event` or a `BREAKING CHANGE:` footer for a breaking change
- `docs:`, `test:`, `ci:`, `chore:` and `refactor:` for changes that do not ship a release on their own

Write the subject in the imperative, and use the body to say why the change is needed.

## Add a check kind

1. Create a file in `src/checks/` that calls `registerCheck` with the kind's `kind`, `summary`, `options`, `tier` (0 in-process, 1 subprocess, 2 model call), `output` (`bool` or `score`), `modelBacked`, `validate` and `run`. `src/checks/rules.ts` is a short example.
2. `validate` returns a list of problems and never throws. `run` returns a signal and may throw; the engine turns a throw or a timeout into an unknown signal.
3. Import the file from `src/checks/index.ts`.
4. Add tests under `test/`.
5. Run `pnpm build`. The new kind appears in `skills/hookmux/references/check-kinds.md` and in `docs/plugins.md`.

A model-backed kind sets `modelBacked: true`. The engine then keeps it from justifying a block alone and keeps its evidence out of templates.

## Add a host adapter

1. Create a module in `src/hosts/` that implements `HostAdapter` from `src/hosts/types.ts`: native event names, supported effects per event, the context limit, `parse`, `render`, `sample` and the config editor. `src/hosts/claude-code.ts` is the reference, and `src/hosts/json-config.ts` edits the JSON hook config shape the current clients share.
2. `render` must return an empty string for a result with nothing to say, because that is the safe no-op on every client.
3. Add the adapter to `ADAPTERS` in `src/hosts/index.ts`.
4. Add the id to `KNOWN_HOSTS` in `src/load/snapshot.ts`, so `[host.<id>]` tables for it are not ignored.
5. Declare every feature in `features` (the ids are in `src/core/features.ts`). Write yes or no only where the client's docs or source say so, and put the citation in a comment beside the cell. Use null when they are silent. Leave out a cell that is derived: a feature about an effect the client cannot perform on that event is always no.
6. Add tests with payloads in the client's real format and the exact output expected for each.
7. Run `pnpm build` to regenerate the host tables, and add a section to `docs/hosts.md`. Say whether the adapter was run against the real client.

## Plugins and examples

Bundled plugins live in `plugins/` and examples in `examples/`. Each needs a `tests.toml` with cases that should fire and cases that should stay silent; `test/plugins.test.ts` runs them all.

## Reporting security problems

See [SECURITY.md](SECURITY.md). Please report them privately, not in an issue.
