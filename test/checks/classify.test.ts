import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import "../../src/checks/index.ts";
import { getCheck, type ProviderSettings } from "../../src/checks/registry.ts";
import type { CheckSpec, Signal } from "../../src/core/types.ts";
import { readConfig } from "../../src/load/config.ts";
import { COOLDOWN_MS, isCoolingDown, recordFailure, recordSuccess } from "../../src/providers/breaker.ts";
import { envProxyActive } from "../../src/providers/openai-compat.ts";
import { isLoopbackUrl, remoteRefusal } from "../../src/providers/policy.ts";
import { type ContextOptions, checkContext, pluginSpec, promptEvent, useTempHome } from "./support.ts";

useTempHome();
const classify = getCheck("classify");
assert.ok(classify);

interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

interface Seen {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

/** A fake OpenAI-compatible server on 127.0.0.1; `reply` decides each response. */
const seen: Seen[] = [];
let reply: (body: Record<string, unknown>) => Reply = () => ({ body: chat({ label: "design", confidence: 0.9 }) });
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => {
    raw += c;
  });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    seen.push({ headers: req.headers, body });
    const r = reply(body);
    setTimeout(() => {
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...r.headers });
      res.end(JSON.stringify(r.body ?? {}));
    }, r.delayMs ?? 0);
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
after(() => {
  server.closeAllConnections();
  server.close();
});

function chat(answer: unknown): unknown {
  return {
    choices: [
      { message: { role: "assistant", content: typeof answer === "string" ? answer : JSON.stringify(answer) } },
    ],
  };
}

const LABELS = ["design", "bugfix", "other"];
let providerSeq = 0;

/** Runs the check against its own provider name, so breaker state never leaks between tests. */
async function run(
  provider: Partial<ProviderSettings> = {},
  options: ContextOptions & { spec?: Partial<CheckSpec>; name?: string } = {},
): Promise<{ signal: Signal; name: string }> {
  const name = options.name ?? `p${++providerSeq}`;
  const spec: CheckSpec = {
    kind: "classify",
    provider: name,
    labels: LABELS,
    target: "design",
    instructions: "design means a visual or UI request",
    ...options.spec,
  };
  const providers = { [name]: { kind: "openai_compat", url: baseUrl, model: "test-model", ...provider } };
  const ctx = checkContext(pluginSpec("/tmp", { c: spec }), {
    event: promptEvent("make it premium"),
    providers,
    ...options,
  });
  return { signal: await classify!.run(spec, ctx), name };
}

test("the target label scores the model's confidence", async () => {
  reply = () => ({ body: chat({ label: "design", confidence: 0.9 }) });
  seen.length = 0;
  const { signal } = await run();
  assert.deepEqual(signal, { value: 0.9 });
  const req = seen[0];
  assert.ok(req);
  assert.equal(req.body.model, "test-model");
  assert.equal(req.body.temperature, 0);
  const format = req.body.response_format as { type: string; json_schema: { strict: boolean; schema: any } };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.properties.label.enum, LABELS);
  assert.equal(format.json_schema.schema.additionalProperties, false);
  const messages = req.body.messages as { role: string; content: string }[];
  assert.equal(messages[1]?.content, "make it premium");
  assert.match(messages[0]?.content ?? "", /design means a visual/);
  assert.equal(req.headers.authorization, undefined);
});

test("another label inverts the score and max_chars cuts the text", async () => {
  reply = () => ({ body: chat({ label: "bugfix", confidence: 0.8 }) });
  seen.length = 0;
  const { signal } = await run({}, { spec: { max_chars: 4 } });
  assert.ok(Math.abs((signal.value as number) - 0.2) < 1e-9);
  assert.equal(signal.evidence, undefined);
  assert.equal((seen[0]?.body.messages as { content: string }[])[1]?.content, "make");
});

test("malformed answers give unknown and do not trip the breaker", async () => {
  const bad = [
    chat("not json"),
    chat({ label: "unlisted", confidence: 0.9 }),
    chat({ label: "design", confidence: "high" }),
    chat({ label: "design", confidence: 1.5 }),
    { choices: [] },
    "plain string",
  ];
  for (const body of bad) {
    reply = () => ({ body });
    const { signal, name } = await run();
    assert.equal(signal.value, null);
    assert.equal(signal.error, "provider returned no valid label and confidence");
    assert.equal(isCoolingDown(name), false);
  }
});

test("a timeout gives unknown and cools the provider down", async () => {
  reply = () => ({ delayMs: 500, body: chat({ label: "design", confidence: 0.9 }) });
  const started = performance.now();
  const { signal, name } = await run({ timeoutMs: 50 });
  assert.equal(signal.error, "provider timed out after 50 ms");
  assert.ok(performance.now() - started < 400);
  assert.equal(isCoolingDown(name), true);
});

test("the hub deadline is not blamed on the provider", async () => {
  reply = () => ({ delayMs: 500, body: chat({ label: "design", confidence: 0.9 }) });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const { signal, name } = await run({ timeoutMs: 2000 }, { signal: controller.signal });
  assert.equal(signal.error, "deadline reached");
  assert.equal(isCoolingDown(name), false);
});

test("a timeout clipped by a fractional hub budget is not blamed on the provider", async () => {
  reply = () => ({ delayMs: 500, body: chat({ label: "design", confidence: 0.9 }) });
  const { signal, name } = await run({ timeoutMs: 2000 }, { remainingMs: 80.6 });
  assert.equal(signal.error, "provider timed out after 80 ms");
  assert.equal(isCoolingDown(name), false);
});

test("allow_remote in config.toml lets a remote provider through", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hookmux-config-")), "config.toml");
  writeFileSync(
    file,
    '[providers.cloud]\nkind = "openai_compat"\nurl = "https://api.example.com/v1"\nallow_remote = true\n' +
      '[providers.plain]\nkind = "openai_compat"\nurl = "https://api.example.com/v1"\n',
  );
  const { providers } = readConfig(file);
  assert.equal(providers.cloud?.allowRemote, true);
  assert.equal(providers.plain?.allowRemote, undefined);
  assert.equal(remoteRefusal("cloud", providers.cloud!), null);
  assert.match(remoteRefusal("plain", providers.plain!) ?? "", /allow_remote/);
});

test("a 500 trips the breaker and later runs skip the provider", async () => {
  reply = () => ({ status: 500, body: { error: "boom" } });
  seen.length = 0;
  const first = await run();
  assert.equal(first.signal.error, "provider returned HTTP 500");
  assert.equal(seen.length, 1);
  const second = await run({}, { name: first.name });
  assert.equal(second.signal.error, "provider cooling down");
  assert.equal(seen.length, 1);
  assert.equal(isCoolingDown(first.name, Date.now() + COOLDOWN_MS + 1), false);
});

test("a success clears an earlier failure", () => {
  recordFailure("flaky");
  assert.equal(isCoolingDown("flaky"), true);
  recordSuccess("flaky");
  assert.equal(isCoolingDown("flaky"), false);
});

test("a 4xx or a redirect gives unknown without tripping the breaker", async () => {
  reply = () => ({ status: 401, body: { error: "no key" } });
  const denied = await run();
  assert.equal(denied.signal.error, "provider returned HTTP 401");
  assert.equal(isCoolingDown(denied.name), false);
  reply = () => ({ status: 307, headers: { location: "http://example.com/v1/chat/completions" } });
  const bounced = await run();
  assert.match(bounced.signal.error ?? "", /redirect/);
});

test("a remote provider is refused unless allow_remote is set", async () => {
  seen.length = 0;
  const { signal } = await run({ url: "http://example.com/v1" });
  assert.equal(signal.value, null);
  assert.match(signal.error ?? "", /allow_remote = true/);
  assert.equal(seen.length, 0);
  for (const url of ["http://localhost:8080", "http://127.0.0.1", "http://127.4.5.6:1/v1", "http://[::1]:11434/v1"]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ["http://127.0.0.1.example.com", "http://localhost.evil.com", "http://10.0.0.1", "not a url"]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

test("the API key header is sent only when its env var is set", async () => {
  reply = () => ({ body: chat({ label: "design", confidence: 0.5 }) });
  seen.length = 0;
  delete process.env.HOOKMUX_TEST_KEY;
  await run({ apiKeyEnv: "HOOKMUX_TEST_KEY" });
  assert.equal(seen[0]?.headers.authorization, undefined);
  process.env.HOOKMUX_TEST_KEY = "sk-test";
  try {
    await run({ apiKeyEnv: "HOOKMUX_TEST_KEY" });
    assert.equal(seen[1]?.headers.authorization, "Bearer sk-test");
  } finally {
    delete process.env.HOOKMUX_TEST_KEY;
  }
});

test("validation checks labels, target, instructions and max_chars", () => {
  const problems = (options: Partial<CheckSpec>) =>
    classify.validate({
      kind: "classify",
      provider: "local",
      labels: ["a", "b"],
      target: "a",
      instructions: "x",
      ...options,
    });
  assert.deepEqual(problems({}), []);
  assert.match(problems({ labels: ["a"] }).join(), /labels/);
  assert.match(problems({ labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }).join(), /labels/);
  assert.match(problems({ labels: ["a", "a"] }).join(), /unique/);
  assert.match(problems({ target: "c" }).join(), /target/);
  assert.match(problems({ instructions: "" }).join(), /instructions/);
  assert.match(problems({ instructions: "x".repeat(2001) }).join(), /2000/);
  assert.match(problems({ provider: "" }).join(), /provider/);
  assert.match(problems({ max_chars: 0 }).join(), /max_chars/);
  assert.match(problems({ field: "nope" }).join(), /field/);
});

test("an unknown provider name or kind gives unknown", async () => {
  const spec: CheckSpec = { kind: "classify", provider: "missing", labels: ["a", "b"], target: "a", instructions: "x" };
  const ctx = checkContext(pluginSpec("/tmp", { c: spec }));
  assert.match((await classify.run(spec, ctx)).error ?? "", /not configured/);
  const odd = checkContext(pluginSpec("/tmp", { c: spec }), { providers: { missing: { kind: "grpc", url: baseUrl } } });
  assert.match((await classify.run(spec, odd)).error ?? "", /not supported/);
});

test("an env proxy stops a local provider before any request, unless allow_remote", async () => {
  process.env.NODE_USE_ENV_PROXY = "1";
  try {
    reply = () => ({ body: chat({ label: "design", confidence: 0.9 }) });
    seen.length = 0;
    const local = await run();
    assert.equal(local.signal.value, null);
    assert.match(local.signal.error ?? "", /environment proxy is active/);
    assert.equal(seen.length, 0, "no request was sent");
    assert.equal(isCoolingDown(local.name), false, "a refusal is not a provider fault");
    assert.equal((await run({ allowRemote: true })).signal.value, 0.9);
  } finally {
    delete process.env.NODE_USE_ENV_PROXY;
  }
});

test("--use-env-proxy is seen on the command line and in NODE_OPTIONS", () => {
  assert.equal(envProxyActive({}, []), false);
  assert.equal(envProxyActive({ NODE_USE_ENV_PROXY: "" }, []), false);
  assert.equal(envProxyActive({}, ["--use-env-proxy"]), true);
  assert.equal(envProxyActive({ NODE_OPTIONS: "--max-old-space-size=99 --use-env-proxy" }, []), true);
});
