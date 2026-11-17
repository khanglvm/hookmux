// Bundles the hook and the CLI into dist/ as ESM with no runtime dependencies.
// The hook entry is tiny and loads its main chunk after enabling Node's compile
// cache; the TOML compiler is a separate chunk loaded only when needed.

import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: { hook: "src/hook.ts", cli: "src/cli.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: "eof",
  define: { __HOOKMUX_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "warning",
});
console.log(`built hookmux ${pkg.version} into dist/`);
