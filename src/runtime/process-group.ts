// Process groups of the scripts the hook started. Each script is spawned
// detached, so it leads a group of its own and one kill(-pgid) reaches every
// process it started that stayed in that group, background children included.
//
// Limit: only this process kills the groups (when a script exits or is stopped,
// when the hook exits, and on the host's TERM, HUP or INT). If the hook itself is
// SIGKILLed directly, none of that runs and the script groups survive. A host
// that kills the hook's own process group does not reach them either. The
// launcher sends TERM before KILL so this cleanup gets its chance.

const tracked = new Set<number>();
let exitHookInstalled = false;

/**
 * SIGKILLs every process in group `pgid`, synchronously. Never throws: it runs
 * inside exit and signal handlers, where a throw would break the hook's exit 0.
 */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH: the group is already empty. Any other error is ignored too, for the reason above.
  }
}

/** Records a running script's group so a hook exit or a host signal can stop it. */
export function trackGroup(pgid: number): void {
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // The hook can exit while a script still runs (watchdog or deadline); nothing it started may outlive it.
    process.on("exit", killTrackedGroups);
  }
  tracked.add(pgid);
}

export function untrackGroup(pgid: number): void {
  tracked.delete(pgid);
}

/** Kills every tracked group. Safe to call more than once. */
export function killTrackedGroups(): void {
  for (const pgid of tracked) killGroup(pgid);
  tracked.clear();
}
