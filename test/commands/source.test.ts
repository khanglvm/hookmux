import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSource, SourceError } from "../../src/install/source.ts";

const none = () => false;

test("parseSource reads GitHub shorthand with an optional ref", () => {
  assert.deepEqual(parseSource("acme/hooks", none), {
    kind: "git",
    url: "https://github.com/acme/hooks.git",
    ref: null,
    subpath: null,
  });
  assert.equal((parseSource("acme/hooks@v1.2", none) as { ref: string }).ref, "v1.2");
});

test("parseSource reads a folder path after owner/repo, before an optional ref", () => {
  assert.deepEqual(parseSource("acme/hooks/plugins/guard", none), {
    kind: "git",
    url: "https://github.com/acme/hooks.git",
    ref: null,
    subpath: "plugins/guard",
  });
  assert.deepEqual(parseSource("acme/hooks/plugins/guard@release/v2", none), {
    kind: "git",
    url: "https://github.com/acme/hooks.git",
    ref: "release/v2",
    subpath: "plugins/guard",
  });
  assert.throws(() => parseSource("acme/hooks/../secrets", none), SourceError);
  assert.throws(() => parseSource("acme/hooks/a//b", none), SourceError);
  assert.throws(() => parseSource("github.com/acme/hooks", none), /host name/);
});

test("parseSource splits a GitHub tree URL into repo, ref and subpath", () => {
  assert.deepEqual(parseSource("https://github.com/acme/hooks/tree/main/plugins/guard", none), {
    kind: "git",
    url: "https://github.com/acme/hooks.git",
    ref: "main",
    subpath: "plugins/guard",
  });
});

test("parseSource keeps other https and git@ URLs as given", () => {
  assert.equal(
    (parseSource("https://gitlab.example.com/a/b.git", none) as { url: string }).url,
    "https://gitlab.example.com/a/b.git",
  );
  assert.equal(
    (parseSource("git@github.com:acme/hooks.git", none) as { url: string }).url,
    "git@github.com:acme/hooks.git",
  );
});

test("an existing path wins over the owner/repo shorthand", () => {
  assert.equal(parseSource("plugins/guard", () => true).kind, "local");
  assert.equal(parseSource("./anything", none).kind, "local");
});

test("parseSource refuses option-like refs, credentials and other schemes", () => {
  assert.throws(() => parseSource("acme/hooks@--upload-pack=x", none), SourceError);
  assert.throws(() => parseSource("https://user:token@github.com/a/b.git", none), /credentials/);
  assert.throws(() => parseSource("http://github.com/a/b", none), /only https/);
  assert.throws(() => parseSource("https://github.com/a/b/tree/main/x%2F..%2Fy", none), SourceError);
});
