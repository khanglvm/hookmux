# Gemini CLI hook payloads

Each file was built by hand from the hook input types in Gemini CLI v0.68.0,
not captured from a live Gemini run. The values are placeholders; the key sets
follow these types in `packages/core/src/hooks/types.ts`:

| File                | Type                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `BeforeAgent.json`  | `BeforeAgentInput`, `:547-549`, on the base `HookInput`, `:141-147` |
| `SessionStart.json` | `SessionStartInput`, `:616-618`                                     |
| `BeforeTool.json`   | `BeforeToolInput`, `:498-503`                                       |
| `AfterTool.json`    | `AfterToolInput`, `:518-524`                                        |

`mcp_context` and `original_request_name` are left out, as Gemini does when
they are absent (`packages/core/src/hooks/hookEventHandler.ts:82-90`).
