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
- When an agent's Bash call is exactly `hookmux promote <id>` or `hookmux promote <id> --standing`, the hub answers with an `ask` permission decision, so Claude Code shows you the call and waits for your approval. The hub adds a one-time `--grant` to the command you approve, and promote accepts that grant in place of a terminal. Seen on Claude Code 2.1.327: the prompt appears under `bypassPermissions` too, and where no prompt can be shown (`claude -p`) the call is refused. A `PermissionRequest` hook that approves everything would answer the prompt for you, so leave this command out of it. The same goes for an Agent SDK app whose `canUseTool` approves every call. Going by Claude Code 2.1.327's own messages, auto mode does not run a call a hook rewrote, so the plugin stays off there; approve it from Manual mode.

## Codex (`codex`)

Written from the Codex source at `codex-cli` 0.167.1 and its hooks documentation. Not yet run against a live client.

- Config file: `~/.codex/hooks.json`. Its top level may hold only `description` and `hooks`, and any other key makes Codex skip the whole file. Timeouts are in seconds.
- Codex runs a new or changed hook only after you approve it in its `/hooks` screen. It keys each approval by the file path and the entry's position, and a change to the command, matcher or timeout makes the entry count as changed. Appending after your entries keeps your approvals valid. After it edits the file, hookmux asks `codex app-server` (tested with codex-cli 0.170.0) for the hook list and approves only entries whose command is exactly a hub command for its launcher, in this `hooks.json`, from the user layer. `hookmux doctor` asks Codex the same way, so an entry whose approved hash no longer matches shows as unapproved.
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

## Qwen Code (`qwen-code`)

Written from the Qwen Code hooks documentation at release 0.28.0 (`docs/users/features/hooks.md` in QwenLM/qwen-code). Not yet run against a live client.

- Config file: `~/.qwen/settings.json`, or `settings.json` in `$QWEN_HOME` when that is set. Timeouts are in seconds.
- Events and output keys match Claude Code's. A blocked prompt or tool result uses `decision: "block"` with a `reason`.
- `UserPromptSubmit` also fires for tool results and other follow-up sends, where `prompt` is text bound for the model. Qwen adds `submitted_prompt` only when someone submitted the prompt, so hookmux gives a prompt without it origin `system` and route plugins skip it. Prompts typed in Vim mode, and ACP clients that do not declare a submission, also lack the field and count as `system`. Checks still read `prompt`, which holds pasted text in full.
- Context added before a tool call is appended to that call's result. Qwen escapes `<` and `>` in added context.
- User hooks load whatever the folder's trust. `--safe-mode`, `--bare` and `disableAllHooks` turn all hooks off.
- Tool names: `run_shell_command`, `write_file`, `edit` and `read_file` map to `Bash`, `Write`, `Edit` and `Read`.

## Factory Droid (`droid`)

Written from the Factory Droid hooks reference for Droid CLI 1.16.0. Not yet run against a live client.

- Droid reads user hooks from two files in `~/.factory`: `hooks.json`, keyed directly by event name, and the `hooks` key of `settings.json`. An event in `hooks.json` replaces the same event in `settings.json`. hookmux adds an event to `settings.json` only when that file already has entries for it and `hooks.json` does not, and to `hooks.json` otherwise, so its entry never hides one of yours. Timeouts are in seconds.
- While `hooks.json` is absent Droid reads the legacy `hooks/hooks.json` instead and stops reading it once `hooks.json` exists. hookmux will not create `hooks.json` next to a legacy file: save any hook from Droid's `/hooks` screen once to migrate it, then run `hookmux sync`.
- Droid accepts comments in these files; hookmux does not, and refuses to edit a file with comments rather than drop them.
- If you later add hooks for an event to `settings.json` while hookmux's entry for that event sits in `hooks.json`, Droid runs only the `hooks.json` entries. Move your hook into `hooks.json` to keep both.
- Droid documents no variable that moves `~/.factory`.
- Context added before a tool call does not reach the model, so hookmux offers only block and notify there.
- A blocked prompt is handed back to you unsent. A block after a tool call sends the reason to the agent; the tool has already run.
- Hook input always carries Droid's tool names: `Execute`, `Create`, `Edit`, `Read` and `ApplyPatch`. hookmux maps `Execute` to `Bash`, `Create` to `Write` and `ApplyPatch` to `Edit`. `ApplyPatch` input has no `file_path`.

## Qoder CLI (`qoder`)

Written from the Qoder CLI hooks documentation for Qoder CLI 1.1.94. Not yet run against a live client.

- Config file: `~/.qoder/settings.json`, or `settings.json` in `$QODER_CONFIG_DIR` when that is set. Qoder documents that variable as the user data folder; hookmux assumes settings move with it. Timeouts are in seconds.
- A blocked prompt uses `decision: "deny"` with a `reason`.
- Qoder cannot block after a tool call, so a block there becomes a notice.
- Qoder rejects the whole output when `hookSpecificOutput` has no `hookEventName`; hookmux always sets it.
- Tool names are Claude Code's (`Bash`, `Write`, `Edit`, `Read`).

## CodeBuddy Code (`codebuddy`)

Written from the CodeBuddy Code hooks reference for CodeBuddy Code 2.185.0, where hooks are still marked beta. Not yet run against a live client.

- Config file: `~/.codebuddy/settings.json`. Timeouts are in seconds.
- A blocked prompt uses `continue: false` with a `reason`, which only you see; CodeBuddy has deprecated `decision: "block"` there.
- CodeBuddy cannot block after a tool call, so a block there becomes a notice.
- Tool names are Claude Code's (`Bash`, `Write`, `Edit`, `Read`).

## Agents that already run Claude Code's hooks

Cursor and Devin CLI read `~/.claude/settings.json` by default, so once hookmux is set up for Claude Code they run its entries too, reporting themselves as Claude Code. hookmux has no adapter of its own for them yet, and whether each one honours every output field is untested.

## Agent environment markers

`hookmux promote` refuses to run when it sees the environment variables Claude Code, Codex or Gemini CLI set on the commands their agents run. The other agents here document no such variable, so for them promote relies on its terminal check alone.
