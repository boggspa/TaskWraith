# Channels P6 plan — verification gates for 1.9.7

**Read this first: P6 is not "finishing P5."** Channels P5 met its objective and
its goal is complete. The items below are **verification gates that P5 never
claimed to have run** — they are named in P5's own record, in its own words, and
this document exists so they cannot be buried by the passage of time.

Companion document: [`channels-p5-proof.md`](channels-p5-proof.md). That record
is the source of truth for what P5 proved. This one is the source of truth for
what remains unproven.

## The one thing that must not be misread

**The Keep decision is product state, not implementation debt.**

The legacy People store, its runtime and its IPC are **deliberately retained**,
by explicit user decision, as a documented degraded-mode recovery path. On a
launch where Channels migration fails — a persistently undecryptable pinned
identity key, for instance — Channels never start, and that path is the only
remaining route to collaboration history and reconnect. The 54-class join
stylesheet is retained **with** the capability it may serve.

None of that is on this list. It is not owed, not deferred, and not a cleanup
opportunity. Anyone who reads the retained People code as leftover and tidies it
away removes a recovery capability during precisely the failure it protects
against.

## What P5 left open, verbatim

Quoted exactly from `channels-p5-proof.md` so a future reader cannot re-read P5
as fully proven, and cannot mistake a paraphrase here for the original claim:

> - **Crash recovery across every new durable boundary** is proven for the
>   runtime presence and per-channel barrier work, but not end to end through a
>   real migrated profile.
> - **Startup and interrupted-start recovery cannot serve inconsistent state** is
>   evidenced at the unit level; the live interrupted-start matrix was not run as
>   a full matrix.
> - **Full platform packaging** (`build:mac`, `build:win`, `build:linux`) was
>   never in P5 scope and was not run.

P5's banner names the first two before it lists a single achievement, and closes
that paragraph with _"Do not read this banner as 'everything is proven.'"_ P6
exists to close them.

## P6-01 — Real-profile crash recovery, end to end

**The gap, stated precisely so nobody reads existing work as covering it.**

The P5 disposable-profile mission (`46ee7e14a`) already provides most of the
scaffolding: a `mkdtempSync` work root with worker-owned `userData` and
workspace, a real terminal People-to-Channel migration, a real
`ExternalContributionQueueStore`, real Ensemble delivery, and four launches. The
real profile is never named, never opened, never mutated.

**What it does not do is kill the process mid-write.** It forces its failure by
_tampering a migrated Channel log on disk_ between launches
(`scripts/channels-p5-live-migration-proof-worker.ts`, which rewrites a record's
content to `'tampered migrated history'`) and then asserts the channel fails
closed. That proves the recovery-blocked path and queue survival across a clean
restart. It does **not** prove durable-boundary recovery when a process dies
_during_ an active write.

That distinction is the whole item. A corrupted-file test exercises the read
side of recovery; a crash exercises the write side, where a partial record, a
torn rename, or an unflushed directory entry can exist.

**Acceptance:**

- A genuinely migrated profile with real queue and membership state.
- The process is killed during an active write path — not a corrupted file, not
  an injected exception, not a mocked failure.
- After relaunch: state converges, **no queue loss**, and delivery is still
  **exactly once**.
- Cover more than one durable boundary; a crash that only ever lands in the same
  window proves that window, not the property.

## P6-02 — The interrupted-start matrix, as an actual matrix

Currently evidenced at unit level only. The gate is the permutations, not the
individual assertions.

**Acceptance:**

- Cover the startup-gate permutations that can diverge across relaunch paths.
- Assert no inconsistent membership or seat state under **repeated** interrupted
  starts, not a single interruption.
- Keep the assertions strict: no silent fallback to an undefined state. An
  interrupted start that resolves to "no externals" must be distinguishable from
  one that resolves to "cannot enumerate" — that unknown-versus-empty
  distinction is load-bearing throughout the Channel seat authority, and a matrix
  that accepts either answer proves nothing.

## P6-03 — An executable retention pin

**This item exists because a document can be missed and a failing test cannot.**

The concern P6 was created to address is burial. Every other protection for the
Keep decision is prose: this plan, the P5 record, and a corrected comment in the
degraded-launch path. Prose survives exactly as long as someone reads it.

**Specify a pin that fails if the degraded-launch People path stops being
constructed** — the store, its runtime, its IPC handlers, and
`reopenCollaborationRooms` serving enabled shares.

**Frame it precisely, because the framing is the point.** The pin does **not**
forbid a future decision to retire People. It forbids retiring it _silently_. It
forces whoever does it to delete a test that names the reason, which converts a
quiet tidy-up into a deliberate act with a paper trail.

**Acceptance:**

- The pin fails if any of those four constructions disappear from the degraded
  path.
- Its failure message states _why_ the path is retained, not merely that
  something changed — a pin that says "expected 4, got 3" teaches nothing.
- It is written so that retiring People means editing the pin's stated reason,
  not deleting an assertion whose purpose is unclear.

## Explicitly scope-out — platform packaging

`build:mac`, `build:win` and `build:linux` are **not** P6 gates, and this is a
ruling rather than an open question. They are release-process activity —
requiring Swift bridge builds, universal deps, electron-builder, and
signing/notarization paths — and they belong to the release checklist for
whichever version ships, not to a Channels verification goal.

`npm run build` (both runtime qualifications, the full node/web/tui typecheck,
`electron-vite build`, and `tui:build`) **is** the applicable compile gate, and
it passed in P5. Recorded as an exclusion so it is not re-litigated each time
someone reads the residual list.

## Watch-items — carried forward, and not verification debt

These are **not** gates and must not be counted as such. They are properties a
future change could break, recorded so the person making that change knows.

- **The dormant `ExternalSeatInput` prop.** `EnsembleParticipantsAboveRow`
  accepts an optional `externalSeats` prop, and `ExternalSeatInput` carries both
  `shareId` and `collaboratorId`. It is currently **unwired** — every non-test
  reference lives inside the component itself, so no caller supplies it — and it
  is pre-existing architecture that P5 neither introduced nor uses. If anyone
  wires it from the Channel path during 1.9.7 work, it would carry a legacy
  identity to the DOM, and the UI/IPC leak question P5 closed would need
  re-deciding.
- **The Ensemble delivery deferral is session-long, not pass-long.** A
  recovery-blocked channel defers external-seat delivery rather than dropping it,
  and the queue retains the entry — but production has exactly **two**
  `setChannelAuthorityState` call sites (`ChannelRuntime.ts:371` on channel
  creation, and `ChannelProductionService.ts:752` in the start certification
  loop), so **nothing re-certifies an existing channel mid-session**. A channel
  blocked at startup stays blocked until the next launch, with no user-facing
  signal. Accepted in P5; still true.
- **The 54-class join stylesheet**, retained with the substrate it may serve.
  `.needs-input-banner*` is live regardless and must survive any future cleanup.
  Note that the scan which found those classes unreferenced was renderer-side
  while the degraded projection path originates in main, so a class name crossing
  that boundary as data would be invisible to it.
- **`humanCollaborationInviteHealth` is fully wired end to end, with zero
  renderer callers — not D1 residue.** This is the exact collision D1's own
  commit message named and set aside: the renderer module
  `humanCollaborationInviteHealth.ts` (deleted by D1) and the preload method
  `humanCollaborationInviteHealth` (still live) are two different identifiers
  that share a spelling. A name-based grep conflates them and misreads the
  live handler as D1 leftover — it is not; D1 touched exactly four files under
  `src/renderer/src/lib/`, none of them preload, IPC, or main. Verified at
  source: `src/preload/index.ts:2329` exposes it, `index.d.ts:2421` types it,
  `humanCollaborationHandlers.ts:330` implements a real handler returning
  chat/share/bridge/tailscale status (not a stub), and `IpcValidation.ts:178`
  plus `RendererIpcPolicy.ts:192` both register the channel — but
  `src/renderer` has zero references to it. **Disposition: open, not urgent,
  not a defect.** It sits inside the People IPC surface the Keep decision
  deliberately retains, so removing it would be D2-class work, not cleanup —
  D1's own commit message says so verbatim ("the IPC method is untouched and
  belongs to D2, which is blocked") — and `src/preload/index.ts` was
  foreign-claimed for P5's duration (a live marker blocked exactly this
  preload retirement mid-round), so it was never openable within P5 regardless
  of D2's status. Open, not answered: the handler itself never calls
  `validateParticipantSession` and nothing currently calls the handler, so
  whether invite-health should participate in the degraded-launch reconnect
  path is undetermined, not settled either way.

## How to close an item

An item leaves this list only when it is **proven**, not when it is judged
unlikely to matter. P5's habit is worth keeping: write the assertion you mean,
watch it fail first, and let the failure text state the defect. Seven real
defects were found that way, and the ones that mattered most were the ones where
the wrong answer looked exactly like the right one.
