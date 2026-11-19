// Picks the Node path the launcher records. process.execPath is the resolved
// binary, which for Homebrew, nvm and asdf is a versioned folder that an upgrade
// deletes; the launcher would then fail open and every hook would go quiet.
// A `node` on PATH that resolves to the running binary survives the upgrade.

import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

function resolved(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The first `node` on `searchPath` that is the binary at `execPath`, else `execPath` itself. */
export function stableNodePath(execPath: string = process.execPath, searchPath = process.env.PATH ?? ""): string {
  const target = resolved(execPath);
  if (target === null) return execPath;
  for (const dir of searchPath.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, "node");
    if (candidate !== target && resolved(candidate) === target) return candidate;
  }
  return execPath;
}
