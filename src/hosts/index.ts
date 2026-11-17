// All built-in host adapters, by id.

import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { geminiCli } from "./gemini-cli.ts";
import type { HostAdapter } from "./types.ts";

export const ADAPTERS: Readonly<Record<string, HostAdapter>> = {
  [claudeCode.id]: claudeCode,
  [codex.id]: codex,
  [geminiCli.id]: geminiCli,
};

export function getAdapter(id: string): HostAdapter | undefined {
  return Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined;
}
