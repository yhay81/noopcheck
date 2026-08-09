import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../dist/init.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "noopcheck-init-"));
}

test("writes the workflow and the agent section", async () => {
  const dir = scratch();
  try {
    const actions = await runInit({ cwd: dir });
    assert.deepEqual(
      actions.map((a) => [a.path, a.action]),
      [
        [".github/workflows/noopcheck.yml", "created"],
        ["AGENTS.md", "created"],
      ],
    );
    const workflow = readFileSync(
      join(dir, ".github/workflows/noopcheck.yml"),
      "utf8",
    );
    // Two revisions is the whole promise — the workflow must not ask for more.
    assert.match(workflow, /fetch-depth: 2/);
    assert.match(workflow, /HEAD\^1 --head HEAD\^2/);
    // Silence by default: reports to the summary, gate only when uncommented.
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    assert.match(workflow, /# {3}--assert format/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is idempotent and preserves surrounding content", async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "AGENTS.md"), "# House rules\n\nBe kind.\n");
    await runInit({ cwd: dir });
    const first = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(first, /# House rules/);
    assert.match(first, /Be kind\./);

    const actions = await runInit({ cwd: dir });
    assert.deepEqual(
      actions.map((a) => a.action),
      ["unchanged", "unchanged"],
    );
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaces its own block in place rather than appending a second one", async () => {
  const dir = scratch();
  try {
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Rules\n\n<!-- noopcheck -->\nstale content\n<!-- noopcheck -->\n\nAfterword.\n",
    );
    await runInit({ cwd: dir });
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.equal(text.match(/<!-- noopcheck -->/g).length, 2);
    assert.doesNotMatch(text, /stale content/);
    assert.match(text, /# Rules/);
    assert.match(text, /Afterword\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--dry-run writes nothing", async () => {
  const dir = scratch();
  try {
    const actions = await runInit({ cwd: dir, dryRun: true });
    assert.equal(actions.length, 2);
    assert.throws(() => readFileSync(join(dir, "AGENTS.md"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each half can be skipped", async () => {
  const dir = scratch();
  try {
    const actions = await runInit({ cwd: dir, noCi: true });
    assert.deepEqual(
      actions.map((a) => a.path),
      ["AGENTS.md"],
    );
    assert.throws(() =>
      readFileSync(join(dir, ".github/workflows/noopcheck.yml"), "utf8"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
