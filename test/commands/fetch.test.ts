// fetchSource's git path against a local repository (file:// URL), so the
// clone flags, commit lookup and cleanup run without the network.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { discoverPlugins } from "../../src/install/discover.ts";
import { fetchSource } from "../../src/install/fetch.ts";
import { moodboardCopy, sandbox } from "./helpers.ts";

test("fetchSource clones a git repo, reports its commit and cleans up", async () => {
  const sb = sandbox();
  const repo = moodboardCopy(sb, "repo");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: sb.env, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");

  const fetched = await fetchSource({ kind: "git", url: `file://${repo}`, ref: "main", subpath: null });
  assert.match(fetched.commit ?? "", /^[0-9a-f]{40}$/);
  assert.deepEqual(discoverPlugins(fetched.root), [fetched.root]);
  assert.ok(existsSync(join(fetched.root, "plugin.toml")));
  fetched.cleanup();
  assert.ok(!existsSync(fetched.root));
});
