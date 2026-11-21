# hookmux

hookmux lets you write a hook for coding agents once, as a small plugin, and run it in Claude Code, Codex, Gemini CLI, Qwen Code, Factory Droid, Qoder CLI, CodeBuddy Code and opencode. It is for people who use more than one agent, or who maintain a hook and want it to work in all of them.

A hook is a command an agent runs at fixed moments: when you send a prompt, when a session starts, and before or after the agent uses a tool. What the command prints back can add a note to what the agent reads, stop the prompt or the tool call, or show you a message.

hookmux takes that hook slot once in each agent and runs your plugins inside it. A plugin is a folder with a `plugin.toml` file that says when it fires and what it does. Adding, changing or removing a plugin never touches an agent's config again.

## What you can do with it

- Stop a prompt that contains an API key before it reaches the model.
- Refuse a `git push --force` or an `rm -rf` the agent is about to run.
- Remind the agent of a project's rules whenever a session starts in that folder.
- Point the agent at a skill or a doc when a prompt asks for a certain kind of work, such as "redesign the pricing page".
- Tell the agent to run the tests after it edits a file.
- Run your own script and pass what it prints to the agent, such as the current git branch.

Plugins decide with checks: words, regular expressions, the tool being called, the working folder, your own scripts, or an optional small model. Rules-only plugins run in-process in about a millisecond.

## Where to go next

| You want to                                    | Read                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Install hookmux                                | [Install](install.md)                                            |
| Build and run a first plugin                   | [Write your first plugin](quickstart.md)                         |
| Understand how a plugin decides                | [How plugins decide](how-plugins-decide.md)                      |
| Use plugins other people wrote, or share yours | [Install and share plugins](plugin-sources.md)                   |
| Test a plugin before you turn it on            | [Test a plugin](testing.md)                                      |
| See which agents are supported                 | [Supported agents](hosts.md)                                     |
| Know what hookmux does to protect you          | [Safety and approvals](safety.md)                                |
| Look up a command or a manifest key            | [Command reference](cli.md), [plugin.toml reference](plugins.md) |
| Let a coding agent do the work                 | [Use hookmux with coding agents](agents.md)                      |
