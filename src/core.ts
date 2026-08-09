import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareStructure } from "./structure.js";

const execFileAsync = promisify(execFile);

/**
 * The verdict per changed file.
 *
 * TS/TSX files get an AST-level verdict from dowsing's structure-fingerprint
 * engine. Everything else gets the cheap text tiers (whitespace-only), and is
 * otherwise labelled `unverified` — shown, never silently dropped, and treated
 * as changed by the gate (fail-closed).
 *
 * `rename-only` and `value-only` are NOT behaviour-preserving in general: an
 * exported-symbol rename breaks consumers, and a config value IS behaviour.
 * They exist so `--assert` can accept a declared change class, not to declare
 * a change safe.
 */
export type Verdict =
  | "identical"
  | "format-only"
  | "whitespace-only"
  | "rename-only"
  | "value-only"
  | "changed"
  | "added"
  | "deleted"
  | "unverified";

export interface FileVerdict {
  path: string;
  verdict: Verdict;
  /** true when the verdict came from AST comparison (TS/TSX only) */
  astVerified: boolean;
}

export interface CheckResult {
  base: string;
  head: string;
  files: FileVerdict[];
  /** Files a reviewer actually has to read under the declared class */
  attention: FileVerdict[];
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
}

/** Changed paths between base and head. `-z --no-renames` keeps paths raw. */
async function changedPaths(
  cwd: string,
  base: string,
  head: string,
): Promise<string[]> {
  const out = await git(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    `${base}...${head}`,
  ]);
  return out.split("\0").filter((p) => p !== "");
}

/** File content at a revision, or null when it does not exist there. */
export async function showAt(
  cwd: string,
  revision: string,
  path: string,
): Promise<string | null> {
  try {
    return await git(cwd, ["show", `${revision}:${path}`]);
  } catch {
    return null;
  }
}

const TS_FILE = /\.(ts|tsx|mts|cts)$/;
/** Binary-ish extensions we do not even attempt to read as text */
const BINARY_FILE =
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp[34]|wasm)$/i;

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, "");
}

/**
 * Is this a file whose meaning noopcheck can actually judge?
 *
 * The gate (`--assert`) does not care: anything unjudgeable fails closed, as
 * it must. The audit does, because its question is "would a reviewer have
 * needed to read code?" — and a lockfile or a CHANGELOG is not code we can
 * give a verdict on. Counting those as violations would bury the real signal
 * under release plumbing, so the audit separates them and reports the count
 * rather than folding it in.
 */
export function isVerifiablePath(path: string): boolean {
  return TS_FILE.test(path) && !path.endsWith(".d.ts");
}

function classify(
  path: string,
  before: string | null,
  after: string | null,
): FileVerdict {
  if (before === null && after === null)
    return { path, verdict: "unverified", astVerified: false };
  if (before === null) return { path, verdict: "added", astVerified: false };
  if (after === null) return { path, verdict: "deleted", astVerified: false };
  if (before === after)
    return { path, verdict: "identical", astVerified: false };

  if (TS_FILE.test(path) && !path.endsWith(".d.ts")) {
    const structural = compareStructure(path, before, after);
    // `unknown` (parse failure, tiny file) is treated as changed: fail-closed
    const verdict: Verdict = structural === "unknown" ? "changed" : structural;
    return { path, verdict, astVerified: structural !== "unknown" };
  }

  if (BINARY_FILE.test(path))
    return { path, verdict: "unverified", astVerified: false };
  if (stripWhitespace(before) === stripWhitespace(after))
    return { path, verdict: "whitespace-only", astVerified: false };
  return { path, verdict: "unverified", astVerified: false };
}

/**
 * The change classes `--assert` can declare, and what each accepts.
 * Order matters: each class is a superset of the previous one.
 * The default gate should stay at `format` — see the Verdict doc comment.
 */
export const ASSERT_CLASSES = ["format", "rename", "value"] as const;
export type AssertClass = (typeof ASSERT_CLASSES)[number];

const ACCEPTED: Record<AssertClass, ReadonlySet<Verdict>> = {
  format: new Set(["identical", "format-only", "whitespace-only"]),
  rename: new Set([
    "identical",
    "format-only",
    "whitespace-only",
    "rename-only",
  ]),
  value: new Set([
    "identical",
    "format-only",
    "whitespace-only",
    "rename-only",
    "value-only",
  ]),
};

export async function runCheck(
  cwd: string,
  base: string,
  head = "HEAD",
): Promise<CheckResult> {
  const paths = await changedPaths(cwd, base, head);
  const files: FileVerdict[] = [];
  for (const path of paths) {
    const [before, after] = await Promise.all([
      showAt(cwd, base, path),
      showAt(cwd, head, path),
    ]);
    files.push(classify(path, before, after));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // With no declared class, "attention" = anything that is not provably a
  // formatting-level change. Fail-closed: added/deleted/unverified included.
  const attention = files.filter((f) => !ACCEPTED.format.has(f.verdict));
  return { base, head, files, attention };
}

export function violations(
  result: CheckResult,
  declared: AssertClass,
): FileVerdict[] {
  const accepted = ACCEPTED[declared];
  return result.files.filter((f) => !accepted.has(f.verdict));
}
