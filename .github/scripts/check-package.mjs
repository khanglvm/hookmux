// Checks what `npm publish` would ship: the tarball holds only the allowed
// top-level entries, the files the launcher and the bin need, and dist/ stays
// under its size budget. Run after `pnpm build`: node .github/scripts/check-package.mjs

import { execFileSync } from "node:child_process";

/** Top-level entries the package may contain (package.json `files`, plus what npm always adds). */
const ALLOWED = new Set(["dist", "launcher", "plugins", "skills", "package.json", "README.md", "LICENSE"]);
const REQUIRED = ["dist/cli.mjs", "dist/hook.mjs", "launcher/hookmux-hook.sh", "package.json", "README.md", "LICENSE"];
/** The hook bundle loads on every prompt, so its size is a startup-time budget. */
const DIST_BUDGET_BYTES = 300 * 1024;

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const files = pack.files.map((f) => ({ path: f.path, size: f.size }));
const problems = [];

for (const { path } of files) {
  if (!ALLOWED.has(path.split("/")[0])) problems.push(`unexpected file in package: ${path}`);
}
for (const path of REQUIRED) {
  if (!files.some((f) => f.path === path)) problems.push(`missing from package: ${path}`);
}
const distBytes = files.filter((f) => f.path.startsWith("dist/")).reduce((sum, f) => sum + f.size, 0);
if (distBytes >= DIST_BUDGET_BYTES) problems.push(`dist is ${distBytes} bytes, budget is ${DIST_BUDGET_BYTES}`);

console.log(`${pack.name}@${pack.version}: ${files.length} files, dist ${distBytes} bytes`);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
