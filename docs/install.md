# Install hookmux

hookmux needs Node.js 22 or later. It is published on npm as [`hookmux`](https://www.npmjs.com/package/hookmux).

## Install from npm

```sh
npx hookmux init
```

Or install the CLI globally, so `hookmux` is on your `PATH` for later commands:

```sh
npm i -g hookmux
hookmux init
```

`init` copies the engine into `~/.hookmux`, writes a launcher script there, and asks which agents to wire. Your existing hooks stay as they are. It then offers to install the plugins that ship with hookmux and the authoring skill, which teaches your agent to write plugins. The agents run the local launcher, never `npx`, so a hook never waits on the network.

To update, install the new version (`npm i -g hookmux@latest`, or `npx hookmux@latest init`) and run `init` again. A re-run updates the engine and the agents it already wired.

To try hookmux with a ready plugin, install the example [no-force-push](https://github.com/khanglvm/hookmux-no-force-push) plugin. The command sets hookmux up if needed and asks you before it turns the plugin on:

```sh
npx -y hookmux install khanglvm/hookmux-no-force-push
```

## Install from source

Use this to try unreleased changes or to work on hookmux itself. You need Node.js 22 or later, git, and pnpm 12 (the version pinned in `package.json`).

1. Clone the repository and install its dependencies:

   ```sh
   git clone https://github.com/khanglvm/hookmux.git
   cd hookmux
   pnpm install
   ```

2. Build the CLI. This writes it to `dist/`:

   ```sh
   pnpm build
   ```

3. Run `init` with the built CLI:

   ```sh
   node dist/cli.mjs init
   ```

A source install puts no `hookmux` command on your `PATH`. Run commands as `node /path/to/hookmux/dist/cli.mjs <command>`, or add a shell alias:

```sh
alias hookmux='node /path/to/hookmux/dist/cli.mjs'
```

To update a source install, pull the latest changes, run `pnpm install` and `pnpm build` again, then run `init` again.

## Choose the agents

Run `init` in a terminal and it asks about each agent it detects. To skip the questions, pass the agents yourself:

```sh
hookmux init --host claude-code --host codex
hookmux init --yes
```

`--host <id>` wires one agent and can repeat. `--yes` wires every detected agent. Without a terminal, `init` needs one of the two. The agent ids are `claude-code`, `codex`, `gemini-cli`, `qwen-code`, `droid`, `qoder`, `codebuddy` and `opencode`; see [Supported agents](hosts.md). `--no-skill` and `--no-bundled` leave out the authoring skill and the bundled plugins.

## Check the install

```sh
hookmux doctor
```

`doctor` checks Node, the engine, the launcher, every agent you wired (including a real launcher run), your plugins and the log. Add `--fix` to let it repair what is safe to repair.

## Uninstall

```sh
hookmux uninstall
```

`uninstall` removes only hookmux's own hook entries and leaves your other hooks alone. Your plugins, config and logs stay in `~/.hookmux`. Add `--purge` to delete that folder too; it asks first unless you pass `--yes`. If you installed the CLI with npm, also run `npm uninstall -g hookmux`.
