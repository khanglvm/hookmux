// Classifier for any server with an OpenAI-style POST /chat/completions.
// The answer is constrained with `response_format` json_schema, so a compliant
// server can only return one of the labels and a confidence.
//
// response_format json_schema support, per each server's own docs:
// - OpenAI: https://platform.openai.com/docs/guides/structured-outputs
//   (strict mode needs every property in `required` and additionalProperties false).
// - llama.cpp llama-server: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
//   accepts the OpenAI wrapper form {type: "json_schema", json_schema: {name, strict, schema}}.
// - LM Studio: https://lmstudio.ai/docs/developer/openai-compat/structured-output
//   reads the schema from the json_schema field of response_format.
// - Ollama: https://docs.ollama.com/api/openai-compatibility lists `response_format`
//   as supported on /v1/chat/completions but does not say whether the json_schema
//   type is honoured. Unconfirmed; a server that ignores it fails the parse and
//   the check stays unknown.

import type { ProviderSettings } from "../checks/registry.ts";
import type { ClassifyBudget, ClassifyOutcome, ClassifyRequest } from "./types.ts";

/** Default per-request budget in milliseconds when the provider sets no timeout_ms. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 800;

export function requestBody(provider: ProviderSettings, request: ClassifyRequest): Record<string, unknown> {
  const system =
    `${request.instructions}\n\n` +
    `Classify the user's message as exactly one of these labels: ${JSON.stringify(request.labels)}. ` +
    'Reply only with JSON {"label": <one label>, "confidence": <number from 0 to 1>}.';
  return {
    ...(provider.model ? { model: provider.model } : {}),
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: request.text },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "classification",
        strict: true,
        // minimum/maximum are left out because strict-mode support for them is not
        // documented everywhere; parseClassification range-checks instead.
        schema: {
          type: "object",
          properties: { label: { type: "string", enum: request.labels }, confidence: { type: "number" } },
          required: ["label", "confidence"],
          additionalProperties: false,
        },
      },
    },
  };
}

/** Reads `choices[0].message.content` as the classification JSON; null when anything is off. */
export function parseClassification(body: unknown, labels: string[]): { label: string; confidence: number } | null {
  const content = (body as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  let answer: unknown;
  try {
    answer = JSON.parse(content);
  } catch {
    return null;
  }
  const { label, confidence } = (answer ?? {}) as { label?: unknown; confidence?: unknown };
  if (typeof label !== "string" || !labels.includes(label)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { label, confidence };
}

function headers(provider: ProviderSettings): Record<string, string> {
  const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
  return { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

/**
 * Status codes that mean the provider is overloaded or broken rather than
 * misconfigured: any 5xx, plus 429 so a rate-limited provider backs off.
 */
function isProviderFaultStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export async function classifyOpenAICompat(
  provider: ProviderSettings,
  request: ClassifyRequest,
  budget: ClassifyBudget,
): Promise<ClassifyOutcome> {
  const ownTimeout = provider.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const timeoutMs = Math.min(ownTimeout, budget.remainingMs);
  if (budget.deadline.aborted || timeoutMs <= 0) return { ok: false, error: "deadline reached", providerFault: false };
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(`${provider.url.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: headers(provider),
      body: JSON.stringify(requestBody(provider, request)),
      // A loopback server must not be able to bounce the prompt to another host.
      redirect: "manual",
      signal: AbortSignal.any([budget.deadline, timeout]),
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: "provider redirected; redirects are not followed", providerFault: false };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: `provider returned HTTP ${response.status}`,
        providerFault: isProviderFaultStatus(response.status),
      };
    }
    const parsed = parseClassification(await response.json().catch(() => null), request.labels);
    if (!parsed) return { ok: false, error: "provider returned no valid label and confidence", providerFault: false };
    return { ok: true, ...parsed };
  } catch (error) {
    if (budget.deadline.aborted) return { ok: false, error: "deadline reached", providerFault: false };
    // A timeout cut short by the hub deadline is not the provider's fault.
    if (timeout.aborted) {
      return { ok: false, error: `provider timed out after ${timeoutMs} ms`, providerFault: timeoutMs === ownTimeout };
    }
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    return {
      ok: false,
      error: `provider unreachable${typeof code === "string" ? ` (${code})` : ""}`,
      providerFault: true,
    };
  }
}
