# README sources

Both files downloaded 2026-11-23.

| File | Source | What it is |
|---|---|---|
| `pi-durable-README.main.md` | `main` @ 32c71a6 (2026-11-20 19:09 UTC) | includes post-1.6.0 "Unreleased" breaking changes |
| `pi-durable-README.v1.6.0.md` | tag `v1.6.0` (2026-11-20 11:35 UTC) | matches npm `@earendil-works/pi-durable@1.6.0` |

`package.json` on main still says `1.6.0`; the CHANGELOG `[Unreleased]` section
describes what differs. Both files are 1154 lines, 10 diff hunks.

Main-vs-1.6.0 differences (all are the "tagged union" cleanup):

1. Parks: `{ sleep: {...} }` / `{ wait: {...} }` -> `{ kind: "sleep", ... }` / `{ kind: "wait", ... }`
2. `SignalState`: `{ value }` / `{ expired: true }` -> `{ kind: "value", value }` / `{ kind: "expired" }`
3. `onYield` result: `{ continue }` -> `{ kind: "continue", continue }`
4. `submit(tx, draft)` -> `admit(tx, draft)` (transaction form only)
5. `beforeCompact` results: `{ decline: true }` / `{ summary }` -> `{ kind: "decline" }` / `{ kind: "summary", summary }`
6. `Wrap`: tagged with `kind: "tool" | "section"`
7. `Storage.commit()` `CommitResult`: tagged `stored` / `refused`
8. `handle.submit(tx, draft)` -> `handle.admit(tx, draft)` in the afterRun hook notes
