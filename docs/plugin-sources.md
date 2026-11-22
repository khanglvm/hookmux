# Install and share plugins

`hookmux add` installs plugins from a local folder or a git repository. If you maintain a hook, the same command lets other people install yours.

## Install plugins other people wrote

Plugins are shared as GitHub repositories, the way agent skills are. Pass the repository as `owner/repo` or as its GitHub link. For example, with the example plugin [khanglvm/hookmux-no-force-push](https://github.com/khanglvm/hookmux-no-force-push):

```sh
hookmux add khanglvm/hookmux-no-force-push --list   # see what the repository contains
hookmux add khanglvm/hookmux-no-force-push          # install its plugins
hookmux promote no-force-push                      # approve each one you want on
```

`add` finds plugins at the repository root and under `plugins/`, `hookmux/` and `skills/*/hookmux/`. Other sources are a full https or SSH git URL, a `@ref` suffix for a branch or tag, and a GitHub `tree/<ref>/<path>` link. Installed plugins stay untrusted until you promote them. Use `--plugin <id>` to install only some of a repository's plugins, and `--shadow` to install one that runs and is logged but adds nothing.

Read a plugin's `plugin.toml` before you promote it. `promote` also lists what the plugin can do and which files it covers.

## Install a plugin someone sent you

A plugin author may send you one line to run, or a sentence to paste to your coding agent. Both do the same three things: set up hookmux if you do not have it yet, copy the plugin onto your machine and ask whether to turn it on. The plugin stays off until you say yes.

```sh
npx -y hookmux install khanglvm/hookmux-no-force-push
```

Replace `khanglvm/hookmux-no-force-push` with the plugin's repository, as `owner/repo` or the full GitHub link (`https://github.com/khanglvm/hookmux-no-force-push`). `npx` runs hookmux from npm without installing it first. It needs Node.js 22 or later. If you paste the line to your agent, the agent runs the command and shows you what it prints, but it cannot answer for you.

What it prints is a card. It names the plugin, says where it came from, how often it runs and what it can do. Each thing it can do carries a risk word:

- `high` means it can run code as you or stop your work: it runs a script, or it can stop a tool call or discard your prompt.
- `medium` means it reaches further than reading: it adds text the agent reads and may follow, sends your prompt or tool details to your model provider, or passes an environment variable to its script.
- `low` means it only shows you a message.

Approve a `high` line only when you trust where the plugin came from.

You answer in one of two ways:

- At your own terminal, `hookmux install` shows the card and asks you to type `y`.
- When your agent runs it, the agent shows you the card and a four-character code. Reply with `approve K7Q2` (using your code) in your next message. hookmux sees your reply and tells the agent to finish.

[Safety](safety.md) says what each of these proves and what it does not.

To turn an installed plugin off later but keep its files, run `hookmux disable <id>`, for example `hookmux disable no-force-push`. To delete the plugin from your machine, run `hookmux remove <id>`. The id is the name after `hookmux plugin:` on the first line of the card.

## Share a plugin you wrote

If you maintain a hook for one agent, publishing it as a hookmux plugin lets it run in every agent hookmux supports. You describe when it fires and what it does; hookmux handles each agent's config file, payload and output format.

Logic that needs code goes in a script check. hookmux runs the script from your plugin folder, in the agent's working folder, with the event as JSON on stdin. The script answers with exit code 0 (true) or 1 (false), or prints `{"value": true, "evidence": "..."}`, and effect text can quote the evidence with `{evidence.<check>}`.

This plugin tells the agent which git branch it is on when a session starts:

```toml
# branch-note/plugin.toml
schema = 1
id = "branch-note"
events = ["session.start"]
phase = "enrich"
origins = ["unknown"]
when = "on_branch"

[checks.on_branch]
kind = "script"
command = "branch.sh"

[[then]]
effect = "inject"
text = "You are on the git branch {evidence.on_branch}."
```

```sh
#!/bin/sh
# branch-note/branch.sh: exit 1 (false) outside a git checkout.
branch=$(git branch --show-current 2>/dev/null)
[ -n "$branch" ] || exit 1
printf '{"value": true, "evidence": "%s"}\n' "$branch"
```

To ship the branch-note plugin (the [no-force-push](https://github.com/khanglvm/hookmux-no-force-push) repository is a finished example to copy):

1. Add a `tests.toml` with cases that should fire and cases that should stay silent, and run `hookmux test ./branch-note --run-scripts`.
2. Run `hookmux validate ./branch-note` to check the manifest.
3. Push the folder to a git repository. People install it with `hookmux add you/your-repo` and approve it with `hookmux promote branch-note`.

The [plugin.toml reference](plugins.md) lists every manifest key, check kind, effect and template placeholder. `hookmux schema --json` prints the same data for tools. [Test a plugin](testing.md) explains the test cases.
