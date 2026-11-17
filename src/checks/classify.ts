// The `classify` check: asks a configured model provider which label fits the
// event text and scores the target label. Tier 2 and model-backed, so it never
// justifies a block alone and returns no evidence for templates.

import type { CheckSpec, Signal } from "../core/types.ts";
import { isCoolingDown, recordFailure, recordSuccess } from "../providers/breaker.ts";
import { classifierFor } from "../providers/index.ts";
import { remoteRefusal } from "../providers/policy.ts";
import { registerCheck } from "./registry.ts";
import { isKnownField, MAX_MATCH_CHARS, readField } from "./text.ts";

const MIN_LABELS = 2;
const MAX_LABELS = 20;
const MAX_INSTRUCTIONS_CHARS = 2000;
const DEFAULT_MAX_CHARS = 2000;

function unknown(error: string): Signal {
  return { value: null, error };
}

function labelProblems(spec: CheckSpec): string[] {
  const labels = spec.labels;
  if (
    !Array.isArray(labels) ||
    labels.length < MIN_LABELS ||
    labels.length > MAX_LABELS ||
    labels.some((l) => typeof l !== "string" || l === "")
  ) {
    return [`labels must be a list of ${MIN_LABELS} to ${MAX_LABELS} non-empty strings`];
  }
  const problems: string[] = [];
  if (new Set(labels).size !== labels.length) problems.push("labels must be unique");
  if (typeof spec.target !== "string" || !labels.includes(spec.target))
    problems.push("target must be one of the labels");
  return problems;
}

function optionProblems(spec: CheckSpec): string[] {
  const problems: string[] = [];
  if (typeof spec.provider !== "string" || spec.provider === "")
    problems.push("provider must name a [providers.<name>] table");
  const instructions = spec.instructions;
  if (typeof instructions !== "string" || instructions.trim() === "") problems.push("instructions are required");
  else if (instructions.length > MAX_INSTRUCTIONS_CHARS) {
    problems.push(`instructions are longer than ${MAX_INSTRUCTIONS_CHARS} chars`);
  }
  if (!isKnownField(spec.field)) problems.push(`field '${String(spec.field)}' is not a known event field`);
  const max = spec.max_chars;
  if (max !== undefined && (!Number.isInteger(max) || (max as number) < 1 || (max as number) > MAX_MATCH_CHARS)) {
    problems.push(`max_chars must be a whole number from 1 to ${MAX_MATCH_CHARS}`);
  }
  return problems;
}

/**
 * The model's confidence that the text is the target label. When it picks
 * another label, the rest of its confidence is read as the target's share; with
 * more than two labels this is an upper bound, not a calibrated probability.
 */
export function targetScore(label: string, confidence: number, target: string): number {
  return label === target ? confidence : 1 - confidence;
}

registerCheck({
  kind: "classify",
  summary: "Score from 0 to 1 that the field is the target label, decided by a configured model provider.",
  options: {
    provider: "name of a [providers.<name>] table in config.toml",
    labels: "list of 2 to 20 labels",
    target: "the label to score",
    instructions: "what the labels mean, at most 2000 chars",
    field: `event field to read, default "prompt"`,
    max_chars: `characters of the field sent to the model, default ${DEFAULT_MAX_CHARS}`,
  },
  tier: 2,
  output: "score",
  modelBacked: true,
  validate(spec) {
    return [...optionProblems(spec), ...labelProblems(spec)];
  },
  async run(spec, ctx) {
    const name = spec.provider as string;
    const provider = Object.hasOwn(ctx.settings.providers, name) ? ctx.settings.providers[name] : undefined;
    if (!provider) return unknown(`provider '${name}' is not configured`);
    const classify = classifierFor(provider.kind);
    if (!classify) return unknown(`provider kind '${provider.kind}' is not supported`);
    const refusal = remoteRefusal(name, provider);
    if (refusal) return unknown(refusal);
    if (isCoolingDown(name)) return unknown("provider cooling down");

    const text = readField(ctx.event, spec.field as string | undefined);
    if (text === null || text.trim() === "") return unknown("nothing to classify");
    const maxChars = (spec.max_chars as number | undefined) ?? DEFAULT_MAX_CHARS;
    const outcome = await classify(
      provider,
      { labels: spec.labels as string[], instructions: spec.instructions as string, text: text.slice(0, maxChars) },
      { deadline: ctx.signal, remainingMs: ctx.remainingMs() },
    );
    if (!outcome.ok) {
      if (outcome.providerFault) recordFailure(name);
      return unknown(outcome.error);
    }
    recordSuccess(name);
    return { value: targetScore(outcome.label, outcome.confidence, spec.target as string) };
  },
});
