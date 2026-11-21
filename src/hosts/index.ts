// All built-in host adapters, by id.

import { claudeCode } from "./claude-code.ts";
import { codebuddy } from "./codebuddy.ts";
import { codex } from "./codex.ts";
import { droid } from "./droid.ts";
import { geminiCli } from "./gemini-cli.ts";
import { opencode } from "./opencode.ts";
import { qoder } from "./qoder.ts";
import { qwenCode } from "./qwen-code.ts";
import type { HostAdapter } from "./types.ts";

export const ADAPTERS: Readonly<Record<string, HostAdapter>> = {
  [claudeCode.id]: claudeCode,
  [codex.id]: codex,
  [geminiCli.id]: geminiCli,
  [qwenCode.id]: qwenCode,
  [droid.id]: droid,
  [qoder.id]: qoder,
  [codebuddy.id]: codebuddy,
  [opencode.id]: opencode,
};

export function getAdapter(id: string): HostAdapter | undefined {
  return Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined;
}
