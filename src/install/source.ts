// Parses the <source> argument of `hookmux add` into a local folder or a git
// clone request. Pure: the caller passes the existence check, so the rules are
// testable without a file system. An existing path always wins over the
// `owner/repo` shorthand, so `add plugins/foo` means the local folder.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type SourceSpec =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref: string | null; subpath: string | null };

export class SourceError extends Error {}

const GITHUB_SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@(.+))?$/;
const SSH_URL = /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/;
const GITHUB_TREE = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.+?))?\/?$/;
/** A branch or tag name git accepts and that cannot be read as an option. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parseSource(text: string, exists: (path: string) => boolean): SourceSpec {
  const value = text.trim();
  if (value === "") throw new SourceError("source is empty");
  const local = localPath(value);
  if (local !== null && (exists(local) || /^(\.{1,2}\/|\/|~)/.test(value))) return { kind: "local", path: local };
  if (SSH_URL.test(value)) return { kind: "git", url: value, ref: null, subpath: null };
  if (value.startsWith("https://")) return httpsSource(value);
  if (/^[a-z]+:\/\//i.test(value)) throw new SourceError("only https:// and git@ URLs are supported");
  const short = GITHUB_SHORTHAND.exec(value);
  if (short) {
    return {
      kind: "git",
      url: `https://github.com/${short[1]}/${short[2]}.git`,
      ref: checkRef(short[3]),
      subpath: null,
    };
  }
  throw new SourceError(`'${value}' is not a folder, owner/repo, https:// URL or git@ URL`);
}

function localPath(value: string): string | null {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) || !value.includes("://") ? resolve(value) : null;
}

function httpsSource(value: string): SourceSpec {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceError(`'${value}' is not a valid URL`);
  }
  // sources.json records the URL, so a token in it would be stored in plain text.
  if (url.username || url.password) {
    throw new SourceError("remove the credentials from the URL; private repos use your git credential helper");
  }
  const tree = url.hostname === "github.com" ? GITHUB_TREE.exec(url.pathname) : null;
  if (tree) {
    return {
      kind: "git",
      url: `https://github.com/${tree[1]}/${tree[2]}.git`,
      ref: checkRef(tree[3]),
      subpath: checkSubpath(tree[4]),
    };
  }
  return { kind: "git", url: value, ref: null, subpath: null };
}

function checkRef(ref: string | undefined): string | null {
  if (ref === undefined) return null;
  if (!SAFE_REF.test(ref) || ref.includes("..")) throw new SourceError(`'${ref}' is not a valid branch or tag name`);
  return ref;
}

function checkSubpath(subpath: string | undefined): string | null {
  if (subpath === undefined || subpath === "") return null;
  const parts = decodeURIComponent(subpath).split("/");
  if (parts.some((p) => p === ".." || p === "")) throw new SourceError(`'${subpath}' is not a plain folder path`);
  return parts.join("/");
}
