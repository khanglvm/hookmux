// The two worked approval cards that docs/plugins.md shows. They live here, not
// in the docs, so the generator renders them with src/core/card.ts and a test
// pins their exact text: the docs cannot drift from what the CLI prints.

import type { CardFacts } from "../src/core/card.ts";

export interface CardExample {
  title: string;
  facts: CardFacts;
  capabilities: string[];
  hash: string;
}

export const CARD_DEADLINE_MS = 2000;

export const CARD_EXAMPLES: CardExample[] = [
  {
    title: "A script on every tool call",
    facts: {
      id: "git-guard",
      version: "0.3.1",
      description: "Stops force-pushes to main.",
      source: "https://github.com/acme/git-guard.git",
      ref: null,
      commit: "4f2c1a94d0c9b7a1e3a2b6f5c0d1e2f3a4b5c6d7",
      events: ["tool.before"],
      scripts: ["guard.sh"],
      modelProviders: [],
      tier: 1,
    },
    capabilities: ["block", "env:GITHUB_TOKEN", "event:tool.before", "notify", "script"],
    hash: `sha256:3b9e${"0".repeat(56)}41ac`,
  },
  {
    title: "A model call on every prompt",
    facts: {
      id: "topic-router",
      version: "1.2.0",
      description: "Points the agent at the team wiki for billing questions.",
      source: "https://github.com/acme/topic-router",
      ref: null,
      commit: "9a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
      events: ["prompt.submit"],
      scripts: [],
      modelProviders: ["local"],
      tier: 2,
    },
    capabilities: ["event:prompt.submit", "inject", "model"],
    hash: `sha256:77a0${"0".repeat(56)}c2d1`,
  },
];
