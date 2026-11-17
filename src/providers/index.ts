// Provider kinds a `[providers.<name>]` table can name in its `kind` field.

import { classifyOpenAICompat } from "./openai-compat.ts";
import type { Classifier } from "./types.ts";

const CLASSIFIERS: Record<string, Classifier> = {
  openai_compat: classifyOpenAICompat,
};

export function classifierFor(kind: string): Classifier | undefined {
  return Object.hasOwn(CLASSIFIERS, kind) ? CLASSIFIERS[kind] : undefined;
}
