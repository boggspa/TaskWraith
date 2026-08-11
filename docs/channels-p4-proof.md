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

| Gate                        | Result                                         |
| --------------------------- | ---------------------------------------------- |
| Combined Channels selector  | PASS — 93 files / 795 tests                    |
| Terminal production mission | PASS — 1 file / 14 tests                       |
| TUI typecheck               | PASS                                           |
| Architecture guard          | PASS — no added renderer-to-main runtime edges |
| Doctrine-integrity guard    | PASS — 167 agent-read files checked            |
| Format ratchet              | PASS                                           |

The selector first found one stale textual integration assertion after host
startup moved behind the terminal coordinator. The isolated test-only repair is
`f17298018`; the rerun above is against that repair.

## Full typecheck accounting

The Channels paths are type-clean, but the full repository typecheck is not
green because of existing unrelated errors:

| Command                  | Result  | Unrelated blocker                                                                                      |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------ |
| `npm run typecheck:node` | blocked | `src/main/muse/MuseIpcBridge.test.ts:274` (TS2352, TS2493) and `src/main/muse/MuseRun.ts:405` (TS2339) |
| `npm run typecheck:web`  | blocked | `src/renderer/src/lib/GeminiAdapter.ts:254` (TS2345: required `model`)                                 |
| `npm run typecheck:tui`  | PASS    | —                                                                                                      |

These failures are outside the Channels claim and were left untouched.

## P5 boundary

The terminal scope accepts an explicit list of retained workspace-bootstrap
People share ids. There is no P5 workspace-bootstrap producer in the current
production root, so startup deliberately supplies an explicit empty list rather
than inferring one from chat ids or People content. P5 must replace that port
with its exact retained ids before it introduces such a share; it is the only
remaining People edge by design.

## 2026-08-11 post-proof addendum — review fixes

An adversarial review after the record above found three defects in the
committed-state contract; all are fixed with red-first tests, and the combined
Channels selector, the terminal production mission, and both node/web
typechecks were rerun green on the fixed tree.

1. **Empty-scope settle (`72d151950`, predates this addendum).** The
   frozen-scope classifier read an empty legacy scope as forever
   `awaiting_retirement`, blocking startup on every profile with zero People
   shares. The classifier now resolves `retired` first, and the
   chats-present/zero-share upgrade profile has an end-to-end production test.
2. **Committed fast-path.** Every boot re-ran the additive route verify and the
   terminal metadata digest comparison against the live Channel store, so any
   post-commit product activity — a posted message, a member join, a closed
   channel, or history deletion — permanently blocked the next launch. Once the
   recovery intent is `committed`, startup now verifies the immutable chain
   (intent, receipt, sealed execution digest, manifest digest, escrow) and
   rebuilds the startup projection from the durable manifest and terminal
   escrow. Initial additive invitations are still verified unusable wherever
   they survive; migration-window recovery (`finalizing`) keeps the strict
   frozen-world checks.
3. **Erasure integration.** `purgeAllShares` asserted the legacy write gate
   with no share id, so a post-migration global history clear wedged forever
   and stranded queued collaborator message bodies. It now asserts per share:
   an empty store settles, retained P5 shares are erased, and an ordinary share
   surviving quiescence still fails closed. The plaintext pre-migration People
   backup is likewise no longer immortal: it is deleted when the receipt
   commits (and on the next committed startup for profiles that committed
   before deletion existed), and a committed record tolerates its absence. The
   backup only ever served the prepare-to-commit crash window.

Two hardening follow-ups landed the same day: the People store now fsyncs its
snapshot writes (file and directory) and fails closed with a typed error when
an existing store file is unreadable, instead of silently serving an empty
share set that the migration would classify as already retired; and the
recovery store clamps a wall-clock step backward to the last durable timestamp
during migration-window writes instead of blocking startup until the clock
catches up.

Live launch verification on the fixed tree (isolated instance, profile seeded
from a real legacy install): first launch migrated and committed with the
backup deleted, the window opened, and a relaunch on the committed profile
opened the window in about two seconds through the committed fast-path with
the same plan id and no channel errors.

Known accepted dependency: every committed startup still decrypts the sealed
finalization execution and escrow via safeStorage. This is not separately
fixable at the migration seam — the Channel host identity store hard-requires
safeStorage, so an unavailable OS keychain takes down the channels subsystem
as a whole; graceful subsystem-wide degradation would be its own feature.

## 2026-08-11 real-profile soak

The roadmap's historical-profile soak ran against APFS clones of the real
development profile (about 263 chat-index entries and two genuine disabled
People shares; the source profile was never modified):

- **Upgrade:** first launch migrated and committed — 26 channels, one per
  General chat, all active; both real shares retired; the plaintext backup
  deleted; one receipt. Three consecutive relaunches opened the window within
  seconds through the committed fast-path with a stable plan id.
- **Interruption:** kill -9 storms across the first migration. Kills that
  landed before the first durable write left no state and converged from
  zero on the next launch; kills after commit converged through the
  fast-path; a resumed chain (kill, relaunch, kill, relaunch) also converged.
  The in-between durable boundaries are covered deterministically by the
  eleven-boundary crash matrix in the terminal production mission.
- **Demonstrated defect (open):** when safeStorage cannot decrypt the pinned
  People identity key (in the wild: keychain reset or restore-without-
  keychain; in the soak: clone under a different app-name keychain scope),
  the identity store correctly refuses to mint a replacement — but the
  channels bootstrap rethrow kills the whole app with no window and no
  durable evidence, before the migration's first write. This matches the
  observed dev no-window report exactly. Planned fix: fail closed for
  channels, fail open for the app — a degraded launch with channels
  unavailable, ordinary People writes still quiesced by a standalone gate,
  and a loud log line.
