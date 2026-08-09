---
name: Wrong verdict
about: noopcheck gave a file a verdict you believe is incorrect
title: "Wrong verdict: <verdict> for <file>"
labels: wrong-verdict
---

## Read this first if the verdict was a false "equivalent"

A **false equivalent** — noopcheck said `identical`, `format-only`,
`whitespace-only`, `rename-only`, or `value-only` for a file that really did
change — is the highest-priority bug this project has. It is the one failure mode
that makes the tool actively harmful, because a reviewer skips the file.

If that is what you hit, **please report it even if you cannot fill in
everything below**. A rough description beats a missing report. The opposite
direction (something classified as `changed` or `unverified` that you expected to
be equivalent) is a real bug too, but it fails safe — take the time to fill the
form in.

## File

- Path:
- Extension:

## Minimal reproduction

The smallest before/after pair that still shows the wrong verdict. Two
revisions of one file.

Before:

```ts

```

After:

```ts

```

## Verdicts

- What noopcheck reported:
- What you expected:
- Why (what actually changed, or did not change, between the two revisions):

## Environment

- `noopcheck --version`:
- `node --version`:
- OS:

## Anything else

Command line used (`--assert`, `--head`, `--json`), and any other context.
