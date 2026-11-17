// Reads the user's ~/.hookmux/config.toml: hub settings, model providers and
// per-plugin overrides. A missing file means defaults; an invalid one is reported
// by `doctor` and the hook keeps running on defaults.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import type { ProviderSettings } from "../checks/registry.ts";
import type { Origin } from "../core/types.ts";
import type { RawManifest } from "./manifest.ts";

export interface HubSettings {
  deadlineMs: number;
  blockRequiresRule: boolean;
  routeOrigins: Origin[];
  contextBudget: number;
  /** Trust declarative, inject/notify-only plugins in the user's folder without `promote`. */
  autoTrustDeclarative: boolean;
}

export interface HubConfig {
  settings: HubSettings;
  providers: Record<string, ProviderSettings>;
  overrides: Record<string, RawManifest>;
  problems: string[];
}

export const DEFAULT_SETTINGS: HubSettings = {
  deadlineMs: 2000,
  blockRequiresRule: true,
  routeOrigins: ["user"],
  contextBudget: 9000,
  autoTrustDeclarative: false,
};

/** Hard bounds so a typo cannot make every prompt wait for a minute. */
const DEADLINE_RANGE = [50, 20_000] as const;

export function readConfig(file: string): HubConfig {
  const config: HubConfig = { settings: { ...DEFAULT_SETTINGS }, providers: {}, overrides: {}, problems: [] };
  if (!existsSync(file)) return config;
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    config.problems.push(`config.toml is invalid TOML: ${(error as Error).message}`);
    return config;
  }
  const s = table(raw.settings);
  const set = config.settings;
  if (typeof s.deadline_ms === "number") {
    set.deadlineMs = Math.min(DEADLINE_RANGE[1], Math.max(DEADLINE_RANGE[0], Math.round(s.deadline_ms)));
  }
  if (typeof s.block_requires_rule === "boolean") set.blockRequiresRule = s.block_requires_rule;
  if (Array.isArray(s.route_origins)) set.routeOrigins = s.route_origins.filter(isOrigin);
  if (typeof s.context_budget === "number" && s.context_budget > 0) set.contextBudget = Math.round(s.context_budget);
  if (typeof s.auto_trust_declarative === "boolean") set.autoTrustDeclarative = s.auto_trust_declarative;

  for (const [name, p] of Object.entries(table(raw.providers))) {
    const t = table(p);
    if (typeof t.kind !== "string" || typeof t.url !== "string") {
      config.problems.push(`providers.${name} needs kind and url`);
      continue;
    }
    config.providers[name] = {
      kind: t.kind,
      url: t.url,
      ...(typeof t.model === "string" ? { model: t.model } : {}),
      ...(typeof t.timeout_ms === "number" ? { timeoutMs: t.timeout_ms } : {}),
      ...(typeof t.api_key_env === "string" ? { apiKeyEnv: t.api_key_env } : {}),
      ...(typeof t.allow_remote === "boolean" ? { allowRemote: t.allow_remote } : {}),
    };
  }
  for (const [id, o] of Object.entries(table(raw.override))) config.overrides[id] = table(o);
  return config;
}

function table(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isOrigin(value: unknown): value is Origin {
  return value === "user" || value === "system" || value === "unknown";
}
