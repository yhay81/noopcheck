# noopcheck

> Checks whether a "this is just a refactor" change really changes nothing — and points at the exact files where it does.

A 3,000-line `chore: rename` PR lands. Someone has to decide whether to actually read it or trust the label. noopcheck decides deterministically, per file:

```
$ npx -y noopcheck origin/main

  format-only     src/api/client.ts
  format-only     src/api/server.ts
  …19 more format-only files…
  rename-only     src/util/ids.ts
  changed         src/api/retry.ts
  changed         src/config.ts

27 files: 2 changed, 1 rename-only, 21 format-only, 3 whitespace-only
→ read these 3: src/util/ids.ts, src/api/retry.ts, src/config.ts
```

The same verdict works as a CI gate for the change class a PR (or a coding agent) **declares**:

```bash
noopcheck origin/main --assert format   # exit 1 unless everything is formatting-level
```

Only two revisions are read, so `fetch-depth: 2` is enough — no full clone:

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 2 }
- run: npx -y noopcheck HEAD^ --assert format
```

## What the verdicts mean — and what they do not

TS/TSX files are compared at the **AST level** by [dowsing](https://github.com/yhay81/dowsing)'s structure-fingerprint engine (three normalized hashes of the syntax tree; parse failures and tiny files land in `changed` — fail-closed, always):

| Verdict           | Meaning                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `identical`       | Byte-identical (file move, mode change)                                                            |
| `format-only`     | AST identical down to names and values — whitespace, comments, semicolons                          |
| `whitespace-only` | Non-TS text equal after stripping whitespace                                                       |
| `rename-only`     | Same structure, identifiers renamed                                                                |
| `value-only`      | Only literal values changed (version bumps, build stamps)                                          |
| `changed`         | The structure changed — read it                                                                    |
| `unverified`      | Non-TS content change — shown, and treated as `changed` by `--assert`, never silently dropped      |

**This is not a safety proof.** Structural equivalence is not semantic equivalence: renaming an *exported* symbol breaks consumers, and a changed config value *is* a behaviour change — which is why `rename` and `value` are classes you must declare explicitly, and why the sensible CI default is `--assert format`. What noopcheck collapses is **review scope**; what it audits is a **claim**. If your tests already prove the change harmless, you may not need it — its value concentrates where diffs are too large to read and where an agent's "refactor only" needs checking before merge.

## Usage

```bash
noopcheck <base>                  # verdict table + "read these N"
noopcheck <base> --assert format  # gate: exit 1 on anything beyond formatting
noopcheck <base> --json           # for scripts and agents
noopcheck <base> --head <ref>     # compare base...ref instead of base...HEAD
```

## Status

Early. The AST engine is inherited from [dowsing](https://github.com/yhay81/dowsing) (now archived), where its classifications were manually audited against real diffs (it caught release-bot version bumps by content alone), but noopcheck itself has not yet been run against a broad corpus — treat surprising verdicts as bug reports, they are welcome. The engine ships vendored with this repository (`vendor/dowsing-0.3.0.tgz`, packed from the archived project's final state), so noopcheck is self-contained.

## License

MIT
