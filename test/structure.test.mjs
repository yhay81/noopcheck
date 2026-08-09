import { test } from "node:test";
import assert from "node:assert/strict";
import { compareStructure, fingerprintSource } from "../dist/index.js";

/**
 * The engine's contract, stated as tests.
 *
 * The asymmetry matters: every ambiguous case must resolve toward "changed"
 * or "unknown". A false "equivalent" verdict is the one failure this tool
 * cannot have, so these tests exist as much to pin the fail-closed direction
 * as to pin the happy paths.
 */

const FN = `export function add(a: number, b: number): number {
  const total = a + b;
  return total;
}
`;

test("identical content is identical, whatever it contains", () => {
  assert.equal(compareStructure("a.ts", FN, FN), "identical");
});

test("whitespace, comments and semicolons are format-only", () => {
  const reformatted = `// a leading comment
export function add( a: number, b: number ): number {

  const total = a + b   // trailing comment
  return total
}
`;
  assert.equal(compareStructure("a.ts", FN, reformatted), "format-only");
});

test("renaming identifiers is rename-only", () => {
  const renamed = `export function sum(x: number, y: number): number {
  const result = x + y;
  return result;
}
`;
  assert.equal(compareStructure("a.ts", FN, renamed), "rename-only");
});

test("changing only a literal is value-only", () => {
  const before = `export const meta = {
  name: "pkg",
  version: "1.2.3",
  build: 41,
};
`;
  const after = before.replace("1.2.3", "1.2.4").replace("41", "42");
  assert.equal(compareStructure("v.ts", before, after), "value-only");
});

test("an operator change is a structural change, not a value change", () => {
  const before = `export function ok(n: number): boolean {
  const limit = 10;
  return n > limit;
}
`;
  const after = before.replace("n > limit", "n >= limit");
  assert.equal(compareStructure("a.ts", before, after), "changed");
});

test("template literal text is a value, not formatting", () => {
  const before = `export function greet(name: string): string {
  const greeting = \`hello \${name}\`;
  return greeting;
}
`;
  const after = before.replace("hello ", "goodbye ");
  // The text lives in a node the generic walk cannot see; without explicit
  // handling this would be misread as format-only.
  assert.equal(compareStructure("t.ts", before, after), "value-only");
});

test("rename plus value bump falls through to changed (fail-closed)", () => {
  const before = `export function add(a: number, b: number): number {
  const total = a + b + 1;
  return total;
}
`;
  const after = `export function sum(x: number, y: number): number {
  const result = x + y + 2;
  return result;
}
`;
  assert.equal(compareStructure("a.ts", before, after), "changed");
});

test("a parse failure is unknown, never equivalent", () => {
  const broken = "export function add(a: number {{{ syntax error";
  assert.equal(compareStructure("a.ts", FN, broken), "unknown");
});

test("files too small to judge are unknown, never equivalent", () => {
  // Under five nodes, hashes collide by chance, so the engine declines to
  // judge rather than risk a wrong "equivalent".
  assert.equal(fingerprintSource("t.ts", "let a").nodeCount, 4);
  assert.equal(compareStructure("t.ts", "let a", "let b"), "unknown");
});

test("just above the size floor, a rename+value change stays changed", () => {
  // 5 nodes: judged, and since both name and literal moved, no hash matches.
  assert.equal(fingerprintSource("t.ts", "let a = 1").nodeCount, 5);
  assert.equal(compareStructure("t.ts", "let a = 1", "let b = 2"), "changed");
});

test("adding a statement changes the structure", () => {
  const after = FN.replace("return total;", "console.log(total);\n  return total;");
  assert.equal(compareStructure("a.ts", FN, after), "changed");
});

test("TSX is understood, and JSX text is a value", () => {
  const before = `export const Hi = (): JSX.Element => {
  const cls = "greeting";
  return <div className={cls}>hello</div>;
};
`;
  const after = before.replace(">hello<", ">goodbye<");
  assert.equal(compareStructure("c.tsx", before, after), "value-only");
});

test("fingerprints are deterministic and normalization-specific", () => {
  const a = fingerprintSource("a.ts", FN);
  const b = fingerprintSource("a.ts", FN);
  assert.deepEqual(a, b);
  assert.equal(a.parseFailed, false);
  assert.ok(a.nodeCount > 5);

  const renamed = fingerprintSource(
    "a.ts",
    FN.replace(/total/g, "sum").replace(/\ba\b/g, "x"),
  );
  // Same shape (names excluded), different shapeWithNames (names included).
  assert.equal(renamed.shape, a.shape);
  assert.notEqual(renamed.shapeWithNames, a.shapeWithNames);
});
