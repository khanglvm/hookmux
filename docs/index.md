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

## Get started

Run `npx hookmux init` to wire your agents. Then write your own plugins, or install ones other people published.

A plugin is shared as a public GitHub repository. This line sets hookmux up if needed, adds the plugins in that repository and asks you to approve each one:

```sh
npx -y hookmux install <github-username>/<repo-name>
```

When the plugin sits in a folder inside the repository, add the folder's path: `<github-username>/<repo-name>/<path>`, for example `khanglvm/hookmux/plugins/hookmux-authoring`. The repository's GitHub link works too. A plugin stays off until you say yes. [Example: install a plugin and see how it works](example.md) walks through installing a real plugin and reading its file.

To write your own, `hookmux new` starts a plugin from a template; [Write your first plugin](quickstart.md) walks through one.

## Where to go next

| You want to                                    | Read                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Install hookmux                                | [Install](install.md)                                            |
| See a real plugin installed and explained      | [Example](example.md)                                            |
| Build and run a first plugin                   | [Write your first plugin](quickstart.md)                         |
| Understand how a plugin decides                | [How plugins decide](how-plugins-decide.md)                      |
| Use plugins other people wrote, or share yours | [Install and share plugins](plugin-sources.md)                   |
| Test a plugin before you turn it on            | [Test a plugin](testing.md)                                      |
| See which agents are supported                 | [Supported agents](hosts.md)                                     |
| Know what hookmux does to protect you          | [Safety and approvals](safety.md)                                |
| Look up a command or a manifest key            | [Command reference](cli.md), [plugin.toml reference](plugins.md) |
| Let a coding agent do the work                 | [Use hookmux with coding agents](agents.md)                      |
