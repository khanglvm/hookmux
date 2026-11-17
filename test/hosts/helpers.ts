// Shared pieces of the per-host golden tests: fixture loading, result builders
// and the config-editor cases every JSON-config host must pass. The config
// cases only touch temp dirs, through the env object each host test supplies.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  CANONICAL_EVENTS,
  type CanonicalEvent,
  emptyResult,
  type HookEvent,
  type HubResult,
} from "../../src/core/types.ts";
import { ConfigEditError } from "../../src/hosts/json-config.ts";
import type { HostAdapter } from "../../src/hosts/types.ts";

const FIXTURES = new URL("../fixtures/hosts/", import.meta.url).pathname;

export const LAUNCHER = "/opt/hookmux/bin/hookmux-hook";

export function readFixture(host: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, host, name), "utf8"));
}

/** Parses a payload and fails the test when the adapter rejects it. */
export function parseOrFail(adapter: HostAdapter, event: CanonicalEvent, payload: unknown): HookEvent {
  const parsed = adapter.parse(event, payload, {});
  assert.ok(parsed, `${adapter.id} rejected the ${event} payload`);
  return parsed;
}

/** The result shapes every adapter must render. */
export const RESULT_SHAPES = {
  empty: emptyResult(),
  context: {
    ...emptyResult(),
    context: [
      { pluginId: "p1", text: "first" },
      { pluginId: "p2", text: "second" },
    ],
  },
  notice: { ...emptyResult(), notices: [{ pluginId: "p1", text: "heads up" }] },
  block: { ...emptyResult(), block: { reason: "no secrets", suppressOriginalPrompt: false, pluginId: "p1" } },
  blockSuppress: { ...emptyResult(), block: { reason: "no secrets", suppressOriginalPrompt: true, pluginId: "p1" } },
} satisfies Record<string, HubResult>;

export type ResultShape = keyof typeof RESULT_SHAPES;

export interface ConfigCaseOptions {
  adapter: HostAdapter;
  /** Env that points the adapter's config at `dir` instead of the real home. */
  envFor(dir: string): NodeJS.ProcessEnv;
  /** A root key the host accepts, used to prove install keeps foreign keys. */
  foreignRoot: Record<string, unknown>;
}

function tempEnv(options: ConfigCaseOptions): { env: NodeJS.ProcessEnv; file: string } {
  const env = options.envFor(mkdtempSync(join(tmpdir(), `hookmux-${options.adapter.id}-`)));
  return { env, file: options.adapter.config.file(env) };
}

function writeConfig(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function nativeOf(adapter: HostAdapter, event: CanonicalEvent): string {
  const native = adapter.nativeEvents[event];
  assert.ok(native, `${adapter.id} has no native name for ${event}`);
  return native;
}

/** A config that already holds two user groups on the prompt event. */
function existingConfig(options: ConfigCaseOptions): Record<string, unknown> {
  const native = nativeOf(options.adapter, "prompt.submit");
  return {
    ...options.foreignRoot,
    hooks: {
      [native]: [
        { hooks: [{ type: "command", command: "/usr/local/bin/first-user-hook" }] },
        { hooks: [{ type: "command", command: "/usr/local/bin/second-user-hook" }] },
      ],
    },
  };
}

const allEvents = { launcher: LAUNCHER, events: [...CANONICAL_EVENTS], timeoutSec: 5 };

/** Registers the config-editor cases shared by every JSON-config host. */
export function configEditorCases(options: ConfigCaseOptions): void {
  const { adapter } = options;
  const id = adapter.id;

  test(`${id} config: install into a missing config creates it without a backup`, () => {
    const { env, file } = tempEnv(options);
    const change = adapter.config.install(allEvents, env);
    assert.equal(change.changed, true);
    assert.deepEqual(change.added, [...CANONICAL_EVENTS]);
    assert.equal(change.backup, undefined);
    assert.deepEqual(adapter.config.installed(LAUNCHER, env), [...CANONICAL_EVENTS]);
    const hooks = JSON.parse(readFileSync(file, "utf8")).hooks;
    for (const event of CANONICAL_EVENTS) assert.equal(hooks[nativeOf(adapter, event)].length, 1);
  });

  test(`${id} config: install into an empty file`, () => {
    const { env, file } = tempEnv(options);
    writeConfig(file, "");
    const change = adapter.config.install(allEvents, env);
    assert.equal(change.changed, true);
    assert.deepEqual(adapter.config.installed(LAUNCHER, env), [...CANONICAL_EVENTS]);
  });

  test(`${id} config: install appends after existing groups, keeps foreign keys and backs up`, () => {
    const { env, file } = tempEnv(options);
    const original = `${JSON.stringify(existingConfig(options), null, 2)}\n`;
    writeConfig(file, original);
    const change = adapter.config.install(allEvents, env);
    assert.equal(change.backup, `${file}.hookmux.bak`);
    assert.equal(readFileSync(`${file}.hookmux.bak`, "utf8"), original);
    const written = JSON.parse(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(options.foreignRoot)) assert.deepEqual(written[key], value);
    const groups = written.hooks[nativeOf(adapter, "prompt.submit")];
    assert.equal(groups.length, 3);
    assert.equal(groups[0].hooks[0].command, "/usr/local/bin/first-user-hook");
    assert.equal(groups[1].hooks[0].command, "/usr/local/bin/second-user-hook");
    assert.match(groups[2].hooks[0].command, /^\/opt\/hookmux\/bin\/hookmux-hook --host /);
  });

  test(`${id} config: a second install changes nothing`, () => {
    const { env, file } = tempEnv(options);
    adapter.config.install(allEvents, env);
    const before = readFileSync(file, "utf8");
    const again = adapter.config.install(allEvents, env);
    assert.equal(again.changed, false);
    assert.deepEqual(again.added, []);
    assert.equal(readFileSync(file, "utf8"), before);
  });

  test(`${id} config: uninstall removes only hub groups`, () => {
    const { env, file } = tempEnv(options);
    const original = existingConfig(options);
    writeConfig(file, JSON.stringify(original));
    adapter.config.install(allEvents, env);
    const change = adapter.config.uninstall(LAUNCHER, env);
    assert.deepEqual(change.removed, [...CANONICAL_EVENTS]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
    assert.deepEqual(adapter.config.installed(LAUNCHER, env), []);
  });

  test(`${id} config: invalid JSON is refused with no write`, () => {
    const { env, file } = tempEnv(options);
    writeConfig(file, "{ not json");
    assert.throws(() => adapter.config.install(allEvents, env), ConfigEditError);
    assert.throws(() => adapter.config.uninstall(LAUNCHER, env), ConfigEditError);
    assert.equal(readFileSync(file, "utf8"), "{ not json");
    assert.equal(existsSync(`${file}.hookmux.bak`), false);
  });
}

/** Fails when the adapter's config file resolves outside `dir`, i.e. ignores the env override. */
export function assertFileUnder(adapter: HostAdapter, env: NodeJS.ProcessEnv, dir: string): void {
  assert.ok(adapter.config.file(env).startsWith(dir), `${adapter.id} config escaped ${dir}`);
}
