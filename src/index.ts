/**
 * noopcheck's library API.
 *
 * Two layers, both stable and both usable without the CLI:
 *
 * 1. The structural engine — `compareStructure` / `fingerprintSource` — which
 *    answers "did these two revisions of this file mean anything different?"
 *    from syntax alone. Use it to build your own gates, review tools, or
 *    agent verifications.
 * 2. The git-aware check — `runCheck` / `violations` — which classifies every
 *    file in a diff and tells you which ones exceed a declared change class.
 *
 * The CLI is a thin shell over these; nothing it can do is unavailable here.
 */

export {
  compareStructure,
  fingerprintSource,
  type StructuralVerdict,
  type StructureFingerprint,
} from "./structure.js";

export {
  runCheck,
  violations,
  ASSERT_CLASSES,
  type AssertClass,
  type CheckResult,
  type FileVerdict,
  type Verdict,
} from "./core.js";

export { auditRange, type AuditEntry, type AuditResult } from "./audit.js";
