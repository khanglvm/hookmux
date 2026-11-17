// Hook entry point that agent clients run (through the launcher) on every event.
// It only turns on Node's compile cache, then loads the real entry, so repeat
// runs skip most JavaScript parsing.

import { enableCompileCache } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

try {
  enableCompileCache?.(join(process.env.HOOKMUX_HOME || join(homedir(), ".hookmux"), "cache", "compile"));
} catch {
  // The cache is an optimisation only.
}
await import("./hook-main.ts");
