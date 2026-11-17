# Host notes

Each agent client has one adapter module in `src/hosts/`. It turns the client's hook payload into a hookmux event, renders the result in the client's output format, and edits the client's hook config. Plugins never see these formats. The README table, generated from the adapters, lists the effects each client supports on each event, and `hookmux schema --json` also gives the native event names. This page covers the behaviour those tables leave out.

On every client, hookmux adds its hub entries after your existing hook groups and finds them again by the launcher path. Your own hooks are left as they are.

## Claude Code (`claude-code`)

Written from the Claude Code hooks reference and covered by the test suite.

- Config file: `~/.claude/settings.json`, or `settings.json` in `$CLAUDE_CONFIG_DIR` when that is set. Timeouts are in seconds.
- Events: `prompt.submit` is `UserPromptSubmit`, `session.start` is `SessionStart`, `tool.before` is `PreToolUse` and `tool.after` is `PostToolUse`.
- Added context goes in `hookSpecificOutput.additionalContext`, up to 10,000 characters.
- A block on a prompt or after a tool call is `decision: "block"` with a `reason`. On a prompt, `suppress_original_prompt` also hides what the user typed. A block before a tool call is a `deny` permission decision with the reason.
- A notice is a `systemMessage`, which the user sees and the agent does not.
- `session.start` cannot block.
- Background-task notifications arrive as prompts that start with `<task-notification>`. hookmux gives them origin `system`, so route plugins skip them. Claude Code does not document this wrapper; it comes from observed payloads.
- The payload carries no client version, so a `host` check with a `version` range is unknown on Claude Code.
- Tool names are Claude Code's own (`Bash`, `Write`, `Edit`, `Read` and so on).

## Codex (`codex`)

Written from the Codex source at `codex-cli` 0.167.1 and its hooks documentation. Not yet run against a live client.

- Config file: `~/.codex/hooks.json`. Its top level may hold only `description` and `hooks`, and any other key makes Codex skip the whole file. Timeouts are in seconds.
- Codex runs a new or changed hook only after you approve it in its `/hooks` screen. It keys each approval by the file path and the entry's position, and a change to the command, matcher or timeout makes the entry count as changed. Appending after your entries keeps your approvals valid, and every change to the hub entries needs one new approval.
- Codex rejects output with unknown keys, and `hookSpecificOutput.hookEventName` must name the event.
- A blocked prompt is not recorded in the conversation history.
- Before a tool call, Codex can deny but cannot ask the user. Shell commands arrive as `Bash` and file edits as `apply_patch`, both with the text in `tool_input.command`, so there is no `file_path` to match on.
- A block after a tool call replaces the tool's result with the reason. The tool has already run.
- Context longer than about 2,500 tokens is saved to a file, and the model sees a preview and the file path.

## Gemini CLI (`gemini-cli`)

Written from the Gemini CLI source at v0.68.0 and its hooks documentation. Not yet run against a live client.

- Config file: `~/.gemini/settings.json`. Timeouts are in milliseconds.
- Events: `prompt.submit` is `BeforeAgent`, `session.start` is `SessionStart`, `tool.before` is `BeforeTool` and `tool.after` is `AfterTool`.
- Gemini CLI reads stdout as JSON, and when stdout is empty it parses stderr instead. The launcher discards stderr so that an engine error can never be read as hook output.
- A block on a prompt discards the prompt, so it is not added to the history.
- Added context has `<` and `>` escaped and is wrapped in `<hook_context>` tags, so markup in injected text does not survive.
- `SessionStart` cannot block, and its added context is dropped on `/clear`. Context added before a tool call is ignored.
- In a folder the user has not trusted, Gemini CLI turns off all hooks, including user-level ones.
- Tool names differ from Claude Code's: `run_shell_command`, `write_file`, `replace` (edit) and `read_file`. MCP tools are named `mcp_<server>_<tool>`.
