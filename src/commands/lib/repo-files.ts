// The files `hookmux new --repo` adds so the plugin folder can be pushed as a
// repository people install from: a README with the install lines, and a CI
// workflow that validates and tests the plugin on every push.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderCard } from "../../core/card.ts";
import { cardFactsOf } from "../../load/card-facts.ts";
import { readConfig } from "../../load/config.ts";
import { compileManifest, readManifest } from "../../load/manifest.ts";
import { capabilitiesOf } from "../../load/trust.ts";
import { homePaths } from "../../runtime/paths.ts";
import { VERSION } from "../../version.ts";
import { loadDefaults } from "./plugins.ts";
import { type ScaffoldFile, TEMPLATE_SUMMARY, type TemplateName } from "./templates.ts";

/** Shown in the README until the author knows the GitHub path. */
export const REPO_PLACEHOLDER = "OWNER/NAME";

/** Marks where `fillReadmeCard` inserts the plugin's approval card. */
export const CARD_MARKER = "<!-- card -->";

// Pinned by commit SHA, the same pins as this repository's own workflows.
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0";

function readme(id: string, template: TemplateName, repo: string): string {
  const install = `npx -y hookmux install ${repo}`;
  return `# ${id}

A hookmux plugin that ${TEMPLATE_SUMMARY[template]}.

## Install

\`\`\`sh
${install}
\`\`\`

Or paste this to your agent:

> Install the ${id} plugin with hookmux: run \`${install}\`, show me the approval card it prints word for word, and wait for my answer.

The plugin stays off until you approve it.

${CARD_MARKER}
`;
}

function workflow(id: string): string {
  return `name: hookmux

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    name: check ${id}
    runs-on: ubuntu-latest
    steps:
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${SETUP_NODE}
        with:
          node-version: "22"
      - run: npx -y hookmux@${VERSION} validate .
      - run: npx -y hookmux@${VERSION} test . --run-scripts
`;
}

/** README and CI workflow for a plugin that is also a repository root; \`repo\` is owner/name or empty. */
export function repoFiles(id: string, template: TemplateName, repo: string): ScaffoldFile[] {
  return [
    { path: "README.md", content: readme(id, template, repo || REPO_PLACEHOLDER), mode: 0o644 },
    { path: ".github/workflows/hookmux.yml", content: workflow(id), mode: 0o644 },
  ];
}

/** Plain-language lead-in to the card in a plugin README. */
const CARD_HEADING = "What your users approve before it turns on:";

/**
 * The card as a user will see it, for the plugin folder `dir` published at `repo`.
 * The content hash line is dropped: the README is part of the plugin folder, so any hash
 * printed in it would be stale the moment it was written.
 */
function readmeCard(dir: string, id: string, repo: string): string {
  const paths = homePaths();
  const config = readConfig(paths.config);
  const compiled = compileManifest(readManifest(dir), dir, undefined, loadDefaults(config));
  const facts = cardFactsOf({
    id,
    base: compiled.base,
    variants: Object.values(compiled.variants),
    // The URL `hookmux install owner/name` records, so the From line reads as the user's card will.
    source: { source: `https://github.com/${repo || REPO_PLACEHOLDER}.git`, ref: null, commit: null },
  });
  const capabilities = capabilitiesOf(compiled.base, Object.values(compiled.variants));
  const card = renderCard(facts, capabilities, { hash: "", approval: "", deadlineMs: config.settings.deadlineMs });
  return card
    .split("\n")
    .filter((line) => !line.startsWith("Content:"))
    .join("\n");
}

/** Replaces the README's card placeholder with the card for the scaffold on disk, so it cannot drift from the manifest. */
export function fillReadmeCard(dir: string, id: string, repo: string): void {
  const file = join(dir, "README.md");
  const text = readFileSync(file, "utf8");
  const block = `${CARD_HEADING}\n\n\`\`\`text\n${readmeCard(dir, id, repo)}\n\`\`\``;
  writeFileSync(file, text.replace(CARD_MARKER, block));
}
