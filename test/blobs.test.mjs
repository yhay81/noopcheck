import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../dist/index.js";

/**
 * Content is read through one batched `git cat-file --batch` process rather
 * than a `git show` per file. That parser advances by the byte length git
 * reports, so anything that could desynchronise it — multibyte text, empty
 * files, content that looks like a batch header — belongs here. A parser
 * that slips by one byte would produce confident, wrong verdicts, which is
 * the failure this project cannot have.
 */
test("batched blob reads survive multibyte, empty, and header-like content", async () => {
  const repo = mkdtempSync(join(tmpdir(), "noopcheck-blobs-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.com");

    // Multibyte identifiers and strings: byte length != character length.
    writeFileSync(
      join(repo, "japanese.ts"),
      'export const 挨拶 = "こんにちは世界";\nexport function 送る(相手: string) { return 挨拶 + 相手; }\n',
    );
    // Empty file: size 0 must not swallow the following record.
    writeFileSync(join(repo, "empty.ts"), "");
    // Content that mimics cat-file's own framing.
    writeFileSync(
      join(repo, "trap.md"),
      "line\n0123456789abcdef0123456789abcdef01234567 blob 42\nmore\n",
    );
    // Padding, so the batch actually contains many records.
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(
        join(repo, `pad${String(i)}.ts`),
        `export const v${String(i)} = ${String(i)};\nexport function f${String(i)}() { return v${String(i)}; }\n`,
      );
    }
    git("add", "-A");
    git("commit", "-m", "base");

    // Change only the literal in the multibyte file, reformat one pad file,
    // and leave everything else alone.
    writeFileSync(
      join(repo, "japanese.ts"),
      'export const 挨拶 = "さようなら世界";\nexport function 送る(相手: string) { return 挨拶 + 相手; }\n',
    );
    writeFileSync(join(repo, "empty.ts"), "export const x = 1;\n");
    writeFileSync(
      join(repo, "trap.md"),
      "line\n0123456789abcdef0123456789abcdef01234567 blob 42\nmore text\n",
    );
    writeFileSync(
      join(repo, "pad0.ts"),
      "export const v0 = 0\n\nexport function f0() {\n  return v0\n}\n",
    );
    git("add", "-A");
    git("commit", "-m", "edit");

    const result = await runCheck(repo, "HEAD^", "HEAD");
    const byPath = new Map(result.files.map((f) => [f.path, f.verdict]));
    // Every verdict here is only reachable if the batch stayed in sync.
    assert.equal(byPath.get("japanese.ts"), "value-only");
    assert.equal(byPath.get("pad0.ts"), "format-only");
    assert.equal(byPath.get("trap.md"), "unverified");
    // Empty → non-empty is an ordinary content change, not an addition.
    assert.equal(byPath.get("empty.ts"), "changed");
    assert.equal(result.files.length, 4);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
