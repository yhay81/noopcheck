import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, violations } from "../dist/index.js";

/** Throwaway git repositories, so the git plumbing is exercised for real. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "noopcheck-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  return { repo, git };
}

test("classifies format-only, rename-only, changed and whitespace-only per file", async () => {
  const { repo, git } = makeRepo();
  try {
    writeFileSync(
      join(repo, "fmt.ts"),
      "export function f(a: number) { return a + 1; }\n",
    );
    writeFileSync(
      join(repo, "ren.ts"),
      "const alpha = 1;\nexport function g(x: number) { return x + alpha; }\n",
    );
    writeFileSync(
      join(repo, "chg.ts"),
      "export function h(a: number) { return a + 1; }\n",
    );
    writeFileSync(join(repo, "doc.md"), "# title\n\nbody\n");
    git("add", "-A");
    git("commit", "-m", "base");

    writeFileSync(
      join(repo, "fmt.ts"),
      "export function f(a: number) {\n  return a + 1\n}\n",
    );
    writeFileSync(
      join(repo, "ren.ts"),
      "const beta = 1;\nexport function g(y: number) { return y + beta; }\n",
    );
    writeFileSync(
      join(repo, "chg.ts"),
      "export function h(a: number) { return a * 2; }\n",
    );
    writeFileSync(join(repo, "doc.md"), "#  title\n\n\nbody\n");
    git("add", "-A");
    git("commit", "-m", "sweep");

    const result = await runCheck(repo, "HEAD^", "HEAD");
    const byPath = new Map(result.files.map((f) => [f.path, f.verdict]));
    assert.equal(byPath.get("fmt.ts"), "format-only");
    assert.equal(byPath.get("ren.ts"), "rename-only");
    assert.equal(byPath.get("chg.ts"), "changed");
    assert.equal(byPath.get("doc.md"), "whitespace-only");

    // The gate is a superset chain: format ⊂ rename ⊂ value.
    assert.deepEqual(
      violations(result, "format")
        .map((f) => f.path)
        .sort(),
      ["chg.ts", "ren.ts"],
    );
    assert.deepEqual(
      violations(result, "rename").map((f) => f.path),
      ["chg.ts"],
    );
    // Attention = everything above formatting level, with no class declared.
    assert.deepEqual(
      result.attention.map((f) => f.path).sort(),
      ["chg.ts", "ren.ts"],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("additions and deletions are fail-closed", async () => {
  const { repo, git } = makeRepo();
  try {
    writeFileSync(join(repo, "keep.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "gone.ts"), "export const b = 2;\n");
    git("add", "-A");
    git("commit", "-m", "base");
    rmSync(join(repo, "gone.ts"));
    writeFileSync(join(repo, "new.ts"), "export const c = 3;\n");
    git("add", "-A");
    git("commit", "-m", "moveish");

    const result = await runCheck(repo, "HEAD^", "HEAD");
    const byPath = new Map(result.files.map((f) => [f.path, f.verdict]));
    assert.equal(byPath.get("gone.ts"), "deleted");
    assert.equal(byPath.get("new.ts"), "added");
    // Even the widest class never accepts an add or a delete.
    assert.equal(violations(result, "value").length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a pure file move is identical, and binaries stay unverified", async () => {
  const { repo, git } = makeRepo();
  try {
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "src", "a.ts"),
      "export function f(a: number) { return a + 1; }\n",
    );
    // A tiny PNG header — binary content we must never claim to have judged.
    writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    git("add", "-A");
    git("commit", "-m", "base");

    execFileSync("git", ["mv", "src/a.ts", "src/b.ts"], { cwd: repo });
    writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]));
    git("add", "-A");
    git("commit", "-m", "move and touch binary");

    const result = await runCheck(repo, "HEAD^", "HEAD");
    const byPath = new Map(result.files.map((f) => [f.path, f.verdict]));
    // --no-renames means a move shows as an add plus a delete: fail-closed.
    assert.equal(byPath.get("src/b.ts"), "added");
    assert.equal(byPath.get("src/a.ts"), "deleted");
    assert.equal(byPath.get("logo.png"), "unverified");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("declaration files are not judged by the AST engine", async () => {
  const { repo, git } = makeRepo();
  try {
    writeFileSync(join(repo, "types.d.ts"), "export declare const a: number;\n");
    git("add", "-A");
    git("commit", "-m", "base");
    writeFileSync(join(repo, "types.d.ts"), "export declare const b: string;\n");
    git("add", "-A");
    git("commit", "-m", "edit");

    const result = await runCheck(repo, "HEAD^", "HEAD");
    // .d.ts is excluded from AST comparison, so it lands in the text tiers —
    // and a real content change there must not read as equivalent.
    const verdict = result.files.find((f) => f.path === "types.d.ts")?.verdict;
    assert.equal(verdict, "unverified");
    assert.equal(violations(result, "value").length, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an empty diff produces no files and no attention", async () => {
  const { repo, git } = makeRepo();
  try {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-m", "base");

    const result = await runCheck(repo, "HEAD", "HEAD");
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.attention, []);
    assert.deepEqual(violations(result, "format"), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
