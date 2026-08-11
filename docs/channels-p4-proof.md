# Channels P4 migration proof record

**Result:** PASS for the Channels P4 migration boundary at acceptance base
`f1729801822fec4d5754cb16c07e45e1d3303a07` on 2026-08-11 (darwin/arm64,
Node v25.9.0).

This record covers migration only: a frozen People snapshot becomes Channel
metadata/history/policy authority, terminal Channel-native admissions replace
additive-soak credentials, ordinary legacy People state is retired, and startup
will not serve either runtime before durable recovery finishes. It does not
claim a P5 workspace-bootstrap implementation or resolve unrelated repository
type failures.

## Terminal contract

- Each migrated active policy is reconciled only to its exact Channel member
  and source identity; pending/open admissions retain their policy and a
  recipient label only inside encrypted escrow.
- The host handoff remains chat-scoped and projects recipient label, expiry,
  relay readiness, and an independently verified Channel credential. It never
  projects People ids, source policy, room ids without a usable credential, or
  a retired token.
- [`PeopleToChannelMigrationFinalizationProductionRunner.ts`](../src/main/collaboration/PeopleToChannelMigrationFinalizationProductionRunner.ts)
  executes additive soak plus finalization before startup creates a Channel
  bootstrap. It carries the same closed legacy-write gate into the later
  [`HumanCollaborationStore`](../src/main/collaboration/HumanCollaborationStore.ts),
  so ordinary People writes cannot reopen after the committed receipt.
- Finalization persists the encrypted delta before recovery fencing, replays
  logs and policies idempotently, rotates terminal admissions, retires exactly
  the frozen ordinary-share scope, then commits the recovery receipt.

## Disposable production-state mission

`src/main/collaboration/PeopleToChannelMigrationFinalizationProductionRunner.test.ts`
uses a real temporary profile, filesystem-backed Channel/People stores, real
encrypted checkpoint paths, and a restartable production runner. It does not
touch a user profile.

The 14-case mission passed. It proves a successful terminal cutover, an
explicit P5 share-id exception, encryption refusal before retirement, and
restart convergence after every durable boundary:

- write-gate quiescence and finalization checkpoint;
- recovery fence, logs, and policies;
- terminal escrow, terminal metadata, and initial-invite retirement;
- final admission completion, People retirement, and committed receipt.

The terminal restart result contains only rotated credentials; the test checks
that the old Channel invitations are revoked and ordinary People shares are
absent.

## Combined Channels acceptance

The Channels selector covers `Channel*`, `PeopleToChannel*`, Human
Collaboration, closed IPC/preload bridges, host/member panels, renderer models,
and Channel-agent compatibility tests across `src/main`, `src/shared`,
`src/preload`, and `src/renderer/src`.

| Gate | Result |
| --- | --- |
| Combined Channels selector | PASS — 93 files / 795 tests |
| Terminal production mission | PASS — 1 file / 14 tests |
| TUI typecheck | PASS |
| Architecture guard | PASS — no added renderer-to-main runtime edges |
| Doctrine-integrity guard | PASS — 167 agent-read files checked |
| Format ratchet | PASS |

The selector first found one stale textual integration assertion after host
startup moved behind the terminal coordinator. The isolated test-only repair is
`f17298018`; the rerun above is against that repair.

## Full typecheck accounting

The Channels paths are type-clean, but the full repository typecheck is not
green because of existing unrelated errors:

| Command | Result | Unrelated blocker |
| --- | --- | --- |
| `npm run typecheck:node` | blocked | `src/main/muse/MuseIpcBridge.test.ts:274` (TS2352, TS2493) and `src/main/muse/MuseRun.ts:405` (TS2339) |
| `npm run typecheck:web` | blocked | `src/renderer/src/lib/GeminiAdapter.ts:254` (TS2345: required `model`) |
| `npm run typecheck:tui` | PASS | — |

These failures are outside the Channels claim and were left untouched.

## P5 boundary

The terminal scope accepts an explicit list of retained workspace-bootstrap
People share ids. There is no P5 workspace-bootstrap producer in the current
production root, so startup deliberately supplies an explicit empty list rather
than inferring one from chat ids or People content. P5 must replace that port
with its exact retained ids before it introduces such a share; it is the only
remaining People edge by design.
