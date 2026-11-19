// Recognises the one shell command an agent may run to ask for a plugin's
// activation: `hookmux promote <id> [--standing]` and nothing else. The hub
// answers that tool call by asking the person and adding a one-time grant to
// the command, so the person's approval in the client is what activates it.

import { PLUGIN_ID } from "./types.ts";

export interface PromoteRequest {
  id: string;
  standing: boolean;
}

const PROMOTE = /^\s*hookmux\s+promote\s+(\S+)(?:\s+(--standing))?\s*$/;

/**
 * Security: the whole command must be this one call. Anything a shell would
 * read as more (`;`, `&&`, a pipe, a substitution, another flag) fails the
 * match, so the person never approves a card that runs something else too.
 */
export function parsePromoteCommand(command: unknown): PromoteRequest | null {
  if (typeof command !== "string") return null;
  const match = PROMOTE.exec(command);
  if (!match || !PLUGIN_ID.test(match[1] as string)) return null;
  return { id: match[1] as string, standing: match[2] !== undefined };
}

/** The command the person approves: the request plus its grant. */
export function grantedCommand(request: PromoteRequest, token: string): string {
  return `hookmux promote ${request.id}${request.standing ? " --standing" : ""} --grant ${token}`;
}
