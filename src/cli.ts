#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import {
  ASSERT_CLASSES,
  runCheck,
  violations,
  type AssertClass,
  type Verdict,
} from "./core.js";
import { auditRange } from "./audit.js";
import { previewFiles, runInit } from "./init.js";
import { renderAudit, renderMarkdown, summarize, tiers } from "./render.js";

/**
 * noopcheck — verify the change class a diff declares.
 *
 * It answers one question deterministically: "does this diff really change
 * nothing beyond formatting / renames / literal values?" — and points at the
 * exact files where it does. It does NOT claim a change is safe: structural
 * equivalence is not semantic equivalence, and the rename/value classes are
 * not behaviour-preserving in general. What it collapses is REVIEW SCOPE;
 * what it audits is a CLAIM.
 */

function colorFor(verdict: Verdict): (s: string) => string {
  if (verdict === "changed" || verdict === "added" || verdict === "deleted")
    return pc.red;
  if (verdict === "unverified") return pc.yellow;
  if (verdict === "value-only" || verdict === "rename-only") return pc.cyan;
  return pc.dim;
}

function fail(message: string, hint?: string): void {
  console.error(pc.red(message));
  if (hint !== undefined) console.error(pc.dim(`  ${hint}`));
  process.exitCode = 2;
}

const program = new Command();

program
  .name("noopcheck")
  .description(
    'Checks whether a "this is just a refactor" change really changes nothing — per file, deterministically',
  )
  .version("0.1.0");

program
  .command("check", { isDefault: true })
  .description("Classify every file in a diff, and optionally gate on a declared change class")
  .argument("<base>", "Base to compare against (branch, commit, origin/main…)")
  .option("--head <ref>", "Comparison target", "HEAD")
  .option("--cwd <path>", "Repository directory", ".")
  .option(
    "--assert <class>",
    `Exit 1 unless every file fits the declared class: ${ASSERT_CLASSES.join(" | ")}`,
  )
  .option("--markdown", "Write PR-comment / job-summary Markdown to stdout", false)
  .option("--json", "Write JSON to stdout", false)
  .addHelpText(
    "after",
    `
Verdicts (TS/TSX are compared at the AST level; other text files get the
whitespace tier and are otherwise "unverified" — shown, and treated as
changed by --assert, never dropped):
  identical        byte-identical (mode change, move)
  format-only      AST identical down to names and values — whitespace,
                   comments, semicolons only
  whitespace-only  non-TS text equal after stripping whitespace
  rename-only      same structure, identifiers renamed — NOT behaviour-
                   preserving if an exported symbol is involved
  value-only       only literal values changed (version bumps) — a config
                   value IS behaviour; accept it only knowingly
  changed          the structure changed (parse failures land here: fail-closed)

Only two revisions are read, so \`fetch-depth: 2\` is enough in CI.
\`noopcheck init\` writes a workflow that does exactly that.

Examples:
  $ noopcheck origin/main                     # collapse review scope
  $ noopcheck origin/main --assert format     # gate a "style:" PR
  $ noopcheck HEAD^ --assert rename --json    # audit an agent's claim`,
  )
  .action(
    async (
      base: string,
      opts: {
        head: string;
        cwd: string;
        assert?: string;
        markdown: boolean;
        json: boolean;
      },
    ) => {
      const declared = opts.assert as AssertClass | undefined;
      if (
        declared !== undefined &&
        !ASSERT_CLASSES.includes(declared as AssertClass)
      ) {
        fail(
          `unknown --assert class "${String(declared)}"`,
          `expected ${ASSERT_CLASSES.join(" | ")}`,
        );
        return;
      }

      let result;
      try {
        result = await runCheck(opts.cwd, base, opts.head);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const line =
          detail.split("\n").find((l) => l.includes("fatal:")) ??
          detail.split("\n")[0] ??
          detail;
        fail(
          `cannot diff ${base}...${opts.head}: ${line}`,
          "Is the base fetched? In CI, actions/checkout needs fetch-depth: 2 (or fetch the base ref).",
        );
        return;
      }

      const failing =
        declared === undefined ? [] : violations(result, declared);

      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              base: result.base,
              head: result.head,
              declared: declared ?? null,
              summary: summarize(result),
              files: result.files,
              attention: result.attention.map((f) => f.path),
              violations: failing.map((f) => f.path),
            },
            null,
            2,
          )}\n`,
        );
      } else if (opts.markdown) {
        process.stdout.write(`${renderMarkdown(result, declared, failing)}\n`);
      } else {
        for (const f of result.files) {
          console.log(
            `  ${colorFor(f.verdict)(f.verdict.padEnd(15))} ${f.path}`,
          );
        }
        console.log(`\n${pc.bold(summarize(result))}`);
        if (declared === undefined) {
          const { read, skim, skipped } = tiers(result);
          if (read.length > 0) {
            console.log(
              pc.bold(
                `→ read these ${String(read.length)} (structure moved): ${read
                  .map((f) => f.path)
                  .join(", ")}`,
              ),
            );
          }
          if (skim.length > 0) {
            console.log(
              pc.cyan(
                `→ skim these ${String(skim.length)} (only names or literals moved): ${skim
                  .map((f) => f.path)
                  .join(", ")}`,
              ),
            );
          }
          if (read.length === 0 && skim.length === 0) {
            console.log(pc.green("→ nothing beyond formatting-level changes."));
          } else if (skipped.length > 0) {
            console.log(
              pc.dim(
                `  (${String(skipped.length)} file(s) need no reading: identical, format-only, or whitespace-only)`,
              ),
            );
          }
        } else if (failing.length === 0) {
          console.log(
            pc.green(`✓ every file fits the declared class "${declared}"`),
          );
        } else {
          console.log(
            pc.red(
              `✗ ${String(failing.length)} file(s) do not fit "${declared}": ${failing
                .map((f) => `${f.path} (${f.verdict})`)
                .join(", ")}`,
            ),
          );
        }
      }

      if (declared !== undefined && failing.length > 0) process.exitCode = 1;
    },
  );

program
  .command("audit")
  .description(
    "Replay this repository's own mechanical commits and report how many really were no-ops",
  )
  // Default to all reachable history rather than a fixed depth: `HEAD~200`
  // does not exist in a young repository, and `noopcheck audit` should never
  // fail on a repository it could have audited. --max bounds the work.
  .argument("[range]", "Commit range to audit (default: all history)", "HEAD")
  .option("--cwd <path>", "Repository directory", ".")
  .option("--max <n>", "Stop after auditing this many commits", "100")
  .option("--json", "Write JSON to stdout", false)
  .addHelpText(
    "after",
    `
Every repository already contains the experiment: commits that declared
themselves mechanical ("style:", "refactor:", "chore(deps): bump"). This
replays them and reports how many really were no-ops of the class they
declared — evidence from your own history, before wiring anything into CI.

It is descriptive, not accusatory: a refactor: commit that also changes
behaviour may be entirely deliberate. What the audit says is only that its
subject line would not have told a reviewer to look.

Examples:
  $ noopcheck audit
  $ noopcheck audit v1.0.0..HEAD --json`,
  )
  .action(
    async (
      range: string,
      opts: { cwd: string; max: string; json: boolean },
    ) => {
      const max = Number.parseInt(opts.max, 10) || 100;
      let result;
      try {
        result = await auditRange(opts.cwd, range, {
          max,
          onProgress: opts.json
            ? undefined
            : (done, total) => {
                if (total > 0 && done % 10 === 0 && done > 0) {
                  process.stderr.write(
                    pc.dim(`  replaying ${String(done)}/${String(total)}…\n`),
                  );
                }
              },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const line =
          detail.split("\n").find((l) => l.includes("fatal:")) ??
          detail.split("\n")[0] ??
          detail;
        fail(
          `cannot read ${range}: ${line}`,
          "Try a range your clone actually contains, e.g. noopcheck audit HEAD~50..HEAD",
        );
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      console.log("");
      for (const line of renderAudit(result, range)) console.log(line);
    },
  );

program
  .command("init")
  .description(
    "Wire noopcheck into CI and into the instructions coding agents read",
  )
  .option("--cwd <path>", "Repository directory", ".")
  .option("--dry-run", "Print what would be written instead of writing it", false)
  .option("--no-ci", "Skip the GitHub Actions workflow")
  .option("--no-agents", "Skip the AGENTS.md section")
  .option("--file <path>", "File for the agent instructions", "AGENTS.md")
  .addHelpText(
    "after",
    `
Writes .github/workflows/noopcheck.yml (pull_request, fetch-depth 2, results
to the job summary — no comment noise, no write permissions) and appends a
marker-delimited section to AGENTS.md so every coding agent that works in
this repository verifies "refactor only" claims instead of asserting them.

Both are safe to re-run: the workflow is rewritten, the AGENTS.md section is
replaced in place, and nothing else in the file is touched.`,
  )
  .action(
    async (opts: {
      cwd: string;
      dryRun: boolean;
      ci: boolean;
      agents: boolean;
      file: string;
    }) => {
      if (opts.dryRun) {
        for (const file of previewFiles()) {
          console.log(pc.bold(`\n--- ${file.path}`));
          console.log(file.content);
        }
        return;
      }
      const actions = await runInit({
        cwd: opts.cwd,
        noCi: !opts.ci,
        noAgents: !opts.agents,
        file: opts.file,
      });
      for (const a of actions) {
        const mark =
          a.action === "created"
            ? pc.green("created")
            : a.action === "updated"
              ? pc.cyan("updated")
              : pc.dim("unchanged");
        console.log(`  ${mark} ${a.path}`);
      }
      console.log(
        pc.dim(
          "\n  CI reports to the job summary and never fails the build until you" +
            " uncomment an --assert gate in the workflow.",
        ),
      );
    },
  );

await program.parseAsync();
