// Child processes the hook started (plugin scripts), and how to end them with
// everything they started. Scripts run in the hook's own process group, so a
// host that kills the group on timeout reaches them too; when hookmux itself
// stops a script, it finds the script's descendants in one `ps` snapshot.
// Only the stop path pays for `ps`: a script that exits normally costs nothing.

import { execFileSync } from "node:child_process";

/** pid to parent pid, from one `ps` run. */
export type ProcessTable = Map<number, number>;

/** How long `ps` may take before the kill falls back to the direct child. */
const PS_TIMEOUT_MS = 500;

/** Parses `ps -A -o pid=,ppid=` output. Lines that are not two numbers are skipped. */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

/** Every descendant of `root` in the table, children before grandchildren; `root` itself is not included. */
export function descendantsOf(root: number, table: ProcessTable): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of table) {
    if (pid === ppid) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const seen = new Set([root]);
  for (let queue = [root]; queue.length > 0; ) {
    const next: number[] = [];
    for (const pid of queue) {
      for (const child of children.get(pid) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return out;
}

let cachedTable: ProcessTable | null | undefined;

/**
 * One snapshot per synchronous turn: a deadline abort stops every running
 * script in the same tick, and they all share this table. Null when `ps` is
 * unavailable (Windows) or fails.
 */
function snapshot(): ProcessTable | null {
  if (cachedTable !== undefined) return cachedTable;
  try {
    const text = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    cachedTable = parseProcessTable(text);
  } catch {
    cachedTable = null;
  }
  queueMicrotask(() => {
    cachedTable = undefined;
  });
  return cachedTable;
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ESRCH: already gone.
  }
}

/** SIGKILLs `root` and its descendants, synchronously. Without `ps`, only `root` is killed. */
export function killTree(root: number): void {
  const table = snapshot();
  const descendants = table ? descendantsOf(root, table) : [];
  kill(root);
  for (const pid of descendants) kill(pid);
}

const tracked = new Set<number>();
let exitHookInstalled = false;

/** Records a running child so an exit or a host signal can stop it. */
export function trackChild(pid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // The hook can exit while a script still runs (watchdog or deadline); nothing it started may outlive it.
    process.on("exit", killTrackedChildren);
  }
  tracked.add(pid);
}

export function untrackChild(pid: number): void {
  tracked.delete(pid);
}

/** Kills every tracked child and its descendants. Safe to call more than once. */
export function killTrackedChildren(): void {
  for (const pid of tracked) killTree(pid);
  tracked.clear();
}
