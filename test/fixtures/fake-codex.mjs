#!/usr/bin/env node
// Stands in for `codex app-server` in tests: answers initialize, hooks/list and
// config/batchWrite for the hooks.json in $CODEX_HOME, keeping trust in
// $CODEX_HOME/fake-trust.json. FAKE_CODEX_FAIL=list makes hooks/list fail,
// =write makes batchWrite store nothing, =empty lists no hooks, and =hang
// ignores SIGTERM and answers nothing after writing its pid to fake.pid.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Real Codex resolves CODEX_HOME to its realpath before it reports paths.
const home = realpathSync(process.env.CODEX_HOME);
const hooksFile = join(home, "hooks.json");
const trustFile = join(home, "fake-trust.json");
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const snake = (name) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function hooks() {
  const trust = readJson(trustFile, {});
  const table = readJson(hooksFile, { hooks: {} }).hooks ?? {};
  return Object.entries(table).flatMap(([event, groups]) =>
    groups.flatMap((group, g) =>
      (group.hooks ?? []).map((handler, h) => {
        const key = `${hooksFile}:${snake(event)}:${g}:${h}`;
        const currentHash = `sha256:${createHash("sha256").update(JSON.stringify(handler)).digest("hex")}`;
        const pinned = trust[key];
        const trustStatus = pinned === undefined ? "untrusted" : pinned === currentHash ? "trusted" : "modified";
        return {
          key,
          handlerType: handler.type ?? "command",
          command: handler.command ?? null,
          async: handler.async === true,
          matcher: group.matcher ?? null,
          sourcePath: hooksFile,
          source: "user",
          isManaged: false,
          currentHash,
          trustStatus,
        };
      }),
    ),
  );
}

const answer = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message } })}\n`);

if (process.env.FAKE_CODEX_FAIL === "hang") {
  writeFileSync(join(home, "fake.pid"), String(process.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (process.env.FAKE_CODEX_FAIL === "hang") return;
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return answer(id, { codexHome: home });
  if (method === "hooks/list") {
    if (process.env.FAKE_CODEX_FAIL === "list") return fail(id, "hooks/list failed");
    if (process.env.FAKE_CODEX_FAIL === "empty") return answer(id, { data: [{ cwd: params.cwds[0], hooks: [] }] });
    return answer(id, { data: [{ cwd: params.cwds[0], hooks: hooks(), warnings: [], errors: [] }] });
  }
  if (method === "config/batchWrite") {
    if (process.env.FAKE_CODEX_FAIL !== "write") {
      const trust = readJson(trustFile, {});
      for (const edit of params.edits) {
        const match = /^hooks\.state\.("(?:[^"\\]|\\.)*")\.trusted_hash$/.exec(edit.keyPath);
        if (match) trust[JSON.parse(match[1])] = edit.value;
      }
      writeFileSync(trustFile, JSON.stringify(trust));
    }
    return answer(id, { status: "ok" });
  }
  fail(id, `unknown method ${method}`);
});
