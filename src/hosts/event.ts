// Builds a HookEvent from the payload fields the three hosts name the same way:
// session_id, cwd, hook_event_name, prompt, tool_name, tool_input and source.
// Each adapter supplies what differs: prompt origin and the tool-name mapping.

import type { CanonicalEvent, HookEvent, Origin } from "../core/types.ts";
import { asRecord, str } from "./payload.ts";
import type { HostAdapter } from "./types.ts";

/** The static facts about a host that every parsed event carries. */
export type HostIdentity = Pick<HostAdapter, "id" | "name" | "nativeEvents" | "supports" | "contextChars">;

export interface PayloadReading {
  /** Origin of a prompt.submit payload; every other event gets "unknown". */
  promptOrigin(payload: Record<string, unknown>, prompt: string | undefined): Origin;
  /** hookmux's portable tool name for the host's own name. */
  canonicalTool(name: string): string;
}

/** Returns null when the payload is not a JSON object. */
export function parseHostPayload(
  host: HostIdentity,
  event: CanonicalEvent,
  payload: unknown,
  reading: PayloadReading,
): HookEvent | null {
  const p = asRecord(payload);
  if (!p) return null;
  const prompt = str(p.prompt);
  const toolName = str(p.tool_name);
  const parsed: HookEvent = {
    name: event,
    host: {
      id: host.id,
      name: host.name,
      version: null,
      adapterContract: 1,
      nativeEvent: str(p.hook_event_name) ?? (host.nativeEvents[event] as string),
      canonicalEvent: event,
      supports: host.supports[event],
      limits: { contextChars: host.contextChars },
    },
    sessionId: str(p.session_id) ?? "",
    cwd: str(p.cwd) ?? process.cwd(),
    origin: event === "prompt.submit" ? reading.promptOrigin(p, prompt) : "unknown",
    raw: payload,
  };
  if (prompt !== undefined) parsed.prompt = prompt;
  if (toolName !== undefined) {
    parsed.tool = { name: toolName, canonicalName: reading.canonicalTool(toolName), input: p.tool_input };
  }
  const source = str(p.source);
  if (source !== undefined) parsed.source = source;
  return parsed;
}
