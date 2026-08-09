import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * `noopcheck init` — wire the check into the two places it actually runs.
 *
 * A CLI nobody remembers to type is a CLI nobody uses. The two invocation
 * paths that survive are CI (which never forgets) and the instructions a
 * coding agent reads before declaring a change done. This writes both, in
 * one command, and is safe to re-run.
 */

const WORKFLOW_PATH = ".github/workflows/noopcheck.yml";
const MARKER = "<!-- noopcheck -->";

/**
 * On a `pull_request` event, actions/checkout leaves HEAD at the merge
 * commit, so HEAD^1 is the base branch and HEAD^2 is the PR head — both
 * reachable with fetch-depth 2. No full clone, no history download.
 */
const WORKFLOW = `name: noopcheck

on:
  pull_request:

permissions:
  contents: read

jobs:
  noopcheck:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # HEAD is the merge commit: HEAD^1 = base, HEAD^2 = PR head.
          # Two revisions is all noopcheck reads.
          fetch-depth: 2

      - uses: actions/setup-node@v4
        with:
          node-version: 24

      # Collapses review scope: says which files actually changed behaviour.
      # Writes to the job summary, so it never adds comment noise.
      - name: Check what really changed
        run: |
          npx -y noopcheck HEAD^1 --head HEAD^2 --markdown >> "$GITHUB_STEP_SUMMARY"

      # Turn a declared change class into a gate by uncommenting one of these:
      #   --assert format  fails unless every file is whitespace/comment-level
      #   --assert rename  also allows pure identifier renames
      #   --assert value   also allows literal-only changes (version bumps)
      # - name: Enforce the declared change class
      #   if: contains(github.event.pull_request.labels.*.name, 'refactor-only')
      #   run: npx -y noopcheck HEAD^1 --head HEAD^2 --assert format
`;

function agentsBlock(): string {
  return `${MARKER}
## Verifying a "refactor only" change

Before declaring a mechanical change complete in this repository, verify the
claim instead of asserting it:

\`\`\`bash
npx -y noopcheck <base>                  # which files actually changed behaviour
npx -y noopcheck <base> --assert format  # exit 1 if anything exceeds formatting
\`\`\`

- Report the verdict you got, including when it contradicts your intent:
  "3 of 27 files changed structurally" is the useful sentence.
- \`--assert format\` is the honest gate for a formatting sweep. \`rename\` and
  \`value\` are wider classes and are **not** behaviour-preserving in general —
  renaming an exported symbol breaks consumers, and a changed literal is a
  changed value. Declare them only when that is what you mean.
- A \`changed\` verdict is a fact about the syntax tree, not a judgement. It
  says the file needs reading, not that the change is wrong.
- Parse failures and non-TypeScript content resolve to "read it" — the tool
  never reports "nothing happened" when it cannot tell.
${MARKER}`;
}

export interface InitOptions {
  cwd?: string;
  dryRun?: boolean;
  /** Skip the GitHub Actions workflow */
  noCi?: boolean;
  /** Skip the AGENTS.md section */
  noAgents?: boolean;
  /** File the agent instructions go in (default AGENTS.md) */
  file?: string;
}

export interface InitAction {
  path: string;
  action: "created" | "updated" | "unchanged";
}

/** Insert or refresh the marker-delimited block, leaving everything else. */
function mergeBlock(existing: string, block: string): string {
  const start = existing.indexOf(MARKER);
  const end = existing.lastIndexOf(MARKER);
  if (start !== -1 && end > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(end + MARKER.length);
    return `${before}${block}${after}`;
  }
  const separator = existing.trim() === "" ? "" : "\n\n";
  return `${existing.replace(/\s*$/, "")}${separator}${block}\n`;
}

export async function runInit(options: InitOptions = {}): Promise<InitAction[]> {
  const dir = options.cwd ?? ".";
  const actions: InitAction[] = [];

  if (options.noCi !== true) {
    const path = resolve(dir, WORKFLOW_PATH);
    let current: string | null = null;
    try {
      current = await readFile(path, "utf8");
    } catch {
      current = null;
    }
    const action =
      current === null ? "created" : current === WORKFLOW ? "unchanged" : "updated";
    if (options.dryRun !== true && action !== "unchanged") {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, WORKFLOW);
    }
    actions.push({ path: WORKFLOW_PATH, action });
  }

  if (options.noAgents !== true) {
    const rel = options.file ?? "AGENTS.md";
    const path = resolve(dir, rel);
    let current = "";
    try {
      current = await readFile(path, "utf8");
    } catch {
      current = "";
    }
    const next = mergeBlock(current, agentsBlock());
    const action =
      current === "" ? "created" : current === next ? "unchanged" : "updated";
    if (options.dryRun !== true && action !== "unchanged") {
      await writeFile(path, next);
    }
    actions.push({ path: rel, action });
  }

  return actions;
}

/** Exposed so `--dry-run` can print exactly what would be written. */
export function previewFiles(): { path: string; content: string }[] {
  return [
    { path: WORKFLOW_PATH, content: WORKFLOW },
    { path: join("AGENTS.md"), content: agentsBlock() },
  ];
}
