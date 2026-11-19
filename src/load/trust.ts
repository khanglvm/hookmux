// Content pins for installed plugins. `promote` records a SHA-256 of the whole
// plugin folder; the registry skips a plugin whose folder no longer matches, so
// an edit after approval (by a person, an agent or an update) needs approval again.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { getCheck } from "../checks/registry.ts";
import { DEFAULT_EVIDENCE_CHARS, declaredEnv, scriptEvidenceLimit } from "../checks/script.ts";
import type { PluginSpec } from "../core/types.ts";
import { readJson, writeFileAtomic } from "../runtime/fsutil.ts";

const MAX_PLUGIN_FILES = 200;
const MAX_PLUGIN_BYTES = 4 * 1024 * 1024;

export interface TrustEntry {
  hash: string;
  capabilities: string[];
  promotedAt: string;
  /** "standing" when `hookmux add` pinned this content under a standing approval. */
  via?: "promote" | "standing";
  standing?: StandingApproval;
}

/**
 * Granted by a person through `hookmux promote <id> --standing`: a later
 * `hookmux add` of this plugin is pinned without asking while its capabilities
 * stay within this ceiling. Security: anyone who can run `hookmux add --force`
 * can then replace the plugin's files within the ceiling; the ceiling does not
 * cover matchers, globs or the phase.
 */
export interface StandingApproval {
  capabilities: string[];
  grantedAt: string;
}

export interface TrustStore {
  plugins: Record<string, TrustEntry>;
}

export function readTrust(file: string): TrustStore {
  const store = readJson<TrustStore>(file, { plugins: {} });
  if (!store || typeof store.plugins !== "object" || store.plugins === null) return { plugins: {} };
  // An entry without a capability list approves nothing beyond its hash, so overrides
  // that add any capability send the plugin back to promote.
  for (const entry of Object.values(store.plugins)) {
    if (entry && !Array.isArray(entry.capabilities)) entry.capabilities = [];
  }
  return store;
}

export function writeTrust(file: string, store: TrustStore): void {
  writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`);
}

/** Files and folders in a plugin, sorted; symlinks are refused so a pin covers real content only. */
export function listPluginFiles(dir: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [dir];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".DS_Store") continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${relative(dir, full)} is a symlink; plugins may not contain links`);
      if (entry.isDirectory()) {
        dirs.push(full);
        walk(full);
      } else if (entry.isFile()) files.push(full);
      if (files.length > MAX_PLUGIN_FILES) throw new Error(`more than ${MAX_PLUGIN_FILES} files`);
    }
  };
  walk(dir);
  files.sort();
  return { files, dirs };
}

/** One plugin file read into memory, so its hash and its parsed content come from the same bytes. */
export interface PluginFile {
  /** Path relative to the plugin folder, with forward slashes. */
  rel: string;
  bytes: Buffer;
}

/**
 * Reads every plugin file once, in sorted order.
 * @throws Error for links, too many files or a folder over MAX_PLUGIN_BYTES.
 */
export function readPluginFiles(dir: string): { files: PluginFile[]; dirs: string[]; paths: string[] } {
  const listing = listPluginFiles(dir);
  const files: PluginFile[] = [];
  let total = 0;
  for (const file of listing.files) {
    // Checked before reading so a huge file is refused without loading it.
    total += lstatSync(file).size;
    if (total > MAX_PLUGIN_BYTES) throw new Error(`plugin folder is larger than ${MAX_PLUGIN_BYTES} bytes`);
    files.push({ rel: relative(dir, file).replaceAll("\\", "/"), bytes: readFileSync(file) });
  }
  return { files, dirs: listing.dirs, paths: listing.files };
}

/**
 * Hash over each file's relative path, byte length and bytes, in sorted order:
 * `path \0 length \0 content`, the shape used by the skills CLI lockfile.
 */
export function hashFiles(files: PluginFile[]): string {
  const hash = createHash("sha256");
  for (const { rel, bytes } of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** SHA-256 per file, keyed by relative path, so a script can be re-verified right before it runs. */
export function fileHashesOf(files: PluginFile[]): Record<string, string> {
  return Object.fromEntries(files.map((f) => [f.rel, createHash("sha256").update(f.bytes).digest("hex")]));
}

export function hashPlugin(dir: string): string {
  return hashFiles(readPluginFiles(dir).files);
}

/** What a plugin can do, derived from its manifest rather than from its own claims. */
export function capabilitiesOf(spec: PluginSpec, variants: PluginSpec[] = []): string[] {
  const caps = new Set<string>();
  for (const s of [spec, ...variants]) {
    for (const e of s.events) caps.add(`event:${e}`);
    for (const e of s.effects) caps.add(e.effect);
    for (const c of Object.values(s.checks)) {
      const kind = getCheck(c.kind);
      if (kind?.tier === 1) caps.add("script");
      if (c.kind === "script") {
        for (const name of declaredEnv(c)) caps.add(`env:${name}`);
        const evidenceLimit = scriptEvidenceLimit(c);
        if (evidenceLimit > DEFAULT_EVIDENCE_CHARS) caps.add(`evidence_chars:${evidenceLimit}`);
      }
      if (kind?.modelBacked) caps.add("model");
    }
  }
  return [...caps].sort();
}

const EVIDENCE_CAP = /^evidence_chars:(\d+)$/;

/** True when `approved` covers `capability`; an approved evidence_chars limit covers any lower one. */
function covers(approved: string[], capability: string): boolean {
  if (approved.includes(capability)) return true;
  const wanted = EVIDENCE_CAP.exec(capability);
  if (!wanted) return false;
  return approved.some((a) => {
    const granted = EVIDENCE_CAP.exec(a);
    return granted !== null && Number(granted[1]) >= Number(wanted[1]);
  });
}

/** Capabilities in `effective` that `approved` does not cover. */
export function uncoveredCapabilities(effective: string[], approved: string[]): string[] {
  return effective.filter((c) => !covers(approved, c));
}

/** True when every capability in `effective` was approved at promote time. */
export function isCapabilitySubset(effective: string[], approved: string[]): boolean {
  return uncoveredCapabilities(effective, approved).length === 0;
}

/** Inject/notify-only plugins without scripts can be auto-trusted when the user allows it. */
export function isDeclarativeOnly(capabilities: string[]): boolean {
  return !capabilities.some((c) => c === "block" || c === "script");
}
