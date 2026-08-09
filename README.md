# noopcheck

> Checks whether a "this is just a refactor" change really changes nothing — and points at the exact files where it does.

A 3,000-line `chore: rename` lands for review. Someone has to decide whether to actually read it or trust the label. noopcheck decides, per file, by comparing the syntax tree of each revision instead of the line diff:

```console
$ npx -y noopcheck origin/main

  format-only     src/api/client.ts
  format-only     src/api/server.ts
  …19 more format-only files…
  value-only      src/config/limits.ts
  changed         src/api/retry.ts

28 files: 5 changed, 13 value-only, 1 format-only, 9 unverified
→ read these 5 (structure moved): src/api/retry.ts, …
→ skim these 13 (only names or literals moved): src/config/limits.ts, …
  (10 files need no reading: identical, format-only, or whitespace-only)
```

That output is the whole product: **review scope, collapsed to what actually moved.** The same verdicts work as a CI gate for the change class a pull request — or a coding agent — *declares*:

```bash
noopcheck origin/main --assert format   # exit 1 unless everything is formatting-level
```

Only two revisions are ever read, so `fetch-depth: 2` is enough — no full clone, no history download, no `node_modules` in the repository under test.

## Try it on your own history first

Every repository already contains the experiment. `audit` replays the commits that declared themselves mechanical and reports how many really were:

```console
$ npx -y noopcheck audit

7 commits in HEAD declared themselves mechanical.
5 of them (71%) really were no-ops of the class they declared.

These 2 changed more than their subject line says — a reviewer reading only
the subject would not have known to look:

  692ce8eb  chore(deps): move the toolchain to vite-plus 0.2.8
    declared value, but site/.vitepress/config.ts (changed)
  53d8b59b  release: bump versions
    declared value, but packages/agent/src/executor.ts (deleted)
```

(Real output, from the repository this engine came from.) No configuration, nothing wired into CI, and evidence you can check commit by commit.

## What the verdicts mean — and what they do not

TS/TSX files are compared at the **AST level**; other text files get the whitespace tier and are otherwise `unverified` — shown, treated as changed by `--assert`, never silently dropped.

| Verdict           | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `identical`       | Byte-identical (file move, mode change)                                        |
| `format-only`     | AST identical down to names and values — whitespace, comments, semicolons      |
| `whitespace-only` | Non-TS text equal after stripping whitespace                                   |
| `rename-only`     | Same structure, identifiers renamed                                            |
| `value-only`      | Only literal values changed (version bumps, translated strings, config values) |
| `changed`         | The structure moved — read it                                                  |
| `unverified`      | Content we cannot judge — shown, and treated as changed by `--assert`           |

**This is not a safety proof.** Structural equivalence is not semantic equivalence: renaming an *exported* symbol breaks consumers, and a changed config value *is* a behaviour change. That is why `rename` and `value` are classes you must declare explicitly, and why the sensible CI default is `--assert format`. What noopcheck collapses is **review scope**; what it audits is a **claim**.

Everything ambiguous resolves toward "read it": parse failures, files too small to distinguish from a coincidence, unknown extensions, additions and deletions. A false "equivalent" is the one failure this tool must never have, so every arrow points that way. If you find one, [that is the bug report we want most](https://github.com/yhay81/noopcheck/issues/new?template=wrong-verdict.md).

## Wiring it in

```bash
npx -y noopcheck init
```

Writes two things, both safe to re-run:

- **`.github/workflows/noopcheck.yml`** — runs on every pull request with `fetch-depth: 2` and writes the verdict table to the job summary. No comment noise, no write permissions, and it never fails the build until you uncomment an `--assert` gate.
- **A section in `AGENTS.md`** — so coding agents working in the repository verify "refactor only" claims instead of asserting them. `--json` gives them the same data the table shows.

## Commands

```bash
noopcheck <base>                  # verdict table + what to read
noopcheck <base> --assert format  # gate: exit 1 on anything beyond formatting
noopcheck <base> --markdown       # PR comment / job summary
noopcheck <base> --json           # for scripts and agents
noopcheck audit [range]           # replay your own mechanical commits
noopcheck init                    # wire it into CI and AGENTS.md
```

Run `noopcheck --help` (or `noopcheck <command> --help`) for every option.

## As a library

The engine is exported, not just wrapped in a CLI — build your own gates, review tools, or agent verifications on it:

```ts
import { compareStructure, runCheck } from "noopcheck";

compareStructure("a.ts", before, after);
// → "identical" | "format-only" | "rename-only" | "value-only" | "changed" | "unknown"

const result = await runCheck(process.cwd(), "origin/main");
result.attention; // the files that need reading
```

## How it works

Each revision's syntax tree is hashed three times under different normalizations: with names and values, with names but no literal values, and with neither. Which hashes match tells you what class of change happened — a rename matches the name-free hash, a version bump matches the value-free one, reformatting matches all three. Parsing is [oxc](https://oxc.rs/); no type checker, no module resolution, no installed dependencies in the target repository.

The engine came from [dowsing](https://github.com/yhay81/dowsing) (MIT, same author, archived 2026-08), where its verdicts were manually audited against real revision pairs across eight open-source repositories — including catching release-bot version bumps by content alone. It is vendored here as source, so noopcheck depends on nothing that is no longer maintained.

## Requirements

Node.js `^22.18.0 || >=24.11.0`, and a git repository containing both revisions you want to compare.

## Status

Early, and honest about it: the engine has a validation record, but noopcheck itself has not been run against a broad corpus. Surprising verdicts are welcome as issues — especially anything that reads as equivalent when it is not.

Contributions welcome; see [CONTRIBUTING.md](./CONTRIBUTING.md), which documents the one invariant every change must preserve.

## License

[MIT](./LICENSE)
