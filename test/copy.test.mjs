import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyWorktreeIncludes } from "../server/copy.ts";

async function fixture(t, ignored) {
  const root = await mkdtemp(join(tmpdir(), "paseo-worktreeinclude-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const worktree = join(root, "worktree");
  await mkdir(source);
  const git = (...args) => execFileSync("git", args, { cwd: source, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(source, ".gitignore"), ignored);
  await writeFile(join(source, "tracked.txt"), "tracked");
  git("add", ".gitignore", "tracked.txt");
  git("commit", "-qm", "initial");
  git("worktree", "add", "-q", worktree);
  return { root, source, worktree };
}

test("copies existing rules and links explicitly named ignored directories", { skip: process.platform === "win32" }, async (t) => {
  const { source, worktree } = await fixture(t, ".env\nnode_modules\n");
  await writeFile(join(source, ".env"), "copied");
  await mkdir(join(source, "node_modules"));
  await writeFile(join(source, "node_modules", "package.json"), "before");
  await writeFile(join(source, ".worktreeinclude"), ".env\nsymlink node_modules\n");

  assert.deepEqual(await copyWorktreeIncludes(worktree), {
    kind: "copied", copied: [".env"], linked: ["node_modules"], skipped: [],
  });
  assert.equal(await readFile(join(worktree, ".env"), "utf8"), "copied");
  assert.equal(await realpath(join(worktree, "node_modules")), await realpath(join(source, "node_modules")));
  await writeFile(join(source, "node_modules", "package.json"), "after");
  assert.equal(await readFile(join(worktree, "node_modules", "package.json"), "utf8"), "after");
});

test("skips unsafe, tracked, missing, external and existing link targets", { skip: process.platform === "win32" }, async (t) => {
  const { root, source, worktree } = await fixture(t, ".env\nexternal\n");
  await writeFile(join(source, ".env"), "source");
  await writeFile(join(worktree, ".env"), "existing");
  await writeFile(join(root, "outside"), "outside");
  await symlink(join(root, "outside"), join(source, "external"));
  await writeFile(join(source, ".worktreeinclude"), [
    "symlink .env", "symlink tracked.txt", "symlink ../outside", "symlink missing", "symlink external",
  ].join("\n"));

  const result = await copyWorktreeIncludes(worktree);
  assert.equal(result.kind, "copied");
  assert.deepEqual(result.linked, []);
  assert.deepEqual(result.skipped, [".env", "tracked.txt", "../outside", "missing", "external"]);
  assert.equal(await readFile(join(worktree, ".env"), "utf8"), "existing");
});

test("preserves gitignore negation for copy patterns", async (t) => {
  const { source, worktree } = await fixture(t, ".env*\n");
  await writeFile(join(source, ".env.keep"), "keep");
  await writeFile(join(source, ".env.skip"), "skip");
  await writeFile(join(source, ".worktreeinclude"), ".env*\n!.env.skip\n");
  const result = await copyWorktreeIncludes(worktree);
  assert.equal(result.kind, "copied");
  assert.deepEqual(result.copied, [".env.keep"]);
});

test("links ignored files and leaves existing or tracked destinations alone", { skip: process.platform === "win32" }, async (t) => {
  const { source, worktree } = await fixture(t, ".env.local\nshared\n");
  await writeFile(join(source, ".env.local"), "before");
  await mkdir(join(source, "shared"));
  await writeFile(join(source, "shared", "secret"), "source");
  await mkdir(join(worktree, "shared"));
  await writeFile(join(worktree, "shared", "secret"), "existing");
  await writeFile(join(source, ".worktreeinclude"), "symlink .env.local\nsymlink shared\nsymlink tracked.txt\n");

  const result = await copyWorktreeIncludes(worktree);
  assert.equal(result.kind, "copied");
  assert.deepEqual(result.linked, [".env.local"]);
  assert.deepEqual(result.skipped, ["shared", "tracked.txt"]);
  await writeFile(join(source, ".env.local"), "after");
  assert.equal(await readFile(join(worktree, ".env.local"), "utf8"), "after");
  assert.equal(await readFile(join(worktree, "shared", "secret"), "utf8"), "existing");
});

test("does not write through a symlinked destination parent", { skip: process.platform === "win32" }, async (t) => {
  const { root, source, worktree } = await fixture(t, "config/\n");
  await mkdir(join(source, "config"));
  await writeFile(join(source, "config", "secret"), "source");
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(worktree, "config"));
  await writeFile(join(source, ".worktreeinclude"), "symlink config/secret\ncopy config/secret\n");

  const result = await copyWorktreeIncludes(worktree);
  assert.equal(result.kind, "copied");
  assert.deepEqual(result.skipped, ["config/secret", "config/secret"]);
  await assert.rejects(readFile(join(root, "outside", "secret")));
});
