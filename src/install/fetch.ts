// Turns a parsed source into a folder on disk. Git sources are shallow-cloned
// into a fresh temp folder with hooks and submodules off and no shell involved;
// the caller must call cleanup() when done.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SourceSpec } from "./source.ts";

const run = promisify(execFile);
const CLONE_TIMEOUT_MS = 120_000;
/** Keeps a hostile repo from running code at clone time and keeps git from prompting. */
const GIT_SAFETY = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=user"];

export interface FetchedSource {
  /** Folder to search for plugins. */
  root: string;
  /** What sources.json records as the origin. */
  source: string;
  ref: string | null;
  commit: string | null;
  cleanup(): void;
}

/** @throws Error when the folder is missing or git fails (with git's last error line). */
export async function fetchSource(spec: SourceSpec): Promise<FetchedSource> {
  if (spec.kind === "local") {
    if (!existsSync(spec.path) || !statSync(spec.path).isDirectory()) throw new Error(`${spec.path} is not a folder`);
    // No git commands in a local folder: its .git/config could run programs (core.fsmonitor).
    return { root: spec.path, source: spec.path, ref: null, commit: null, cleanup: () => {} };
  }
  const temp = mkdtempSync(join(tmpdir(), "hookmux-add-"));
  const cleanup = () => rmSync(temp, { recursive: true, force: true });
  try {
    const repo = join(temp, "repo");
    await git([
      ...GIT_SAFETY,
      "clone",
      "--depth",
      "1",
      "--no-recurse-submodules",
      ...(spec.ref ? ["--branch", spec.ref] : []),
      "--",
      spec.url,
      repo,
    ]);
    const commit = (await git(["-C", repo, "rev-parse", "HEAD"])).trim() || null;
    const root = spec.subpath ? resolve(repo, spec.subpath) : repo;
    if (!root.startsWith(repo + sep) && root !== repo) throw new Error(`${spec.subpath} leaves the repository`);
    if (!existsSync(root)) throw new Error(`${spec.subpath} does not exist in ${spec.url}`);
    return { root, source: spec.url, ref: spec.ref, commit, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error("git is not installed or not on PATH");
    const last = (e.stderr ?? "").trim().split("\n").at(-1) || e.message;
    throw new Error(`git ${args.includes("clone") ? "clone" : args[2]} failed: ${last}`);
  }
}
