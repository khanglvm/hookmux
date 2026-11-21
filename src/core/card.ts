// The approval card: what a plugin is, where it came from and what it can do,
// in plain words. One renderer feeds `add`, `promote`, the relay output, the
// hub's approval notice, the permission-prompt reason and the generated docs,
// so the person reads the same facts wherever they are asked. Pure: no
// manifest, TOML or file imports, because the hub runs it on a hook path.
//
// Security: everything an author controls (description, file names, source,
// provider and variable names) goes through safeText or a name check before it
// reaches a terminal or a client's prompt, so a plugin cannot forge card lines.

import type { CanonicalEvent } from "./types.ts";

/** Cost tier of the most expensive check: 0 in-process, 1 runs a script, 2 calls a model provider. */
export type CardTier = 0 | 1 | 2;

/** Facts the card needs that the capability list does not carry; compiled into the registry. */
export interface CardFacts {
  id: string;
  version: string;
  description: string;
  /** As sources.json records it: a git URL, a folder, "bundled", or null for a plugin placed by hand. */
  source: string | null;
  ref: string | null;
  commit: string | null;
  /** Events the plugin listens to on any host. */
  events: CanonicalEvent[];
  /** Script files its checks run, relative to the plugin folder. */
  scripts: string[];
  /** Names of the [providers.<name>] its checks call. */
  modelProviders: string[];
  tier: CardTier;
}

export type Risk = "high" | "medium" | "low";

export interface CapabilityLine {
  risk: Risk;
  text: string;
  /** Wording for the one-paragraph form, when it differs from `text`. */
  short?: string;
}

export interface CardOptions {
  /** The pinned content hash, `sha256:<hex>`. */
  hash: string;
  /** What this approval is, such as "first approval". */
  approval: string;
  deadlineMs: number;
}

const MAX_DESCRIPTION = 200;
const MAX_SOURCE = 120;
const MAX_SHORT_SOURCE = 60;
const HASH_SHOWN = 4;
/** Characters of a git commit shown, as `git log --oneline` does. */
const COMMIT_SHOWN = 7;
const SAFE_FILE = /^[\w./-]{1,80}$/;
const SAFE_NAME = /^[\w.-]{1,40}$/;
const SAFE_ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RISKS: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
const SEPARATOR = " · ";

/** Terminal escapes (CSI and OSC sequences), removed whole before single control characters are. */
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
/**
 * C0 and C1 controls, zero-width and bidirectional characters that can reorder or hide text, and the
 * invisible tag and variation-selector ranges, which a person cannot see but the agent relaying the
 * card reads as text. Built from a string so a formatter cannot turn the escapes into the invisible
 * characters themselves.
 */
const CONTROLS = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufe00-\\ufe0f\\ufeff\\u{e0000}-\\u{e007f}\\u{e0100}-\\u{e01ef}]",
  "gu",
);

/** Flattens author text to one printable line of at most `max` characters. */
export function safeText(text: unknown, max = MAX_DESCRIPTION): string {
  const flat = String(text ?? "")
    .replace(ESCAPES, "")
    .replace(CONTROLS, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

const hasTool = (events: CanonicalEvent[]) => events.includes("tool.before") || events.includes("tool.after");
const joinNames = (names: string[], fallback: string) => (names.length > 0 ? names.join(", ") : fallback);

/** A file name that is safe to print, or null. */
function shownFile(name: string): string | null {
  return SAFE_FILE.test(name) ? name : null;
}

function scriptLine(facts: CardFacts): CapabilityLine {
  const files = facts.scripts.map(shownFile);
  const named = files.length > 0 && files.every((f) => f !== null);
  const what = named ? joinNames(files as string[], "its script") : "its scripts";
  return { risk: "high", text: `Runs ${what} as your user, not sandboxed` };
}

function modelLine(facts: CardFacts): CapabilityLine {
  const names = facts.modelProviders.filter((n) => SAFE_NAME.test(n));
  const provider = names.length > 0 ? ` (${names.join(", ")})` : "";
  const sent = [
    ...(facts.events.includes("prompt.submit") ? ["your prompt text"] : []),
    ...(hasTool(facts.events) ? ["tool-call details"] : []),
  ];
  const sends = sent.length > 0 ? sent.join(" and ") : "event details";
  return { risk: "medium", text: `Sends ${sends} to your configured model provider${provider}` };
}

/**
 * The lines one capability earns on the card, in table order. `event:*` earns
 * none (the cost line covers it). A capability hookmux has no wording for is
 * shown as high risk rather than hidden.
 */
export function capabilityLine(capability: string, facts: CardFacts): CapabilityLine[] {
  const [code = "", arg = ""] = splitOnce(capability);
  // Events are folded into the cost line, so they earn no line of their own.
  if (code === "event") return [];
  switch (code) {
    case "script":
      return [scriptLine(facts)];
    case "block": {
      const lines: CapabilityLine[] = [];
      if (hasTool(facts.events)) lines.push({ risk: "high", text: "Can stop the agent's tool calls" });
      if (facts.events.includes("prompt.submit")) {
        lines.push({ risk: "high", text: "Can discard your prompt before the agent sees it" });
      }
      return lines;
    }
    case "model":
      return [modelLine(facts)];
    case "env": {
      const name = SAFE_ENV.test(arg) ? `$${arg}` : "an environment variable with an unusual name";
      return [
        {
          risk: "medium",
          text: `Passes ${name} from your environment to its script`,
          short: `Passes ${name} to its script`,
        },
      ];
    }
    case "inject":
      return [{ risk: "medium", text: "Adds text the agent reads and may follow" }];
    case "evidence_chars": {
      const n = /^\d{1,7}$/.test(arg) ? arg : "an unusual number of";
      return [{ risk: "medium", text: `Can quote up to ${n} characters of script output to the agent` }];
    }
    case "notify":
      return [{ risk: "low", text: "Shows you messages the agent does not see" }];
    default:
      return [{ risk: "high", text: `Uses ${safeText(capability, 40)} (hookmux has no description for it)` }];
  }
}

function splitOnce(capability: string): [string, string] {
  const i = capability.indexOf(":");
  return i < 0 ? [capability, ""] : [capability.slice(0, i), capability.slice(i + 1)];
}

/** Table order of the capability codes, so equal risks list the same way every time. */
const CODE_ORDER = ["script", "block", "model", "env", "inject", "evidence_chars", "notify"];

/** Every capability line, riskiest first, with a stable order inside a risk. */
export function capabilityLines(capabilities: string[], facts: CardFacts): CapabilityLine[] {
  const rank = (c: string) => {
    const i = CODE_ORDER.indexOf(splitOnce(c)[0]);
    return i < 0 ? CODE_ORDER.length : i;
  };
  const sorted = [...capabilities].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const lines = sorted.flatMap((c) => capabilityLine(c, facts));
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => RISKS[a.line.risk] - RISKS[b.line.risk] || a.i - b.i)
    .map((x) => x.line);
}

const FREQUENCY: [CanonicalEvent, string][] = [
  ["session.start", "At session start"],
  ["prompt.submit", "On every prompt"],
  ["tool.before", "Before every tool call"],
  ["tool.after", "After every tool call"],
];

function frequency(events: CanonicalEvent[]): string {
  const parts = FREQUENCY.filter(([e]) => events.includes(e)).map(([, text]) => text);
  if (parts.length === 0) return "On no event";
  const lowered = parts.map((p, i) => (i === 0 ? p : p.charAt(0).toLowerCase() + p.slice(1)));
  return lowered.length === 1
    ? (lowered[0] as string)
    : `${lowered.slice(0, -1).join(", ")} and ${lowered[lowered.length - 1]}`;
}

const TIER_TEXT: Record<CardTier, string> = {
  0: "in-process checks only",
  1: "runs a script",
  2: "calls your model provider",
};

/** `<frequency> · <costliest tier> · <bound>`; the bound is left out when nothing slow can run. */
export function costLine(facts: CardFacts, deadlineMs: number): string {
  const parts = [frequency(facts.events), TIER_TEXT[facts.tier]];
  if (facts.tier > 0) parts.push(`can add up to ${Math.round(deadlineMs / 100) / 10} s`);
  return parts.join(SEPARATOR);
}

/** `github.com/acme/tool`, or the folder; no scheme, no `.git`. */
function sourceName(source: string): string {
  return source
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[\w.-]+@([\w.-]+):/, "$1/")
    .replace(/\.git$/, "");
}

function fromLine(facts: CardFacts): string {
  const { source } = facts;
  if (source === null) return "unknown (the folder was placed by hand; hookmux has not reviewed it)";
  if (source === "bundled") return "bundled with hookmux";
  const at = facts.commit
    ? ` @ ${safeText(facts.commit.slice(0, COMMIT_SHOWN), COMMIT_SHOWN)}`
    : facts.ref
      ? ` @ ${safeText(facts.ref, 40)}`
      : "";
  return `${safeText(sourceName(source), MAX_SOURCE)}${at} (hookmux has not reviewed it)`;
}

function shortSource(facts: CardFacts): string {
  if (facts.source === null) return "an unknown source";
  if (facts.source === "bundled") return "hookmux";
  const name = sourceName(facts.source).replace(/^github\.com\//, "");
  // A folder path is long and its start tells the reader little, so keep its last two parts.
  const shown = name.startsWith("/") ? `…/${name.split("/").slice(-2).join("/")}` : name;
  return safeText(shown, MAX_SHORT_SOURCE);
}

function shortHash(hash: string): string {
  const [algo = "", hex = ""] = splitOnce(hash);
  return hex.length > HASH_SHOWN * 2 + 1
    ? `${algo}:${hex.slice(0, HASH_SHOWN)}…${hex.slice(-HASH_SHOWN)}`
    : safeText(hash, 20);
}

const RISK_WIDTH = 8;

/** The full card, as printed by `promote`, `add` and the relay output. No trailing newline. */
export function renderCard(facts: CardFacts, capabilities: string[], opts: CardOptions): string {
  const lines = capabilityLines(capabilities, facts);
  const out = [
    `hookmux plugin: ${facts.id} ${safeText(facts.version, 40)}`,
    `From: ${fromLine(facts)}`,
    `Does: ${safeText(facts.description) || "no description given"}`,
    `Runs: ${costLine(facts, opts.deadlineMs)}`,
    "Can:",
    ...(lines.length > 0
      ? lines.map((l) => `  ${l.risk.padEnd(RISK_WIDTH)}${l.text}`)
      : ["  none beyond reading the event"]),
  ];
  if (capabilities.includes("model")) out.push("A model alone never blocks anything.");
  out.push(`Content: ${shortHash(opts.hash)}, ${opts.approval}`);
  return out.join("\n");
}

/**
 * `<id> <version> from <source>. <cost>. <risks>.` with the high and medium lines only:
 * the part of the short form that the permission prompt and the approval notice share.
 */
export function cardSummary(facts: CardFacts, capabilities: string[], deadlineMs: number): string {
  const risky = capabilityLines(capabilities, facts).filter((l) => l.risk !== "low");
  return [
    `${facts.id} ${safeText(facts.version, 40)} from ${shortSource(facts)}.`,
    `${costLine(facts, deadlineMs)}.`,
    ...risky.map((l) => `${l.short ?? l.text}.`),
  ].join(" ");
}

/** One paragraph for a client's permission prompt reason and the relay output. */
export function renderCardShort(facts: CardFacts, capabilities: string[], deadlineMs: number): string {
  return `hookmux: approve to turn on ${cardSummary(facts, capabilities, deadlineMs)}`;
}
