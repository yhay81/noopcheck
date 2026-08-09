# Contributing to noopcheck

Bug reports are especially welcome — noopcheck has not yet been run against a
broad corpus, so surprising verdicts are useful data. See
[the wrong-verdict issue template](.github/ISSUE_TEMPLATE/wrong-verdict.md).

## Getting started

Node `^22.18.0 || >=24.11.0` is required (see `engines` in `package.json`).

```bash
pnpm install
pnpm run build
pnpm test
```

`pnpm test` builds first and then runs `node --test`; `pnpm run check` type-checks
without emitting.

## Tests

Tests use the built-in `node:test` runner and live in `test/*.test.mjs`. They
import from `dist/`, which is why the build runs first.

Any new verdict, new file extension, or change to how a verdict is reached must
come with a test. A verdict with no test is a verdict nobody can safely change
later.

## The invariant: fail-closed

This is the one rule that is not negotiable. noopcheck's only fatal failure mode
is a false "equivalent" — telling a reviewer they can skip a file that really did
change. Everything the tool cannot judge must land on the "read it" side:

- Parse failures resolve to `changed`, never to `format-only`.
- Files too small to fingerprint reliably resolve to `changed`.
- Unknown or non-TS extensions resolve to `unverified`, which `--assert` treats
  as a violation.
- Added and deleted files are never accepted by a gate.
- A change that matches none of the fingerprints — for instance one that both
  renames and edits a literal — falls through to `changed`.

Widening a verdict is therefore a load-bearing change. A PR that lets more files
be classified as equivalent needs to say, in the description, *why it cannot
produce a false negative* — which inputs it now accepts, and why none of them can
carry a structural change. Adding a case where the tool errs toward `changed`
needs no such argument.

Note that `rename-only` and `value-only` are not claims of safety: an exported
symbol rename breaks consumers, and a config value is behaviour. They exist so a
declared change class can be audited, which is why the sensible default gate is
`--assert format`. Keep that distinction intact in code, docs, and output.

## Releasing (maintainers)

Bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` re-runs the type check and the tests, refuses
to publish if the tag and the version disagree, and publishes through npm
Trusted Publishing — so the release carries a provenance attestation and no
long-lived npm token exists anywhere. The publisher has to be registered once
for this package on npmjs.com before the first release.

## Commits and PRs

- Commit messages in English, imperative mood ("Treat parse failures as
  changed"), describing the effect rather than the file touched.
- Keep PRs to one concern.
- If a change affects what a verdict means, update `README.md` in the same PR.
