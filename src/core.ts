import { execFile, spawn } from "node:child_process";
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

/**
 * Read many blobs in one `git cat-file --batch` process.
 *
 * The obvious implementation — one `git show` per file per revision — spends
 * essentially all of its time spawning processes: measured on a 200-file
 * diff, 400 `git show` calls take 4.1s while the same content through one
 * batched process takes 0.05s. Since the flagship case for this tool is a
 * sweep touching hundreds of files, that difference is the difference
 * between a check you run and a check you skip.
 *
 * Requests keep their input order, and a missing object yields null rather
 * than an error, because "this file did not exist at that revision" is a
 * normal answer here (additions and deletions).
 */
async function readBlobs(
  cwd: string,
  requests: readonly { revision: string; path: string }[],
): Promise<(string | null)[]> {
  if (requests.length === 0) return [];
  // `cat-file --batch` is line-oriented on stdin, so a path containing a
  // newline cannot be expressed. Those are vanishingly rare and legal, so
  // they fall back to the one-process-per-file path rather than being
  // silently mis-read.
  const batchable = requests.every((r) => !r.path.includes("\n"));
  if (!batchable) {
    return Promise.all(requests.map((r) => showAt(cwd, r.revision, r.path)));
  }

  const child = spawn("git", ["cat-file", "--batch"], { cwd });
  const chunks: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderr.push(c));

  const finished = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => {
      resolve();
    });
  });
  child.stdin.write(
    requests.map((r) => `${r.revision}:${r.path}`).join("\n") + "\n",
  );
  child.stdin.end();
  await finished;

  const out = Buffer.concat(chunks);
  const results: (string | null)[] = [];
  let offset = 0;
  for (let i = 0; i < requests.length; i += 1) {
    const nl = out.indexOf(0x0a, offset);
    if (nl === -1) {
      // Output ran out before every request was answered — rather than
      // guessing, fall back for the remainder.
      const rest = requests.slice(i);
      const recovered = await Promise.all(
        rest.map((r) => showAt(cwd, r.revision, r.path)),
      );
      results.push(...recovered);
      return results;
    }
    const header = out.toString("utf8", offset, nl);
    offset = nl + 1;
    const parts = header.split(" ");
    const size = Number(parts[2]);
    if (parts[1] !== "blob" || !Number.isFinite(size)) {
      // "<object> missing", or a tree/commit where a file was expected.
      results.push(null);
      continue;
    }
    results.push(out.toString("utf8", offset, offset + size));
    offset += size + 1; // content is followed by a newline
  }
  return results;
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
  // Both revisions of every path in two batched reads, not two spawns per
  // file — see readBlobs for the measurement that motivated it.
  const [befores, afters] = await Promise.all([
    readBlobs(
      cwd,
      paths.map((path) => ({ revision: base, path })),
    ),
    readBlobs(
      cwd,
      paths.map((path) => ({ revision: head, path })),
    ),
  ]);
  const files: FileVerdict[] = paths.map((path, i) =>
    classify(path, befores[i] ?? null, afters[i] ?? null),
  );
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
