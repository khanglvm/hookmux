// Contract between the `classify` check and the model providers it can call.

import type { ProviderSettings } from "../checks/registry.ts";

export interface ClassifyRequest {
  labels: string[];
  /** Plugin-authored task description, sent as the system message. */
  instructions: string;
  /** Event text to classify, already cut to the check's max_chars. */
  text: string;
}

export interface ClassifyBudget {
  /** The hub deadline signal; its abort is never blamed on the provider. */
  deadline: AbortSignal;
  /** Milliseconds left before the hub deadline. */
  remainingMs: number;
}

export type ClassifyOutcome =
  | { ok: true; label: string; confidence: number }
  | {
      ok: false;
      /** Fixed wording only: model output and prompt text never reach traces or logs. */
      error: string;
      /** True when the provider itself failed (network, timeout, overload), so the breaker should trip. */
      providerFault: boolean;
    };

export type Classifier = (
  provider: ProviderSettings,
  request: ClassifyRequest,
  budget: ClassifyBudget,
) => Promise<ClassifyOutcome>;
