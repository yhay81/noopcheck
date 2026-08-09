import {
  git,
  isVerifiablePath,
  runCheck,
  violations,
  type AssertClass,
} from "./core.js";

/**
 * `noopcheck audit` — turn the tool on your own history.
 *
 * Every repository already contains the experiment: commits that declared
 * themselves mechanical ("style:", "refactor:", "chore(deps): bump"). This
 * replays them and reports how many really were no-ops of the class they
 * declared — and names the ones that were not.
 *
 * It is descriptive, not accusatory. A `refactor:` commit that also changes
 * behaviour may be entirely deliberate and disclosed in its body; what the
 * audit says is only that its subject line would not have told a reviewer to
 * look. That is the same fact the per-PR check reports, measured on evidence
 * you already have, before wiring anything into CI.
 */

export interface AuditEntry {
  sha: string;
  subject: string;
  /** The change class the subject line declares */
  declared: AssertClass;
  /** true when every *verifiable* file fits `declared` */
  conforming: boolean;
  filesChanged: number;
  /** Files whose meaning could not be judged (lockfiles, docs, binaries) */
  unverifiableFiles: number;
  /** Verifiable files that exceeded the declared class (capped for display) */
  offenders: { path: string; verdict: string }[];
}

export interface AuditResult {
  scanned: number;
  entries: AuditEntry[];
  byClass: Record<AssertClass, { total: number; conforming: number }>;
  /** Commits where nothing at all could be verified — reported, not hidden */
  commitsWithNothingVerifiable: number;
}

/**
 * How a subject line declares its change class. Ordered: the first match
 * wins. Deliberately conservative — a commit whose subject does not claim to
 * be mechanical is not audited at all, because there is no claim to check.
 */
const DECLARATIONS: { declared: AssertClass; pattern: RegExp }[] = [
  { declared: "format", pattern: /^(style|format)(\([^)]*\))?!?:/i },
  {
    declared: "format",
    pattern: /^chore(\([^)]*\))?!?:.*\b(format|prettier|biome|lint|style)\b/i,
  },
  { declared: "format", pattern: /\b(prettier|biome)\b.*\b(run|sweep|apply)\b/i },
  { declared: "rename", pattern: /^refactor(\([^)]*\))?!?:/i },
  { declared: "rename", pattern: /^chore(\([^)]*\))?!?:.*\brename\b/i },
  {
    declared: "value",
    pattern: /^chore\(deps[^)]*\)!?:|^(release|version)(\([^)]*\))?!?:/i,
  },
  { declared: "value", pattern: /^chore(\([^)]*\))?!?:.*\bbump\b/i },
];

function declaredClassOf(subject: string): AssertClass | null {
  for (const rule of DECLARATIONS) {
    if (rule.pattern.test(subject)) return rule.declared;
  }
  return null;
}

export interface AuditOptions {
  /** Stop after auditing this many mechanical commits (default 100) */
  max?: number | undefined;
  /** Called before each commit is replayed, for progress reporting */
  onProgress?: ((done: number, total: number) => void) | undefined;
}

/**
 * Replay a commit range and audit every commit that declares itself
 * mechanical, newest first, stopping at `max`. Merge commits and root
 * commits are skipped (there is no single parent to compare against).
 */
export async function auditRange(
  cwd: string,
  range: string,
  options: AuditOptions = {},
): Promise<AuditResult> {
  const max = options.max ?? 100;
  const log = await git(cwd, [
    "log",
    "--no-merges",
    "--pretty=%H%x1f%s",
    range,
  ]);

  const candidates: { sha: string; subject: string; declared: AssertClass }[] =
    [];
  for (const line of log.split("\n")) {
    if (line.trim() === "") continue;
    const [sha, subject] = line.split("\x1f");
    if (sha === undefined || subject === undefined) continue;
    const declared = declaredClassOf(subject);
    if (declared === null) continue;
    candidates.push({ sha, subject, declared });
    if (candidates.length >= max) break;
  }

  const entries: AuditEntry[] = [];
  let done = 0;
  for (const candidate of candidates) {
    options.onProgress?.(done, candidates.length);
    done += 1;
    let result;
    try {
      result = await runCheck(cwd, `${candidate.sha}^`, candidate.sha);
    } catch {
      // Root commit, or a revision git cannot reach in a shallow clone.
      continue;
    }
    // Only files we can actually give a verdict on count for or against the
    // claim; the rest are counted and reported separately (see
    // isVerifiablePath).
    const failing = violations(result, candidate.declared).filter((f) =>
      isVerifiablePath(f.path),
    );
    entries.push({
      sha: candidate.sha,
      subject: candidate.subject,
      declared: candidate.declared,
      conforming: failing.length === 0,
      filesChanged: result.files.length,
      unverifiableFiles: result.files.filter((f) => !isVerifiablePath(f.path))
        .length,
      offenders: failing
        .slice(0, 3)
        .map((f) => ({ path: f.path, verdict: f.verdict })),
    });
  }

  const byClass: AuditResult["byClass"] = {
    format: { total: 0, conforming: 0 },
    rename: { total: 0, conforming: 0 },
    value: { total: 0, conforming: 0 },
  };
  for (const e of entries) {
    byClass[e.declared].total += 1;
    if (e.conforming) byClass[e.declared].conforming += 1;
  }

  return {
    scanned: entries.length,
    entries,
    byClass,
    commitsWithNothingVerifiable: entries.filter(
      (e) => e.unverifiableFiles === e.filesChanged,
    ).length,
  };
}
