# Example: install a plugin and see how it works

This walk-through installs a small published plugin, shows what you approve, and reads its one file line by line. The plugin, [no-force-push](https://github.com/khanglvm/hookmux-no-force-push), stops your agent from running `git push --force`. Every plugin works the same way; only the checks and effects change.

## Install it

Any published plugin installs with one line. Its source is the GitHub repository that holds it, in the form `<github-username>/<repo-name>`, plus `/<path>` when the plugin sits in a folder inside the repository:

```sh
npx -y hookmux install khanglvm/hookmux-no-force-push
```

The command sets hookmux up if it is not set up yet, downloads the plugin from GitHub and adds it switched off. It then shows a card that says what the plugin is and what it can do:

```text
hookmux plugin: no-force-push 0.1.0
From: github.com/khanglvm/hookmux-no-force-push @ ad5e168 (hookmux has not reviewed it)
Does: Blocks force pushes made through the shell tool.
Runs: Before every tool call · in-process checks only
Can:
  high    Can stop the agent's tool calls
```

Answer yes and the plugin is on. If you asked your coding agent to install it, the agent shows you the same card and asks you to reply with a short code; the plugin turns on only after your reply. [Safety and approvals](safety.md) explains both routes.

## Read the plugin

The whole plugin is one file, `plugin.toml`:

```toml
schema = 1
id = "no-force-push"
version = "0.1.0"
description = "Blocks force pushes made through the shell tool."
events = ["tool.before"]
phase = "guard"
when = "is_shell and risky_command"

[checks.is_shell]
kind = "tool"
names = ["Bash"]

[checks.risky_command]
kind = "regex"
field = "tool.input.command"
patterns = ['\bgit\s+push\b.*\s(--force|-f)(\s|$)']

[[then]]
effect = "block"
reason = "Force pushes can overwrite other people's commits. Push without --force, or ask the user first."
```

Read it in four parts:

1. **When it runs.** `events = ["tool.before"]` asks hookmux to run the plugin each time the agent is about to use a tool. `phase = "guard"` lets it see tool calls the agent starts on its own, not only the prompts you type.
2. **What it checks.** `is_shell` is true when the tool is the shell. `risky_command` is true when the command matches the force-push pattern. Both are rules, so they run inside hookmux in about a millisecond.
3. **When it fires.** `when = "is_shell and risky_command"` fires the plugin only when both checks are true.
4. **What it does.** The `block` effect stops the tool call, and the agent reads the `reason`, so it can push another way or ask you.

## See it work

Ask your agent to force-push a branch. Before the shell command runs, the agent calls its hook, and hookmux runs the plugin. Both checks are true, so hookmux answers with a block in that agent's own format. The push never runs, and the agent tells you why. Any other command passes, because `risky_command` is false.

The same file works in every supported agent. `Bash` is hookmux's shared name for the shell tool, so the check matches Gemini CLI's `run_shell_command` and the other agents' shell tools too.

To turn the plugin off, run `hookmux disable no-force-push`; to delete it, run `hookmux remove no-force-push`.

## Write your own

Start a plugin from a template with `hookmux new <plugin-id>`, then change its checks and effects. [Write your first plugin](quickstart.md) walks through one, and [Install and share plugins](plugin-sources.md) shows how to publish it so other people can install it with the same one line.
