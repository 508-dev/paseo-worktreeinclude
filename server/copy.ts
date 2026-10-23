import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const INCLUDE_FILE = ".worktreeinclude";

export type CopyResult =
  | { kind: "not-a-worktree" }
  | { kind: "no-include-file" }
  | { kind: "copied"; copied: string[]; linked: string[]; skipped: string[] };

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const child = exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) child.child.stdin?.end(input);
  const { stdout } = await child;
  return stdout;
}

async function gitAllowExit1(cwd: string, args: string[], input: string): Promise<string> {
  try {
    return await git(cwd, args, input);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    throw error;
  }
}

async function sourceCheckoutOf(worktree: string): Promise<string | null> {
  let out: string;
  try {
    out = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  } catch {
    return null;
  }
  const [gitDir, commonDir] = out.trim().split("\n");
  if (!gitDir || !commonDir || resolve(gitDir) === resolve(commonDir)) return null;
  return dirname(resolve(commonDir));
}

const splitNul = (s: string) => s.split("\0").filter(Boolean);

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.includes(":")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Refuse to write through a symlink or a non-directory in the destination path.
async function prepareDestination(worktree: string, path: string): Promise<string | null> {
  if (!safeRelativePath(path)) return null;
  const parts = path.split("/");
  let parent = worktree;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (!(await exists(parent))) await mkdir(parent);
    if (!(await lstat(parent)).isDirectory()) return null;
  }
  const dest = join(parent, parts.at(-1)!);
  return (await exists(dest)) ? null : dest;
}

function parseInclude(contents: string): { copy: string[]; links: string[] } {
  const copy: string[] = [];
  const links: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^symlink\s/.test(line)) {
      // Link entries are literal paths. Gitignore patterns remain available for copy entries.
      links.push(line.slice("symlink".length).trim().replace(/\/$/, ""));
    } else if (/^copy\s/.test(line)) {
      copy.push(line.slice("copy".length).trim());
    } else if (line !== "symlink" && line !== "copy") {
      copy.push(line);
    }
  }
  return { copy, links };
}

// Copies are selected by both .worktreeinclude and Git's ignore rules.
// Explicit symlinks point at live paths in the main checkout and must also be ignored.
export async function copyWorktreeIncludes(worktree: string): Promise<CopyResult> {
  const source = await sourceCheckoutOf(worktree);
  if (!source) return { kind: "not-a-worktree" };
  const canonicalSource = await realpath(source);

  let contents: string;
  try {
    contents = await readFile(join(source, INCLUDE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "no-include-file" };
    throw error;
  }
  const { copy, links } = parseInclude(contents);
  const copied: string[] = [];
  const linked: string[] = [];
  const skipped: string[] = [];

  for (const path of links) {
    if (!safeRelativePath(path) || /[*?\[\]]/.test(path)) {
      skipped.push(path);
      continue;
    }
    let canonical: string;
    try {
      canonical = await realpath(join(source, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push(path);
        continue;
      }
      throw error;
    }
    const canonicalRelative = relative(canonicalSource, canonical);
    if (
      !within(canonicalSource, canonical) ||
      canonicalRelative.split(sep).some((part) => part.toLowerCase() === ".git") ||
      (await git(worktree, ["ls-files", "-z", "--", path]))
    ) {
      skipped.push(path);
      continue;
    }
    const ignored = await gitAllowExit1(source, ["check-ignore", "--stdin", "-z"], `${path}\0`);
    if (!ignored) {
      skipped.push(path);
      continue;
    }
    const stat = await lstat(canonical);
    if (!stat.isFile() && !stat.isDirectory()) {
      skipped.push(path);
      continue;
    }
    const dest = await prepareDestination(worktree, path);
    if (!dest) {
      skipped.push(path);
      continue;
    }
    try {
      await symlink(canonical, dest, process.platform === "win32" && stat.isDirectory() ? "junction" : stat.isDirectory() ? "dir" : "file");
      linked.push(path);
    } catch (error) {
      // Windows file links may require Developer Mode. Never silently copy an explicit link.
      skipped.push(path);
      console.error(`[paseo-worktreeinclude] could not link ${path}:`, error);
    }
  }

  if (copy.length > 0) {
    const matches = splitNul(
      await git(source, ["ls-files", "--others", "--ignored", "-z", ...copy.map((pattern) => `--exclude=${pattern}`)]),
    );
    if (matches.length > 0) {
      const ignored = splitNul(
        await gitAllowExit1(source, ["check-ignore", "--stdin", "-z"], `${matches.join("\0")}\0`),
      );
      for (const file of ignored) {
        if (!safeRelativePath(file)) {
          skipped.push(file);
          continue;
        }
        const dest = await prepareDestination(worktree, file);
        if (!dest) {
          skipped.push(file);
          continue;
        }
        // Never follow a source symlink while copying.
        if (!(await lstat(join(source, file))).isFile()) {
          skipped.push(file);
          continue;
        }
        await copyFile(join(source, file), dest, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        copied.push(file);
      }
    }
  }
  return { kind: "copied", copied, linked, skipped };
}
