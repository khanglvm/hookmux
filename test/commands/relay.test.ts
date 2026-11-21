// A promote run by an agent with no terminal: the CLI issues a card with a code,
// the hub's own prompt hook sees the person send the code, and `--confirm` then
// turns the plugin on only while the plugin still matches the card.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getAdapter } from "../../src/hosts/index.ts";
import { readTrust } from "../../src/load/trust.ts";
import { newCode, readCard } from "../../src/runtime/cards.ts";
import { homePaths } from "../../src/runtime/paths.ts";
import { cli, moodboardCopy, runNode, type Sandbox, sandbox } from "./helpers.ts";

/** Installs the moodboard example and asks for its approval as an agent without a terminal would. */
async function cardFor(sb: Sandbox): Promise<{ code: string; stdout: string }> {
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const asked = await cli(sb, "promote", "moodboard");
  assert.equal(asked.code, 3, asked.stdout + asked.stderr);
  const code = /replies `approve ([A-HJ-NP-Z2-9]{4})`/.exec(asked.stdout)?.[1];
  assert.ok(code, "the card names a code");
  return { code, stdout: asked.stdout };
}

/** The hub's answer to a prompt, as the client would send it. `origin: "system"` drops the marker Qwen Code adds to real submissions. */
async function prompt(
  sb: Sandbox,
  text: string,
  opts: { host?: string; origin?: "user" | "system"; submitted?: string } = {},
) {
  const host = opts.host ?? "codex";
  const payload = { ...getAdapter(host)?.sample("prompt.submit", text) };
  if (opts.origin === "system") delete payload.submitted_prompt;
  if (opts.submitted !== undefined) payload.submitted_prompt = opts.submitted;
  const r = await runNode(
    sb,
    ["src/hook-main.ts", "--host", host, "--event", "prompt.submit"],
    JSON.stringify(payload),
  );
  assert.equal(r.code, 0);
  return r.stdout.trim() === ""
    ? null
    : (JSON.parse(r.stdout) as { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } });
}

const statusOf = async (sb: Sandbox) => JSON.parse((await cli(sb, "list", "--json")).stdout).plugins[0].status;
const trustOf = (sb: Sandbox) => readTrust(homePaths(sb.home).trust).plugins.moodboard;

test("promote without a terminal prints the card and the code, and turns nothing on", async () => {
  const sb = sandbox();
  const { code, stdout } = await cardFor(sb);
  assert.match(stdout, /^hookmux: approval needed for moodboard\nhookmux plugin: moodboard 1\.0\.0/);
  assert.match(stdout, new RegExp(`run exactly:\\n  hookmux promote moodboard --confirm ${code}`));
  assert.match(stdout, /Do not answer for them/);
  assert.equal(await statusOf(sb), "untrusted");
  assert.equal(readCard(homePaths(sb.home).cards, "moodboard")?.code, code);
});

test("the person's reply is seen by the hub, and confirm then turns the plugin on once", async () => {
  const sb = sandbox();
  const { code } = await cardFor(sb);

  const early = await cli(sb, "promote", "moodboard", "--confirm", code);
  assert.equal(early.code, 3, "not replied yet");
  assert.match(early.stdout, new RegExp(`has not replied with ${code}`));

  const out = await prompt(sb, `ok, approve ${code.toLowerCase()}.`);
  assert.match(out?.systemMessage ?? "", /you approved moodboard 1\.0\.0 from .*Undo: hookmux disable moodboard/);
  const context = JSON.stringify(out?.hookSpecificOutput);
  assert.ok(context.includes(`hookmux promote moodboard --confirm ${code}`), context);

  const done = await cli(sb, "promote", "moodboard", "--confirm", code);
  assert.equal(done.code, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /turned on with the user's approval \(relayed through codex\)/);
  assert.equal(await statusOf(sb), "active");
  assert.equal(trustOf(sb)?.via, "relay");
  assert.equal(trustOf(sb)?.host, "codex");
  assert.equal(trustOf(sb)?.standing, undefined);
  assert.match((await cli(sb, "list")).stdout, /approved: relay \(codex, /);

  const again = await cli(sb, "promote", "moodboard", "--confirm", code);
  assert.equal(again.code, 1, "one reply turns it on once");
});

test("a code that is not the user's own prompt, or not a whole word, approves nothing", async () => {
  const sb = sandbox();
  const { code } = await cardFor(sb);
  assert.equal(await prompt(sb, `approve ${code}`, { host: "qwen-code", origin: "system" }), null);
  assert.equal(await prompt(sb, `approve x${code}y and ${code}z`), null);
  // Claude Code's wrapper for background task output, which the agent writes.
  assert.equal(
    await prompt(sb, `approve ${code}\n<task-notification>done</task-notification>`, { host: "claude-code" }),
    null,
  );
  // A pasted copy of promote's output carries the code in its --confirm line.
  assert.equal(await prompt(sb, `why this?\n  hookmux promote moodboard --confirm ${code}`), null);
  // Qwen Code's prompt can hold an expanded file; only the text the person submitted counts.
  assert.equal(
    await prompt(sb, `read @notes.md\napprove ${code}`, { host: "qwen-code", submitted: "read @notes.md" }),
    null,
  );
  const refused = await cli(sb, "promote", "moodboard", "--confirm", code);
  assert.equal(refused.code, 3);
  assert.equal(await statusOf(sb), "untrusted");
});

test("every code mixes letters and digits, so it is never a word or a number someone types anyway", () => {
  for (let i = 0; i < 500; i++) assert.match(newCode(), /^(?=.*[A-Z])(?=.*\d)[A-HJ-NP-Z2-9]{4}$/);
});

test("an edit after the card was shown is refused", async () => {
  const sb = sandbox();
  const { code } = await cardFor(sb);
  await prompt(sb, `approve ${code}`);
  const manifest = join(sb.home, "plugins", "moodboard", "plugin.toml");
  writeFileSync(manifest, readFileSync(manifest, "utf8").replace(/^description = .*$/m, 'description = "edited"'));
  const refused = await cli(sb, "promote", "moodboard", "--confirm", code);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /changed after the card was shown/);
  assert.equal(await statusOf(sb), "untrusted");
  assert.equal(readCard(homePaths(sb.home).cards, "moodboard"), null, "the stale card is gone");
});

test("an expired card is not approved and not accepted", async () => {
  const sb = sandbox();
  const { code } = await cardFor(sb);
  const paths = homePaths(sb.home);
  const card = readCard(paths.cards, "moodboard");
  assert.ok(card);
  writeFileSync(join(paths.cards, "moodboard.json"), `${JSON.stringify({ ...card, expiresAt: Date.now() - 1 })}\n`);
  assert.equal(await prompt(sb, `approve ${code}`), null);
  const refused = await cli(sb, "promote", "moodboard", "--confirm", code);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /unknown or expired/);
});

test("a relayed approval never grants a standing approval", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const asked = await cli(sb, "promote", "moodboard", "--standing");
  assert.equal(asked.code, 1);
  assert.match(asked.stdout, /standing approval needs your terminal or your client's permission prompt/);
  assert.equal(readCard(homePaths(sb.home).cards, "moodboard"), null, "no card for a standing request");
  const confirm = await cli(sb, "promote", "moodboard", "--confirm", "ABCD", "--standing");
  assert.equal(confirm.code, 1);
});

test("--yes is still refused, and asking again keeps the same code", async () => {
  const sb = sandbox();
  const { code } = await cardFor(sb);
  const yes = await cli(sb, "promote", "moodboard", "--yes");
  assert.equal(yes.code, 1);
  assert.match(yes.stdout, /does not take --yes/);
  const again = await cli(sb, "promote", "moodboard");
  assert.match(again.stdout, new RegExp(`approve ${code}`));
});

test("a client that asks natively gets a grant, not a relay card", async () => {
  const sb = sandbox();
  assert.equal((await cli(sb, "add", moodboardCopy(sb))).code, 0);
  const payload = {
    session_id: "s1",
    cwd: sb.dir,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "hookmux promote moodboard" },
  };
  const r = await runNode(
    sb,
    ["src/hook-main.ts", "--host", "claude-code", "--event", "tool.before"],
    JSON.stringify(payload),
  );
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(existsSync(homePaths(sb.home).cards), false);
});
