// Picks the Node path the launcher records. process.execPath is the resolved
// binary, which for Homebrew, nvm and asdf is a versioned folder that an upgrade
// deletes; the launcher would then fail open and every hook would go quiet.
// A `node` on PATH that resolves to the running binary survives the upgrade.

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

// Homebrew leaves /opt/homebrew/bin group-writable (group admin), so only other-write is refused.
const OTHER_WRITE = 0o002;
// The launcher quotes the path in single quotes; control characters would split the NODE= line.
const UNSAFE_IN_LAUNCHER = /['\p{Cc}]/u;

function resolved(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Security: the recorded path is a link that whoever can write its folder may
 * later repoint, and every hook then runs that binary. Only a folder owned by
 * root or this user and closed to other writes is accepted.
 */
function ownFolder(candidate: string): boolean {
  try {
    const s = statSync(dirname(candidate));
    const uid = process.getuid?.();
    return (s.uid === 0 || s.uid === uid) && (s.mode & OTHER_WRITE) === 0;
  } catch {
    return false;
  }
}

/** The first `node` on `searchPath` that is the binary at `execPath`, else `execPath` itself. */
export function stableNodePath(execPath: string = process.execPath, searchPath = process.env.PATH ?? ""): string {
  const target = resolved(execPath);
  if (target === null) return execPath;
  for (const dir of searchPath.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "node");
    if (candidate === target || UNSAFE_IN_LAUNCHER.test(candidate) || !ownFolder(candidate)) continue;
    if (resolved(candidate) === target) return candidate;
  }
  return execPath;
}
