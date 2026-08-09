import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRange } from "../dist/index.js";

/**
 * A synthetic history with planted facts, so every number the audit reports
 * has a hand-derived expectation:
 *
 *   1 feat:                     not a mechanical claim  → not audited
 *   2 style: reformat           truly format-only       → conforming
 *   3 refactor: rename          truly rename-only       → conforming
 *   4 style: reformat (lying)   also changes behaviour  → offender
 *   5 chore(deps): bump         only a lockfile         → conforming, unverifiable
 */
function buildHistory() {
  const repo = mkdtempSync(join(tmpdir(), "noopcheck-audit-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.com");

  const write = (name, body) => writeFileSync(join(repo, name), body);
  const commit = (subject) => {
    git("add", "-A");
    git("commit", "-m", subject);
  };

  write("a.ts", "export function f(a: number) { return a + 1; }\n");
  write("b.ts", "const alpha = 1;\nexport function g(x: number) { return x + alpha; }\n");
  write("lock.json", '{"deps": "1.0.0"}\n');
  commit("feat: initial implementation");

  write("a.ts", "export function f(a: number) {\n  return a + 1\n}\n");
  commit("style: reformat a.ts");

  write("b.ts", "const beta = 1;\nexport function g(y: number) { return y + beta; }\n");
  commit("refactor: rename the accumulator");

  // Declares itself formatting, but smuggles in a guard clause: the
  // structure moves, which is exactly what a reviewer would have wanted told.
  write(
    "a.ts",
    "export function f(a: number) {\n  if (a < 0) return 0\n  return a + 1\n}\n",
  );
  commit("style: tidy up whitespace");

  write("lock.json", '{"deps": "1.0.1"}\n');
  commit("chore(deps): bump deps to 1.0.1");

  return { repo, git };
}

test("audits only commits that declare a mechanical class", async () => {
  const { repo } = buildHistory();
  try {
    const result = await auditRange(repo, "HEAD");
    // The feat: commit makes no mechanical claim, so it is not audited.
    assert.equal(result.scanned, 4);
    assert.deepEqual(
      result.entries.map((e) => e.declared).sort(),
      ["format", "format", "rename", "value"],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("names the commit whose subject line understated the change", async () => {
  const { repo } = buildHistory();
  try {
    const result = await auditRange(repo, "HEAD");
    const offenders = result.entries.filter((e) => !e.conforming);
    assert.equal(offenders.length, 1);
    assert.match(offenders[0].subject, /tidy up whitespace/);
    assert.deepEqual(offenders[0].offenders, [
      { path: "a.ts", verdict: "changed" },
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("counts a commit with nothing verifiable, instead of failing it", async () => {
  const { repo } = buildHistory();
  try {
    const result = await auditRange(repo, "HEAD");
    const deps = result.entries.find((e) => e.declared === "value");
    // A lockfile carries no verdict: reported as unverifiable, not as a
    // violation, so release plumbing cannot bury the real signal.
    assert.equal(deps.conforming, true);
    assert.equal(deps.unverifiableFiles, 1);
    assert.equal(result.commitsWithNothingVerifiable, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("summarises conformance per declared class", async () => {
  const { repo } = buildHistory();
  try {
    const result = await auditRange(repo, "HEAD");
    assert.deepEqual(result.byClass.format, { total: 2, conforming: 1 });
    assert.deepEqual(result.byClass.rename, { total: 1, conforming: 1 });
    assert.deepEqual(result.byClass.value, { total: 1, conforming: 1 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--max bounds the work, newest first", async () => {
  const { repo } = buildHistory();
  try {
    const result = await auditRange(repo, "HEAD", { max: 1 });
    assert.equal(result.scanned, 1);
    assert.equal(result.entries[0].declared, "value"); // the newest one
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
