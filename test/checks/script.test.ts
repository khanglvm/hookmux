import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import "../../src/checks/index.ts";
import { getCheck } from "../../src/checks/registry.ts";
import type { CheckSpec, Signal } from "../../src/core/types.ts";
import { type ContextOptions, checkContext, pluginSpec, useTempHome } from "./support.ts";

useTempHome();
const script = getCheck("script");
assert.ok(script);

interface Fixture {
  dir: string;
  /** A scratch folder outside the plugin for pid and marker files. */
  scratch: string;
  run(spec: Omit<CheckSpec, "kind">, options?: ContextOptions): Promise<Signal>;
}

/** Writes executable files into a temp plugin folder and records their hashes as `promote` would. */
function fixture(files: Record<string, string>): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "hookmux-script-"));
  const scratch = mkdtempSync(join(tmpdir(), "hookmux-scratch-"));
  const hashes: Record<string, string> = {};
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body, { mode: 0o755 });
    hashes[rel] = createHash("sha256").update(body).digest("hex");
  }
  return {
    dir,
    scratch,
    async run(options, context) {
      const spec: CheckSpec = { kind: "script", ...options };
      const plugin = pluginSpec(dir, { probe: spec }, hashes);
      return script!.run(spec, checkContext(plugin, context));
    },
  };
}

const sh = (body: string) => `#!/bin/sh\n${body}\n`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits up to 2 s for the processes to disappear (the OS reaps orphans asynchronously). */
async function assertDead(pids: number[]): Promise<void> {
  for (let i = 0; i < 40 && pids.some(isAlive); i++) await new Promise((r) => setTimeout(r, 50));
  for (const pid of pids) assert.equal(isAlive(pid), false, `process ${pid} is still running`);
}

function readPid(file: string): number {
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  assert.ok(pid > 1, `no pid recorded in ${file}`);
  return pid;
}

/** Starts a sleeping grandchild, records both pids, then waits. */
const SLEEPER = sh(`sleep 30 &\necho $! > "$1"\necho $$ > "$2"\nwait`);

test("JSON true and false are used as given, with evidence clipped", async () => {
  const long = "x".repeat(200);
  const f = fixture({
    "yes.sh": sh(`echo '{"value": true, "evidence": "${long}"}'`),
    "no.sh": sh(`echo '{"value": false}'`),
  });
  const yes = await f.run({ command: "yes.sh" });
  assert.equal(yes.value, true);
  assert.equal(yes.evidence?.length, 80);
  assert.deepEqual(await f.run({ command: "./no.sh" }), { value: false });
});

test("a script in a subfolder matches its recorded hash however the path is written", async () => {
  const f = fixture({ "bin/check.sh": sh(`echo '{"value": true}'`) });
  assert.equal((await f.run({ command: "bin/check.sh" })).value, true);
  assert.equal((await f.run({ command: "./bin//check.sh" })).value, true);
});

test("score output accepts a number in range and rejects the wrong type", async () => {
  const f = fixture({ "score.sh": sh(`echo '{"value": 0.42}'`), "big.sh": sh(`echo '{"value": 1.5}'`) });
  assert.equal((await f.run({ command: "score.sh", output: "score" })).value, 0.42);
  assert.equal((await f.run({ command: "big.sh", output: "score" })).value, null);
  const asBool = await f.run({ command: "score.sh" });
  assert.equal(asBool.value, null);
  assert.match(asBool.error ?? "", /bool script/);
});

test("empty stdout reads the exit code", async () => {
  const f = fixture({ "ok.sh": sh("exit 0"), "no.sh": sh("exit 1"), "bad.sh": sh("echo broken >&2\nexit 3") });
  assert.equal((await f.run({ command: "ok.sh" })).value, true);
  assert.equal((await f.run({ command: "no.sh" })).value, false);
  const bad = await f.run({ command: "bad.sh" });
  assert.equal(bad.value, null);
  assert.match(bad.error ?? "", /exited with 3: broken/);
  assert.equal((await f.run({ command: "ok.sh", output: "score" })).value, null);
});

test("invalid JSON gives unknown with an error", async () => {
  const f = fixture({ "junk.sh": sh("echo not json") });
  const r = await f.run({ command: "junk.sh" });
  assert.equal(r.value, null);
  assert.match(r.error ?? "", /invalid JSON/);
});

test("stdin carries the event, params and check name; raw only on request", async () => {
  const f = fixture({ "dump.sh": sh(`cat > "$1"\necho '{"value": true}'`) });
  const out = join(f.scratch, "stdin.json");
  assert.equal((await f.run({ command: "dump.sh", args: [out] })).value, true);
  const payload = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(payload.event.prompt, "hello");
  assert.equal(payload.event.name, "prompt.submit");
  assert.equal(payload.host.id, "claude-code");
  assert.deepEqual(payload.params, { greeting: "hi" });
  assert.equal(payload.check, "probe");
  assert.equal("raw" in payload, false);
  await f.run({ command: "dump.sh", args: [out], needs_raw: true });
  assert.equal(JSON.parse(readFileSync(out, "utf8")).raw.hook_event_name, "UserPromptSubmit");
});

test("the script sees a scrubbed environment", async () => {
  process.env.SECRET_TOKEN = "do-not-leak";
  try {
    const f = fixture({
      "env.sh": sh(
        `printf '{"value": %s, "evidence": "%s"}' "$([ -z "$SECRET_TOKEN" ] && echo true || echo false)" "$HOOKMUX_HOST/$HOOKMUX_EVENT"`,
      ),
    });
    const r = await f.run({ command: "env.sh" });
    assert.equal(r.value, true, "SECRET_TOKEN reached the script");
    assert.equal(r.evidence, "claude-code/prompt.submit");
  } finally {
    delete process.env.SECRET_TOKEN;
  }
});

test("a timeout kills the script and its grandchild", async () => {
  const f = fixture({ "slow.sh": SLEEPER });
  const [gc, child] = [join(f.scratch, "gc.pid"), join(f.scratch, "child.pid")];
  const started = performance.now();
  const r = await f.run({ command: "slow.sh", args: [gc, child], timeout_ms: 300 });
  assert.equal(r.value, null);
  assert.match(r.error ?? "", /timed out after 300 ms/);
  assert.ok(performance.now() - started < 2000);
  await assertDead([readPid(gc), readPid(child)]);
});

test("the hub deadline abort kills the process group at once", async () => {
  const f = fixture({ "slow.sh": SLEEPER });
  const [gc, child] = [join(f.scratch, "gc.pid"), join(f.scratch, "child.pid")];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const r = await f.run({ command: "slow.sh", args: [gc, child], timeout_ms: 5000 }, { signal: controller.signal });
  assert.equal(r.error, "deadline reached");
  await assertDead([readPid(gc), readPid(child)]);
});

test("a background process left behind after a normal exit does not delay the result", async () => {
  // Once the script exits, its leftover is reparented and no longer findable as its
  // descendant; it stays in the hook's process group for the host to reap.
  const f = fixture({ "bg.sh": sh(`sleep 30 &\necho $! > "$1"\necho '{"value": true}'`) });
  const gc = join(f.scratch, "gc.pid");
  const started = performance.now();
  try {
    assert.equal((await f.run({ command: "bg.sh", args: [gc], timeout_ms: 5000 })).value, true);
    assert.ok(performance.now() - started < 1000, "the leftover sleep held stdout open");
  } finally {
    process.kill(readPid(gc), "SIGKILL");
  }
});

test("the verified bytes run from a private content-addressed copy", async () => {
  const body = sh(`printf '%s\\n%s' "$0" "$HOOKMUX_PLUGIN_DIR" > "$1"`);
  const f = fixture({ "where.sh": body });
  const out = join(f.scratch, "where.txt");
  assert.equal((await f.run({ command: "where.sh", args: [out] })).value, true);
  const copy = join(
    process.env.HOOKMUX_HOME as string,
    "cache",
    "scripts",
    createHash("sha256").update(body).digest("hex"),
  );
  assert.deepEqual(readFileSync(out, "utf8").split("\n"), [copy, f.dir]);
  assert.equal(readFileSync(copy, "utf8"), body);
  assert.equal(statSync(copy).mode & 0o777, 0o700);
  assert.equal(statSync(dirname(copy)).mode & 0o777, 0o700);
});

test("a cached copy that no longer matches its hash is replaced before it runs", async () => {
  const body = sh(`printf genuine > "$1"`);
  const f = fixture({ "say.sh": body });
  const out = join(f.scratch, "said.txt");
  assert.equal((await f.run({ command: "say.sh", args: [out] })).value, true);
  const copy = join(
    process.env.HOOKMUX_HOME as string,
    "cache",
    "scripts",
    createHash("sha256").update(body).digest("hex"),
  );
  writeFileSync(copy, sh(`printf planted > "$1"`), { mode: 0o700 });
  assert.equal((await f.run({ command: "say.sh", args: [out] })).value, true);
  assert.equal(readFileSync(out, "utf8"), "genuine");
  assert.equal(readFileSync(copy, "utf8"), body);
});

test("no time left means the script never starts", async () => {
  const f = fixture({ "mark.sh": sh(`touch "$1"`) });
  const marker = join(f.scratch, "ran");
  const r = await f.run({ command: "mark.sh", args: [marker] }, { remainingMs: 0 });
  assert.equal(r.error, "deadline reached");
  assert.equal(existsSync(marker), false);
});

test("stdout over 64 KiB kills the script and gives unknown", async () => {
  const f = fixture({ "flood.sh": sh("while :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done") });
  const r = await f.run({ command: "flood.sh", timeout_ms: 5000 });
  assert.equal(r.value, null);
  assert.match(r.error ?? "", /stdout over 64 KiB/);
});

test("a script edited after promote is not executed", async () => {
  const f = fixture({ "mark.sh": sh(`touch "$1"\necho '{"value": true}'`) });
  const marker = join(f.scratch, "ran");
  writeFileSync(join(f.dir, "mark.sh"), sh(`touch "$1"\necho '{"value": false}'`), { mode: 0o755 });
  const r = await f.run({ command: "mark.sh", args: [marker] });
  assert.deepEqual(r, { value: null, error: "script changed since promote" });
  assert.equal(existsSync(marker), false);
});

test("a script with no recorded hash is not executed", async () => {
  const f = fixture({ "known.sh": sh("exit 0") });
  const marker = join(f.scratch, "ran");
  writeFileSync(join(f.dir, "new.sh"), sh(`touch "$1"`), { mode: 0o755 });
  assert.equal((await f.run({ command: "new.sh", args: [marker] })).error, "script changed since promote");
  assert.equal(existsSync(marker), false);
});

test("a symlink that escapes the plugin folder is refused at run time", async () => {
  const f = fixture({ "ok.sh": sh("exit 0") });
  const outside = join(f.scratch, "outside.sh");
  writeFileSync(outside, sh("exit 0"), { mode: 0o755 });
  symlinkSync(outside, join(f.dir, "link.sh"));
  assert.equal((await f.run({ command: "link.sh" })).error, "script resolves outside the plugin folder");
});

test("validation rejects escapes, bad args and out-of-range timeouts", () => {
  const problems = (options: Omit<CheckSpec, "kind">) => script.validate({ kind: "script", ...options });
  assert.deepEqual(problems({ command: "bin/check.sh", args: ["a"], timeout_ms: 10_000, output: "score" }), []);
  assert.match(problems({ command: "/bin/sh" }).join(), /relative/);
  assert.match(problems({ command: "../other/x.sh" }).join(), /'\.\.'/);
  assert.match(problems({ command: "bin/../../x.sh" }).join(), /'\.\.'/);
  assert.match(problems({ command: "" }).join(), /command/);
  assert.match(problems({ command: "x.sh", args: "a b" }).join(), /args/);
  assert.match(problems({ command: "x.sh", args: [1] }).join(), /args/);
  assert.match(problems({ command: "x.sh", timeout_ms: 0 }).join(), /timeout_ms/);
  assert.match(problems({ command: "x.sh", timeout_ms: 10_001 }).join(), /timeout_ms/);
  assert.match(problems({ command: "x.sh", output: "text" }).join(), /output/);
});
