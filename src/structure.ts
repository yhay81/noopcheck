import { parseSync } from "oxc-parser";

/**
 * Structural fingerprinting: does a change alter what the code means?
 *
 * A git line diff cannot tell you. Renaming an identifier, reformatting a
 * file, or bumping a version literal all look like large diffs while the
 * structure of the program is untouched. This module hashes the AST under
 * three different normalizations, so comparing two revisions answers the
 * question directly.
 *
 * Only syntax is needed — no type checker, no module resolution, no
 * `node_modules` in the repository under test.
 *
 * Provenance: this engine was originally written for and validated in
 * `dowsing` (MIT, same author, archived 2026-08), where its verdicts were
 * manually audited against real revision pairs across eight open-source
 * repositories — including catching release-bot version bumps by content
 * alone. It is vendored here in source form so noopcheck is self-contained
 * and does not depend on an archived package.
 * See https://github.com/yhay81/dowsing for that validation record.
 */

export interface StructureFingerprint {
  /** Structure with identifier names stripped (literals and operators kept) */
  shape: string;
  /** Structure including identifier names and literal values */
  shapeWithNames: string;
  /**
   * Structure including identifier names but with literal values stripped.
   * When two revisions agree here but differ on `shapeWithNames`, the only
   * thing that changed was a literal — the signature of a generated value
   * file (version strings, build stamps) rewritten by automation.
   */
  shapeWithoutValues: string;
  /** Nodes visited — tiny files are too collision-prone to judge */
  nodeCount: number;
  parseFailed: boolean;
}

interface AstNode {
  type: string;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Only identifier *names* are excluded from the structural hash. Operators
 * (`>` vs `>=`) and literal values (`0` vs `1`) change meaning, so they stay.
 */
const IDENTIFIER_NODES = new Set([
  "Identifier",
  "JSXIdentifier",
  "PrivateIdentifier",
  "TSTypeParameter",
  "BindingIdentifier",
  "IdentifierName",
  "IdentifierReference",
  "LabelIdentifier",
]);

/**
 * Nodes that carry literal values. Only their value/raw/bigint fields are
 * excluded from `shapeWithoutValues`; structure, names, and operators remain.
 * In oxc's ESTree output every string, number, boolean, null, bigint, and
 * regex lands on `Literal`; `JSXText` is the text node.
 */
const VALUE_NODES = new Set(["Literal", "JSXText"]);
const VALUE_KEYS = new Set(["value", "raw", "bigint"]);

/** FNV-1a (32-bit). Not cryptographic — this is a fast equality check. */
class Hasher {
  private hash = 0x811c9dc5;

  update(text: string): void {
    for (let i = 0; i < text.length; i += 1) {
      this.hash ^= text.charCodeAt(i);
      this.hash = Math.imul(this.hash, 0x01000193);
    }
  }

  digest(): string {
    return (this.hash >>> 0).toString(16);
  }
}

/** Walk the AST deterministically, producing the three hashes. */
export function fingerprintSource(
  filePath: string,
  source: string,
): StructureFingerprint {
  const result = parseSync(filePath, source);
  const shape = new Hasher();
  const withNames = new Hasher();
  const withoutValues = new Hasher();
  let nodeCount = 0;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    const node = value;
    nodeCount += 1;
    shape.update(node.type);
    withNames.update(node.type);
    withoutValues.update(node.type);

    const isIdentifier = IDENTIFIER_NODES.has(node.type);
    const isValueNode = VALUE_NODES.has(node.type);

    // A TemplateElement's text lives in `value: {raw, cooked}` — a plain
    // object with no `type`, invisible to the generic walk. Without picking
    // it up explicitly, a change to template body text alone would be
    // misclassified as format-only. It is a literal, so it belongs in
    // shape/shapeWithNames but not in shapeWithoutValues.
    if (node.type === "TemplateElement") {
      const raw = (node.value as { raw?: unknown } | undefined)?.raw;
      if (typeof raw === "string") {
        const encoded = `raw=${raw}`;
        shape.update(encoded);
        withNames.update(encoded);
      }
    }

    // Visit children in a fixed key order, so the hash never depends on
    // object property ordering.
    const keys = Object.keys(node)
      .filter((k) => k !== "type" && k !== "start" && k !== "end")
      .sort();
    for (const key of keys) {
      const child = node[key];
      if (
        typeof child === "string" ||
        typeof child === "number" ||
        typeof child === "boolean"
      ) {
        const encoded = `${key}=${String(child)}`;
        withNames.update(encoded);
        // Identifier names are the only thing excluded from `shape`, which is
        // what makes rename detection possible.
        if (!(isIdentifier && (key === "name" || key === "value"))) {
          shape.update(encoded);
        }
        // Literal values are the only thing excluded from
        // `shapeWithoutValues`, which is what makes value-bump detection
        // possible. Identifier names stay.
        if (!(isValueNode && VALUE_KEYS.has(key))) {
          withoutValues.update(encoded);
        }
        continue;
      }
      if (isNode(child) || Array.isArray(child)) {
        shape.update(`<${key}`);
        withNames.update(`<${key}`);
        withoutValues.update(`<${key}`);
        visit(child);
        shape.update(">");
        withNames.update(">");
        withoutValues.update(">");
      }
    }
  };

  visit(result.program as unknown as AstNode);
  return {
    shape: shape.digest(),
    shapeWithNames: withNames.digest(),
    shapeWithoutValues: withoutValues.digest(),
    nodeCount,
    parseFailed: result.errors.length > 0,
  };
}

export type StructuralVerdict =
  | "changed"
  | "rename-only"
  | "format-only"
  | "value-only"
  | "identical"
  | "unknown";

/**
 * Classify what changed between two revisions of one file.
 *
 * - `identical`: not one byte differs (a move, a mode change)
 * - `format-only`: the AST matches down to names and values — whitespace,
 *   comments, semicolons
 * - `value-only`: structure and names match, only literals differ — the
 *   signature of a generated value file (version bumps, build stamps)
 * - `rename-only`: same structure, different identifiers
 * - `changed`: the structure moved
 * - `unknown`: cannot judge (parse failure, or a file too small to be
 *   distinguishable from a coincidence)
 *
 * Everything ambiguous resolves toward `changed`/`unknown`, never toward
 * "nothing happened": a change that both renames and bumps a value matches
 * none of the hashes and lands in `changed`. A false "equivalent" is the one
 * failure mode this tool must never have, so the arrows all point that way.
 */
export function compareStructure(
  filePath: string,
  before: string,
  after: string,
): StructuralVerdict {
  if (before === after) return "identical";
  const a = fingerprintSource(filePath, before);
  const b = fingerprintSource(filePath, after);
  if (a.parseFailed || b.parseFailed) return "unknown";
  // Very small files collide by chance, so they are not judged at all.
  if (a.nodeCount < 5 || b.nodeCount < 5) return "unknown";

  if (a.shapeWithNames === b.shapeWithNames) {
    // AST identical including names and values: whitespace/comments only.
    return "format-only";
  }
  if (
    a.shapeWithoutValues === b.shapeWithoutValues &&
    a.nodeCount === b.nodeCount
  ) {
    return "value-only";
  }
  if (a.shape === b.shape && a.nodeCount === b.nodeCount) {
    return "rename-only";
  }
  return "changed";
}
