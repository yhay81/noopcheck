import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, violations } from "../dist/core.js";

/** 使い捨ての git リポジトリで一気通貫に検証する */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "noopcheck-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");
  return { repo, git };
}

test("format-only / rename-only / changed をファイル別に判定する", async () => {
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

    // format-only: 改行・セミコロンだけ / rename-only: 識別子だけ /
    // changed: 構造が変わる / doc.md: 空白のみ
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

    // 宣言クラスのゲート: format は rename/changed を拒む(fail-closed)
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
    // attention = format 水準を超えるもの全て
    assert.deepEqual(
      result.attention.map((f) => f.path).sort(),
      ["chg.ts", "ren.ts"],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("追加・削除は fail-closed(--assert format で必ず落ちる)", async () => {
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
    assert.equal(violations(result, "format").length, 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
