// The hook process under a host that gives up: a signal kills the scripts it
// started and the hook still exits 0 with nothing on stdout.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, sandbox, trustInstalled } from "./helpers.ts";

const MANIFEST = `schema = 1
id = "sleeper"
events = ["prompt.submit"]
when = "slow"
[checks.slow]
kind = "script"
command = "slow.sh"
timeout_ms = 10000
[[then]]
effect = "inject"
text = "never"
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const signal of ["SIGTERM", "SIGHUP"] as const) {
  test(`${signal} kills running scripts and the hook exits 0 with no output`, async () => {
    const sb = sandbox();
    const dir = join(sb.home, "plugins", "sleeper");
    const pidFile = join(sb.dir, "script.pid");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plugin.toml"), MANIFEST, { mode: 0o644 });
    writeFileSync(join(dir, "slow.sh"), `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 30\n`, { mode: 0o755 });
    writeFileSync(join(sb.home, "config.toml"), "[settings]\ndeadline_ms = 15000\n");
    trustInstalled(sb, "sleeper");

    const child = spawn(process.execPath, ["src/hook.ts", "--host", "claude-code", "--event", "prompt.submit"], {
      cwd: ROOT,
      env: sb.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    const closed = new Promise<number | null>((done) => child.on("close", done));
    child.stdin.end(
      JSON.stringify({ session_id: "s", cwd: sb.dir, hook_event_name: "UserPromptSubmit", prompt: "hi" }),
    );
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const scriptPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(isAlive(scriptPid));

    child.kill(signal);
    assert.equal(await closed, 0);
    assert.equal(stdout, "");
    for (let i = 0; i < 40 && isAlive(scriptPid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(isAlive(scriptPid), false, "the script outlived the hook");
  });
}
