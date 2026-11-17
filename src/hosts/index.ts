// All built-in host adapters, by id.

import { claudeCode } from "./claude-code.ts";
import type { HostAdapter } from "./types.ts";

export const ADAPTERS: Readonly<Record<string, HostAdapter>> = {
  [claudeCode.id]: claudeCode,
};

export function getAdapter(id: string): HostAdapter | undefined {
  return Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined;
}
