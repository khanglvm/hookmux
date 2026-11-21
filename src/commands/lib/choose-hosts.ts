// Which agent clients a command wires: init's rules (flag, --yes, terminal
// picker, hosts already wired) and install's (terminal picker, --host, or the
// client that is running the command).

import type { HostAdapter } from "../../hosts/types.ts";
import { agentHost } from "./agent-env.ts";
import { UsageError } from "./args.ts";
import { allAdapters } from "./hosts.ts";
import { say } from "./output.ts";
import { confirm, isInteractive } from "./prompt.ts";

const detectedClients = () => allAdapters().filter((a) => a.config.detect());

/** The adapters named by --host, each warned about when its config folder is absent. */
function namedHosts(ids: string[]): HostAdapter[] {
  const all = allAdapters();
  return [...new Set(ids)].map((id) => {
    const adapter = all.find((a) => a.id === id);
    if (!adapter) throw new UsageError(`unknown host '${id}'; known hosts: ${all.map((a) => a.id).join(", ")}`);
    if (!adapter.config.detect()) say("warn", `${adapter.name} was not detected; wiring it anyway`);
    return adapter;
  });
}

async function pickOnTerminal(): Promise<HostAdapter[]> {
  const picked: HostAdapter[] = [];
  for (const adapter of detectedClients()) if (await confirm(`Wire ${adapter.name}?`, true)) picked.push(adapter);
  return picked;
}

/** Hosts to wire for init: the --host list, every detected host with --yes, or the person's picks. */
export async function chooseHosts(ids: string[], yes: boolean, wired: HostAdapter[]): Promise<HostAdapter[]> {
  if (ids.length > 0) return namedHosts(ids);
  if (yes) return detectedClients();
  if (isInteractive()) return pickOnTerminal();
  if (wired.length > 0) {
    say("info", `updating hosts already wired: ${wired.map((a) => a.id).join(", ")}`);
    return wired;
  }
  const found =
    detectedClients()
      .map((a) => a.id)
      .join(", ") || "none";
  throw new UsageError(`stdin is not a terminal: pass --host <id> or --yes (detected: ${found})`);
}

/**
 * Hosts to wire for install. `atTerminal` is true only when a person can answer: a terminal
 * with no agent marker. Otherwise --host, else the client that set an agent marker.
 * @throws UsageError when an agent runs install and neither names a client.
 */
export async function chooseInstallHosts(
  ids: string[],
  atTerminal: boolean,
  env: NodeJS.ProcessEnv,
): Promise<HostAdapter[]> {
  if (ids.length > 0) return namedHosts(ids);
  if (atTerminal) return pickOnTerminal();
  const marked = agentHost(env);
  if (marked) return namedHosts([marked]);
  const found =
    detectedClients()
      .map((a) => a.id)
      .join(", ") || "none";
  throw new UsageError(`name your client: hookmux install <source> --host <id> (detected: ${found})`);
}
