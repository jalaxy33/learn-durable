# README sources

Snapshots downloaded 2026-11-26.

| File | Source | What it is |
|---|---|---|
| `pi-durable-README.v1.6.1.md` | tag `v1.6.1` (2026-11-25) | matches npm `@earendil-works/pi-durable@1.6.1`; current reference |
| `pi-durable-README.main.md` | `main` @ 2026-11-26 | identical to `v1.6.1` at this time; kept to track main |
| `pi-durable-README.v1.6.0.md` | tag `v1.6.0` (2026-11-20) | earlier release, kept for the diff |

`package.json` on main still says `1.6.0` and the CHANGELOG `[Unreleased]` section
describes what differs.

## 1.6.0 → 1.6.1

The tagged-union cleanup that was "Unreleased" on main became 1.6.1. v1.6.0 and
v1.6.1 are 1154 lines each with 10 diff hunks. Every difference is the shape of a
return value; no mechanism changed.

1. Parks: `{ sleep: {...} }` / `{ wait: {...} }` -> `{ kind: "sleep", ... }` / `{ kind: "wait", ... }`
2. `SignalState`: `{ value }` / `{ expired: true }` -> `{ kind: "value", value }` / `{ kind: "expired" }`
3. `onYield` result: `{ continue }` -> `{ kind: "continue", continue }`
4. `submit(tx, draft)` -> `admit(tx, draft)` (transaction form only; `submit(draft, context)` unchanged)
5. `beforeCompact` results: `{ decline: true }` / `{ summary }` -> `{ kind: "decline" }` / `{ kind: "summary", summary }`
6. `Wrap`: tagged with `kind: "tool" | "section"`
7. `Storage.commit()` `CommitResult`: tagged `stored` / `refused`
8. `handle.submit(tx, draft)` -> `handle.admit(tx, draft)` in the afterRun hook notes

Two unrelated fixes ship with 1.6.1: `NodeExecutionEnv` finds Git for Windows
through `git.exe` on `PATH` instead of falling back to the WSL `bash.exe`, and the
Node environment's text line reader no longer rescans an unfinished line after
every read (long lines were quadratic).
