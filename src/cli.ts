#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import {
  ASSERT_CLASSES,
  runCheck,
  violations,
  type AssertClass,
  type CheckResult,
  type Verdict,
} from "./core.js";

/**
 * noopcheck — verifies the change class a diff declares.
 *
 * It answers one question deterministically: "does this diff really change
 * nothing (beyond formatting / renames / literal values)?" — and points at the
 * exact files where it does. It does NOT claim a change is safe: structural
 * equivalence is not semantic equivalence, and rename/value classes are not
 * behaviour-preserving in general. What it collapses is REVIEW SCOPE, and what
 * it audits is an agent's (or a PR label's) "refactor only" claim.
 */

const VERDICT_ORDER: Verdict[] = [
  "changed",
  "added",
  "deleted",
  "unverified",
  "value-only",
  "rename-only",
  "format-only",
  "whitespace-only",
  "identical",
];

function summarize(result: CheckResult): string {
  const counts = new Map<Verdict, number>();
  for (const f of result.files)
    counts.set(f.verdict, (counts.get(f.verdict) ?? 0) + 1);
  const parts = VERDICT_ORDER.filter((v) => counts.has(v)).map(
    (v) => `${String(counts.get(v))} ${v}`,
  );
  return `${String(result.files.length)} files: ${parts.join(", ")}`;
}

function colorFor(verdict: Verdict): (s: string) => string {
  if (verdict === "changed" || verdict === "added" || verdict === "deleted")
    return pc.red;
  if (verdict === "unverified") return pc.yellow;
  if (verdict === "value-only" || verdict === "rename-only") return pc.cyan;
  return pc.dim;
}

const program = new Command();

program
  .name("noopcheck")
  .description(
    "Checks whether a \"this is just a refactor\" change really changes nothing — per file, deterministically",
  )
  .argument("<base>", "Base to compare against (branch, commit, origin/main…)")
  .option("--head <ref>", "Comparison target", "HEAD")
  .option("--cwd <path>", "Repository directory", ".")
  .option(
    "--assert <class>",
    `Fail (exit 1) unless every file fits the declared class: ${ASSERT_CLASSES.join(" | ")}`,
  )
  .option("--json", "Write JSON to stdout", false)
  .addHelpText(
    "after",
    `
Verdicts (TS/TSX are compared at the AST level via dowsing's structure
engine; other text files get the whitespace tier and are otherwise
"unverified" — shown, and treated as changed by --assert, never dropped):
  identical        byte-identical (mode change, move)
  format-only      AST identical down to names and values — whitespace,
                   comments, semicolons only
  whitespace-only  non-TS text equal after stripping whitespace
  rename-only      same structure, identifiers renamed — NOT behaviour-
                   preserving if an exported symbol is involved
  value-only       only literal values changed (version bumps) — a config
                   value IS behaviour; accept it only knowingly
  changed          the structure changed (parse failures land here: fail-closed)

Only two revisions are read, so in CI \`fetch-depth: 2\` is enough:

  - uses: actions/checkout@v4
    with: { fetch-depth: 2 }
  - run: npx -y noopcheck HEAD^ --assert format

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
        json: boolean;
      },
    ) => {
      const declared = opts.assert as AssertClass | undefined;
      if (
        declared !== undefined &&
        !ASSERT_CLASSES.includes(declared as AssertClass)
      ) {
        console.error(
          pc.red(
            `unknown --assert class "${String(declared)}" (expected ${ASSERT_CLASSES.join(" | ")})`,
          ),
        );
        process.exitCode = 2;
        return;
      }

      let result;
      try {
        result = await runCheck(opts.cwd, base, opts.head);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        console.error(
          pc.red(
            `cannot diff ${base}...${opts.head}: ${detail.split("\n").find((l) => l.includes("fatal:")) ?? detail.split("\n")[0] ?? detail}`,
          ),
        );
        console.error(
          pc.dim(
            "  Is the base fetched? In CI, actions/checkout needs fetch-depth: 2 (or fetch the base ref).",
          ),
        );
        process.exitCode = 2;
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
              violations: failing.map((f) => f.path),
            },
            null,
            2,
          )}\n`,
        );
      } else {
        for (const f of result.files) {
          console.log(
            `  ${colorFor(f.verdict)(f.verdict.padEnd(15))} ${f.path}`,
          );
        }
        console.log(`\n${pc.bold(summarize(result))}`);
        if (declared === undefined) {
          if (result.attention.length > 0) {
            console.log(
              pc.bold(
                `→ read these ${String(result.attention.length)}: ${result.attention
                  .map((f) => f.path)
                  .join(", ")}`,
              ),
            );
          } else {
            console.log(
              pc.green("→ nothing beyond formatting-level changes."),
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

await program.parseAsync();
