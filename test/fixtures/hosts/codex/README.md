# Codex hook payloads

Each file was built by hand from the stdin structs in Codex 0.167.1
(tag `rust-v0.167.1`), not captured from a live Codex run. The values are
placeholders; the key sets follow these structs:

| File                                             | Struct                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `UserPromptSubmit.json`                          | `UserPromptSubmitCommandInput`, `codex-rs/hooks/src/schema.rs:568-584` |
| `UserPromptSubmit-subagent.json`                 | the same, with the optional `agent_id` and `agent_type`                |
| `SessionStart.json`                              | `SessionStartCommandInput`, `codex-rs/hooks/src/schema.rs:500-511`     |
| `PreToolUse.json`, `PreToolUse-apply_patch.json` | `PreToolUseCommandInput`, `codex-rs/hooks/src/schema.rs:279-297`       |
| `PostToolUse.json`                               | `PostToolUseCommandInput`, `codex-rs/hooks/src/schema.rs:324-343`      |

The `apply_patch` input shape comes from
`codex-rs/core/src/tools/handlers/apply_patch.rs:370-375`, and the MCP tool name
form `mcp__<server>__<tool>` from `codex-rs/core/src/tools/handlers/mcp.rs:140`.
