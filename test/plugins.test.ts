// Compiles every plugin folder in plugins/ and examples/ and runs its tests.toml
// cases through the engine as Claude Code prompts, so a bundled or example
// plugin cannot ship with a manifest error or a case that no longer holds.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parse as parseToml } from "smol-toml";
import "../src/checks/index.ts";
import { runEngine } from "../src/core/engine.ts";
import type { PluginSpec } from "../src/core/types.ts";
import { claudeCode } from "../src/hosts/claude-code.ts";
import { ADAPTERS } from "../src/hosts/index.ts";
import { compileManifest, MANIFEST_FILE, readManifest } from "../src/load/manifest.ts";

const REPO = new URL("..", import.meta.url).pathname;
const PLUGIN_ROOTS = ["plugins", "examples"];
const TESTS_FILE = "tests.toml";
const settings = { deadlineMs: 1000, blockRequiresRule: true, contextBudget: 9000, runtime: { providers: {} } };

type Expect = "fire" | "silent";
interface PluginCase {
  prompt: string;
  expect: Expect;
}

/** Every folder under the plugin roots that holds a plugin.toml, as repo-relative paths. */
function pluginDirs(): string[] {
  const dirs: string[] = [];
  for (const root of PLUGIN_ROOTS) {
    const base = join(REPO, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, MANIFEST_FILE))) dirs.push(join(root, entry.name));
    }
  }
  return dirs.sort();
}

/**
 * Compiles a plugin from a private temp copy: readManifest refuses files that
 * are group-writable, which a checkout can be under a loose umask.
 */
function compile(relDir: string): PluginSpec {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-plugin-"));
  cpSync(join(REPO, relDir), dir, { recursive: true });
  const defaults = { routeOrigins: ["user" as const], knownHosts: Object.keys(ADAPTERS) };
  return compileManifest(readManifest(dir), dir, undefined, defaults).base;
}

function readCases(relDir: string): PluginCase[] {
  const parsed = parseToml(readFileSync(join(REPO, relDir, TESTS_FILE), "utf8")) as { case?: unknown };
  assert.ok(Array.isArray(parsed.case), `${relDir}/${TESTS_FILE} needs [[case]] entries`);
  return parsed.case.map((raw, i) => {
    const c = raw as Partial<PluginCase>;
    assert.ok(typeof c.prompt === "string" && c.prompt !== "", `${relDir} case ${i}: prompt must be a string`);
    assert.ok(c.expect === "fire" || c.expect === "silent", `${relDir} case ${i}: expect must be fire or silent`);
    return { prompt: c.prompt, expect: c.expect };
  });
}

/** The plugin's outcome for one prompt; a plugin the engine did not select counts as silent. */
async function outcomeFor(plugin: PluginSpec, prompt: string): Promise<string> {
  const event = claudeCode.parse(
    "prompt.submit",
    { session_id: "plugins-test", cwd: REPO, prompt, hook_event_name: "UserPromptSubmit" },
    {},
  );
  assert.ok(event);
  const result = await runEngine({ event, plugins: [plugin], settings, firedThisSession: new Set() });
  return result.trace.find((t) => t.id === plugin.id)?.outcome ?? "silent";
}

const dirs = pluginDirs();

test("plugin folders are found", () => {
  assert.ok(dirs.length > 0, "no plugin.toml under plugins/ or examples/");
});

for (const relDir of dirs) {
  describe(relDir, () => {
    const plugin = compile(relDir);
    const cases = readCases(relDir);

    test("folder name matches the plugin id", () => {
      assert.equal(plugin.id, relDir.split("/").pop());
    });

    test("tests cover both outcomes", () => {
      assert.ok(cases.some((c) => c.expect === "fire"));
      assert.ok(cases.some((c) => c.expect === "silent"));
    });

    for (const c of cases) {
      test(`${c.expect}: ${c.prompt}`, async () => {
        assert.equal(await outcomeFor(plugin, c.prompt), c.expect);
      });
    }
  });
}
