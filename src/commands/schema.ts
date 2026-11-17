// `hookmux schema`: the plugin authoring reference, built from the live
// registries (check kinds, adapters) so it always matches this engine.

import "../checks/index.ts";
import { listChecks } from "../checks/registry.ts";
import { CANONICAL_EVENTS, PHASES } from "../core/types.ts";
import { ADAPTERS } from "../hosts/index.ts";
import { KNOWN_KEYS, MANIFEST_SCHEMA } from "../load/manifest.ts";
import { VERSION } from "../version.ts";
import { parseCommand } from "./lib/args.ts";
import { CASE_FIELDS } from "./lib/cases.ts";
import { bold, detail, dim } from "./lib/output.ts";
import { EFFECT_DOCS, MANIFEST_KEY_DOCS } from "./lib/schema-data.ts";

export const usage = `Usage: hookmux schema [--json]

Prints manifest keys, check kinds, effects, events and what each host supports.`;

export function buildSchema() {
  return {
    hookmux: VERSION,
    manifestSchema: MANIFEST_SCHEMA,
    keys: [...KNOWN_KEYS].map((key) => ({ key, meaning: MANIFEST_KEY_DOCS[key] ?? "" })),
    phases: [...PHASES],
    checks: listChecks().map((k) => ({
      kind: k.kind,
      summary: k.summary,
      options: k.options,
      tier: k.tier,
      output: k.output,
      modelBacked: k.modelBacked,
    })),
    effects: Object.entries(EFFECT_DOCS).map(([effect, doc]) => ({ effect, ...doc })),
    events: [...CANONICAL_EVENTS],
    hosts: Object.values(ADAPTERS).map((a) => ({
      id: a.id,
      name: a.name,
      contextChars: a.contextChars,
      events: Object.fromEntries(
        CANONICAL_EVENTS.map((e) => [
          e,
          { native: a.nativeEvents[e], supports: a.nativeEvents[e] ? a.supports[e] : [] },
        ]),
      ),
    })),
    testCase: CASE_FIELDS,
  };
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommand(argv, { json: { type: "boolean" } }, usage);
  if (!parsed) return 0;
  const schema = buildSchema();
  if (parsed.values.json) {
    console.log(JSON.stringify(schema, null, 2));
    return 0;
  }
  section(`Manifest keys (plugin.toml, schema = ${schema.manifestSchema})`);
  for (const k of schema.keys) detail(`${k.key.padEnd(18)} ${k.meaning}`);
  section("Check kinds");
  for (const c of schema.checks) {
    detail(`${bold(c.kind)}  ${dim(`tier ${c.tier}, ${c.output}${c.modelBacked ? ", model" : ""}`)}  ${c.summary}`);
    for (const [name, text] of Object.entries(c.options)) detail(`  ${name}: ${text}`);
  }
  section("Effects ([[then]])");
  for (const e of schema.effects) {
    detail(`${bold(e.effect)}  ${e.summary}`);
    for (const [name, text] of Object.entries(e.fields)) detail(`  ${name}: ${text}`);
  }
  section("Events");
  detail(schema.events.join(", "));
  section("Hosts");
  for (const h of schema.hosts) {
    detail(bold(`${h.name} (${h.id})`));
    for (const [event, info] of Object.entries(h.events)) {
      detail(`  ${event.padEnd(14)} ${info.native ?? dim("not available")}  ${info.supports.join(", ")}`);
    }
  }
  section("Test cases (tests.toml [[case]])");
  for (const [field, text] of Object.entries(schema.testCase)) detail(`${field.padEnd(8)} ${text}`);
  return 0;
}

function section(title: string): void {
  console.log(`\n${bold(title)}`);
}
