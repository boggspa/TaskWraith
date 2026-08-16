# Channels P5 proof record

**Result: COMPLETE — Channel-native, with the People substrate deliberately
retained.** This record covers the boundary at `1b3085f39` on 2026-08-16
(darwin/arm64, Node v25.9.0). It supersedes the `7a723b835` boundary this
record first described; the earlier text is retained below wherever it is still
accurate.

**Read the verdict change carefully — it is the most misreadable line in this
document.** P5 moved off PARTIAL because **a decision resolved the blocker, not
because further work was done. No code changed between the PARTIAL verdict and
this one.** The single remaining item was a product question, and the user
answered it.

**The terminal shape is: Channel-native throughout, with the People substrate
deliberately retained as a documented degraded-mode recovery path by explicit
user decision.** It is **not** "People retired." Anyone who reads this record
and concludes the People substrate was removed has been misled by it.

What P5 achieved: the workspace-bootstrap question was answered and sealed, a
Channel-native external-seat authority was built and wired, every People read
in the composition root was cut over to it, the Channel-only seal (X4) was
taken, and a disposable-profile migration mission proved the blocked-channel
deferral end to end.

## The D2 decision — resolved, not deferred

**The legacy People store, runtime and IPC are deliberately retained.** The
consumer audit proved that on a degraded launch — one where Channels migration
fails at startup — Channels never start, but the People store, its runtime and
its IPC handlers are all still constructed, and `reopenCollaborationRooms`
re-opens rooms for every enabled share's still-live invite. Writes are
quiesced; **reads and reconnects still serve.** On that launch the People
fallback is the only remaining route to collaboration history and reconnect.

Retiring it would be a permanent, silent capability loss for exactly the users
least able to recover: someone whose migration fails on _every_ launch — an
undecryptable pinned identity key, for instance. A transient failure already
self-heals on the next relaunch, so the retained path costs nothing in the
healthy case.

The goal's own condition was to retire the remaining legacy People substrate
**"only when proven safe."** It was proven **not** safe. The user was asked and
chose **Keep**. That is the condition firing correctly — a resolved product
decision, not a retirement left unfinished and not deferred debt.

**The 54-class join stylesheet is retained with it**, by the same decision
applied consistently. Do not delete it. The scan that found those classes
unreferenced was **renderer-side**, while the degraded projection path
originates in **main**, and a class name carried across that boundary as data
is invisible to a renderer-only scan. With the capability now deliberately
kept, that risk is live rather than hypothetical. If the capability stays, its
styling stays.

Do not read "index.ts contains zero People reads" as "People is retired." The
composition root is clear; `HumanCollaborationRuntime`, the `ChatService`
collaboration lifecycle glue, the host-review and append paths, the external
contribution queue, and the promote-comment compatibility path all remain live.

## The workspace-bootstrap disposition

P5 opened with a genuine fork: implement the reserved workspace-bootstrap
People producer, or remove the seam. The panel found no producer, no caller,
and an explicit empty declaration supplied by production since P4. The user
approved a **scope expansion** rather than either original option: build the
Channel-native external-seat authority first, then retire People.

Frozen contract: workspace bootstrap is Channel-native. No automatic People
share is created for a workspace. Channels arise only from explicit Channel
action or migration. A sealed nonempty P4 retention list remains exact
compatibility state and is never inferred.

## Commits — what each one proved

Seventeen commits, in ancestry order. Listed by what they _proved_, not by what
they touched.

| Commit      | Slice      | What it proved                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `7a0aa69b7` | X0-RED     | That a Channel-shared chat was reachable by the create-time reaper. The red printed the defect: production `getSharedChatIds` had no Channel source. Also **bounded** the exposure — an ensemble-converted or renamed chat is never reaped, so the real window is a chat shared but not yet joined.                                                                                                                            |
| `471c8cd7f` | X0-FIX     | That the reaper now sees Channel-shared chats, **and** that an unreadable Channel authority protects every chat rather than reading as "nothing is shared".                                                                                                                                                                                                                                                                    |
| `e4d84087a` | P5-A       | That a fresh finalization capture cannot declare a workspace-bootstrap producer: `derive` accepts only `{ shares }` and rejects any extra key at runtime, while an already-sealed P4 list stays readable as compatibility state.                                                                                                                                                                                               |
| `337e9ff5a` | X1         | That an external-seat authority can be a **projection** over existing Channel stores — enforced by type, since it is handed read-only method subsets and cannot write. Its result discriminates `ready` from `recovery_blocked`, and the blocked arm carries neither `isShared` nor `seats`, so a caller cannot destructure a roster off it.                                                                                   |
| `7c6e70b6d` | X1-HARDEN  | That two distinct legacy identities can no longer collide into one seat. The delimiter-joined key was replaced with a JSON tuple encoding, making the ambiguity impossible rather than unlikely.                                                                                                                                                                                                                               |
| `e80471598` | X3         | That runtime member presence has an explicit state machine, with `unknown` treated as absent after restart and never optimistically present.                                                                                                                                                                                                                                                                                   |
| `88ed1870a` | X3-FIX     | That a member who reconnects after the grace window returns to `live` (it previously stayed `expired` forever), and that recovery blocking is **per channel**, with an uncertified channel defaulting to blocked.                                                                                                                                                                                                              |
| `066ac40d9` | X1-BARRIER | That the barrier is consulted **unconditionally**, not only while iterating members — closing the bypass where an owner-only Channel resolved `ready` without the barrier ever being read.                                                                                                                                                                                                                                     |
| `e67aac3e7` | X2-a′      | That the service certifies per-channel recovery to the barrier before reporting running. The red was a production bug: after **any** restart nothing certified a disk-recovered channel, so every channel stayed blocked for the whole session.                                                                                                                                                                                |
| `22cf8c760` | X2-a″      | That the authority is constructible **from the public service API alone** — proven end to end by building a real authority in a test and resolving a chat, which also proves X2-a′'s barrier certified the channel.                                                                                                                                                                                                            |
| `d404e481a` | X2-b       | That the iOS shared projection is Channel-native, and that the retired People arm cannot return — asserted by inversion, not deletion.                                                                                                                                                                                                                                                                                         |
| `2ebc72ef9` | X2-c       | That an approval gate refuses when the external set **cannot be enumerated**. It previously answered "a non-external authority exists" whenever the resolver was absent, and both callers use that answer to _permit_.                                                                                                                                                                                                         |
| `bd49d3887` | X2-c2      | That external collaborator seat ids come from the Channel authority in explicit `transitional` mode, and that a blocked authority answers `null` rather than an empty array. Also that an omitted `externalParticipantIds` key skipped the external check entirely.                                                                                                                                                            |
| `d6b22a4cc` | X2-c2-fix  | That the last path returning `[]` for an unidentifiable chat now returns `null` like its siblings. Reachability was **established, not assumed**: both call sites guard on a truthy chat id, so the line was unreachable; it was changed as hardening.                                                                                                                                                                         |
| `c965f2fb3` | X2-d       | That Ensemble seat delivery projects from the same authority through a single construction site, and that the adapter introduces no invented identity.                                                                                                                                                                                                                                                                         |
| `25d676263` | P5-C       | That production declares no workspace-bootstrap People producer **at all** — not even an empty one.                                                                                                                                                                                                                                                                                                                            |
| `7a723b835` | P5-C2      | That the now-dead runner shim is gone, with both P5-A proofs **converted rather than deleted**, and the durable persisted scope preserved.                                                                                                                                                                                                                                                                                     |
| `f8df646e7` | P5-E1      | This record.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `46ee7e14a` | P5-E2a     | That a recovery-blocked channel **defers** Ensemble delivery rather than dropping it. A disposable profile, real terminal migration, four launches, a deliberately corrupted Channel log forcing a scoped block, the real queue and orchestrator — the approved entry stayed unmaterialised while blocked, survived on disk to a repaired relaunch, and delivered **exactly once**. 12/12 assertions, zero production changes. |
| `fc98b705b` | P5-E2b     | That an **inherited** pre-Channels People share cannot survive to be read: after terminal migration `getShareForChat` returns null, and Channel-only resolution equals transitional resolution. Red first at 12 vs 14 assertions. Zero production changes. This is the proof that made X4 safe.                                                                                                                                |
| `1b3085f39` | P5-X4      | That production resolves external seats Channel-only. The transitional People fallback is retired as a **dead read**, not a narrowing.                                                                                                                                                                                                                                                                                         |

Ownership: `@Work1` produced P5-A, X1, X1-HARDEN, X1-BARRIER, P5-C2, E2a and
E2b. `@Work2` produced X3 and X3-FIX. `@Work3` produced the remaining eleven.

## Definition of done — evidenced versus open

### Evidenced

- **The workspace-bootstrap contract is explicit** and frozen in source, with
  fresh captures unable to declare a producer.
- **A retained legacy share is identified by exact durable authority.** The
  sealed P4 list comes from the encrypted finalization execution; nothing is
  inferred from chat ids or People content.
- **The Channel-native path has focused unit and production-composition
  tests.** 919 tests across 80 files in the Channels surface pass at this
  boundary.
- **The Channel-only seal (X4) is taken**, on proof that the transitional arm
  is unreachable rather than unwanted. See residual 1 for the exact shape of
  that discharge.
- **A disposable-profile live migration and restart mission runs**, never
  touching the real profile: `mkdtempSync` work root, worker-owned userData and
  workspace, multiple relaunches. Two committed missions (`46ee7e14a`,
  `fc98b705b`), both with zero production changes.
- **The dead transitional branch is removed (X4b, `8b699c9f0`).**
  `ChannelExternalSeatLegacyAuthority` is now exactly `{ mode: 'channel_only' }`
  — a single-member type, so the retired mode is **unrepresentable** rather than
  merely unused, and the authority carries zero transitional, People, share or
  presence-fallback references. Removal was observed red at 6 failed / 7 passed
  and **all thirteen tests were rebased rather than deleted**, six of them
  converted into Channel-only guarantees.

  It also **rescued a live invariant that was riding inside the dead branch**:
  duplicate migration-source-binding rejection, which the old fallback's tuple
  map enforced incidentally. It is now a dedicated injective `seenPolicySources`
  check, so retiring the branch did not quietly retire a guard with it. That is
  the kind of thing a bulk deletion loses silently.

  The safety question behind it is closed:
  `startPeopleToChannelMigrationBootstrap` calls `runner.runToCompletion`
  **first** and constructs Channels only after terminal success, and any throw
  leaves `channelProductionBootstrap` null so external-seat resolution returns
  `null` before the authority is ever constructed. A half-retired profile could
  never have served the transitional authority, so the branch was not a valve.

- **Production builds pass.** `npm run build` exits 0 — both runtime
  qualifications, the full node/web/tui typecheck, `electron-vite build` at 1568
  modules, and `tui:build`. Full platform packaging (`build:mac`, `build:win`,
  `build:linux`) was **deliberately not run**: it additionally requires Swift
  bridge builds, universal deps, electron-builder and signing/notarization
  paths, which is release activity rather than a P5 acceptance gate.
- **D1 removed everything provably dead (`80b960af8`).** Four renderer files,
  −317, proven by checking all eight exported symbols individually rather than
  trusting a module-name grep. The join stylesheet is deliberately **not** part
  of it: it is retained with the capability it may serve, by the same decision
  that retained the substrate.
- **Full typechecks pass** — `typecheck:node`, `typecheck:web`, and
  `typecheck:tui` are all clean at this boundary.
- **Architecture and doctrine-integrity guards pass.**
- **No People ids, source policies or legacy tokens reach UI or IPC.** Verified
  twice from different angles, and the answer needs stating rather than
  implying, because the safe behaviour here looks identical to an oversight.

  **A seat id is sometimes a People collaborator id, and that is deliberate.**
  `ChannelExternalSeatAuthority` derives it as
  `policy?.sourceCollaboratorId ?? member.memberId` (`:180`), so a member bound
  by an exact migration policy keeps its **legacy** identity. That is intended
  identity **continuity** — the same human keeps the same seat across migration,
  which is what stops approved contribution queues and stored authority from
  stranding — not a leak. The type header (`:5-11`) states the rule it must obey:
  _"X2 may consume it inside main but must not expose the compatibility identity
  through UI or IPC."_

  **That rule was checked, not taken on trust.** The only consumer of the
  Channel-derived population is the X2-d adapter, which passes
  `collaboratorId: seat.seatId` into `EnsembleOrchestrator.deps.resolveExternalSeats`.
  That dependency is **main-private**: its production references are
  `index.ts:56260`, the declaration at `EnsembleOrchestrator.ts:652` and the use
  at `:20672`, and there is **nothing in `src/preload`**. The legacy id never
  crosses an IPC boundary.

  The public seat shape also carries no share id, relay room, token, policy
  rule or migration digest — `sourceShareId` is excluded by construction, and
  the X2-d adapter passes `shareId: ''` rather than inventing one.

  **A dormant surface, named as a watch-item and explicitly NOT a current
  leak.** `ExternalSeatInput` (`src/shared/effectiveEnsembleRoster.ts:74`)
  carries both `shareId` and `collaboratorId`, and
  `EnsembleParticipantsAboveRow.tsx:664` accepts
  `externalSeats?: readonly ExternalSeatInput[]` as an **optional** prop — a
  renderer path structurally capable of carrying People identifiers to the DOM.
  It is unwired: all five non-test references to `externalSeats` are inside that
  component itself (`:664` declaration, `:819` destructure, `:862` comment,
  `:865` and `:867` memo), so **no caller anywhere supplies it**. The component
  is live and rendered (`Composer.tsx:2664`); the prop is not filled. This is
  pre-existing architecture that P5 did not introduce and does not use. It is
  recorded so that whoever wires it later knows the prop can carry a legacy
  identity to the DOM, and must not feed it from the Channel path without
  re-deciding this question.

- **Obsolete People surfaces removed only after their final consumer was proven
  gone — SATISFIED, NOT WAIVED.** This item requires removal _only after_ the
  final consumer is proven gone. It was honoured **in both directions**. D1
  (`80b960af8`) removed the four modules whose consumers were proven gone, with
  all eight exported symbols individually verified unreferenced rather than
  trusting a module-name grep. Everything else was retained **precisely
  because** its consumer is live — `HumanCollaborationRuntime`, the
  `ChatService` collaboration lifecycle, clear/delete preservation, the external
  contribution queue, and the promote-comment compatibility path. Removing those
  would have violated the item; retaining them satisfies it. That is the item
  passing, not the item being excused.

  One boundary that was never assessable: `src/preload/index.ts` was
  foreign-claimed by a concurrent session for the whole round, so the preload
  edge could not be opened at all. Stated rather than reasoned around.

### Retained by decision — not open, not deferred

- **The People store, runtime and IPC.** Resolved by explicit user decision, for
  the reasons in "The D2 decision" above. The consumer classification is
  complete; the retention is deliberate. The audit that produced this decision
  also found production **contradicting its own comment** — the degraded startup
  path claimed "neither runtime serves collaboration state this launch" when
  reads and reconnects plainly do — and that false comment was corrected in
  `ad5706d74` so the next engineer cannot inherit it.
- **The 54-class join stylesheet**, retained with the capability it may serve.
  `.needs-input-banner*` is live regardless and must survive any future cleanup.

### Still open — genuinely, and not claimed otherwise

- **Crash recovery across every new durable boundary** is proven for the
  runtime presence and per-channel barrier work, but not end to end through a
  real migrated profile.
- **Startup and interrupted-start recovery cannot serve inconsistent state** is
  evidenced at the unit level; the live interrupted-start matrix was not run as
  a full matrix.
- **Full platform packaging** (`build:mac`, `build:win`, `build:linux`) was
  never in P5 scope and was not run.

## Named residuals

These are the three things a reader must not have to discover.

### 1. Transitional dual-state dedupe — DISCHARGED AS PROVEN UNREACHABLE

**Read this discharge carefully: the dedupe was never proven to work end to end
in production. It was proven that production cannot reach it.** That is a
legitimate discharge, but it is a different claim, and the two must not be
conflated in any later summary.

The original residual was that the dual-state dedupe — merging a migrated
People participant with its bound Channel member — was proven only in
`ChannelExternalSeatAuthority.test.ts` with **injected stores**. The
disposable-profile mission was expected to prove it with a real population.

The mission could not, and the reason is the finding. The state is not
producible:

- **It cannot be created.** `assertOrdinaryWriteAllowed` returns early only if
  the gate is not quiesced _or_ the share id is in the sealed compatibility
  set. Every fresh P5 capture quiesces with an **empty** retained set, and
  nothing is a member of an empty set — so after migration every ordinary
  People write throws. Even the degraded startup path assigns a pre-quiesced
  gate. The People store is latched shut.
- **It cannot be inherited.** An ordinary pre-Channels share is physically
  deleted by terminal migration before either runtime serves — proved
  executably in `fc98b705b`. A sealed P4 compatibility share survives but is
  **disabled**, and `getShareForChat` returns only `enabled` shares, so it can
  never become `legacyShare`.

X4 (`1b3085f39`) then retired the arm. There is also a **structural**
equivalence argument that does not depend on any profile: the authority blocks
whenever `legacyShare && !activeChannel`, so any `ready` return with a truthy
legacy share also has a truthy active channel, making
`isShared: Boolean(activeChannel || legacyShare)` identical under both modes on
the ready path.

**What remains unproven, stated plainly:** if a future change reintroduces a
route by which a legacy share becomes both _enabled_ and _present_ alongside an
active Channel, the dedupe logic behind it has never run against real
production data. The code is now **gone** rather than merely unreachable — X4b
(`8b699c9f0`) removed the branch and narrowed the mode to a single-member type
— so re-opening that route would mean deliberately rebuilding the fallback, not
flipping a flag.

### 2. Ensemble delivery collapses a blocked authority to `[]` — DEFERRAL PROVEN, BOUND UNCHANGED

Every other consumer preserves `null` for "cannot enumerate". Ensemble seat
delivery cannot: its dependency signature is
`(chatId) => readonly ExternalSeatInput[]`, with no way to express "unreadable",
so a blocked authority becomes an empty roster.

The mitigation is real — the contribution queue **retains** the entry and the
next delivery pass retries, so nothing is lost. But the deferral is worse than
"until the next pass":

Production has exactly **two** call sites for `setChannelAuthorityState` — the
`start()` certification loop and `createChannel`. **Nothing re-certifies an
existing channel mid-session.** A channel blocked at startup therefore stays
blocked for the entire session, so delivery is deferred until the next app
launch, with **no user-facing signal**. A `console.warn` is emitted; a user sees
nothing.

**The deferral is now PROVEN, by mission rather than by argument.** `46ee7e14a`
ran a disposable profile through a real terminal migration, corrupted a Channel
log to force a scoped recovery block, invoked the real Ensemble delivery path,
and asserted across four launches that the approved entry stayed unmaterialised
while blocked, **survived on disk to a repaired relaunch**, and then delivered
**exactly once**. Survival across relaunch is the property that makes this a
deferral and not a loss, and it is now executable evidence rather than
reasoning.

**The bound is unchanged and still accepted, not fixed.** Delivery is still
deferred for the remainder of the session with no user-facing signal, because
nothing re-certifies mid-session. Fixing that properly means either widening
the orchestrator dependency to express "unknown", or adding a re-certification
path. Neither is in P5.

### 3. Service accessor narrowing is type-level, not capability-level

`externalSeatRuntimeAuthority()`, `externalSeatChannelStore()`, and
`externalSeatHumanPolicyStore()` return the real objects narrowed by TypeScript
to read-only method subsets. A deliberate cast reaches the underlying stores'
mutators. This matches X1's own idiom — the runtime seam it consumes is the
same shape — so it is consistent rather than a shortcut, but it is **not** the
structural guarantee X1's constructor options provide.

**Do not describe these accessors as structurally unreachable.**

## Behaviour changes

One user-visible behaviour change landed, authorized by the contract ledger's
"do not preserve the current fail-open resolver behavior":

**Ensemble auto-approvals now refuse to elevate when the external-seat set
cannot be enumerated.** Previously, an unreadable seat authority answered "a
non-external approval authority exists", and both consumers use that answer to
permit — one of them carrying an unattended auto-approval. A launch where
Channels is degraded, or where a channel's recovery is blocked, now prompts the
human instead of auto-approving.

Everything else in P5 is behaviour-preserving or fixes a defect.

## The systemic finding

The most transferable thing this round produced, in three variants. All three
are the same failure: **the thing that looked like a guard was not one.**

1. **Security-adjacent logic in the composition root can only be proven by a
   textual pin.** A pin asserts that the source _says_ something, never that it
   is _right_. Both of this round's real defects lived in `src/main/index.ts`:
   the reaper's `getSharedChatIds` had no Channel source, and the approval gate
   failed open. Neither could be unit-tested where it lived. Both were fixed by
   moving the decision into a tested module — `AbandonedChatReaper` already had
   one, and `hasNonExternalApprovalAuthority` was extracted into
   `ExternalSeatResolution`.

2. **A correct runtime guard can be unreachable because the seam's declared
   type is narrower than its real contract.** `BossmanAutoApproval` already
   refused any non-array `externalParticipantIds`, with a comment stating
   "unusable evidence about who is external is NOT the same as no externals".
   But the declared type forbade `null`, so the caller **omitted the key** — and
   an omitted key skipped the check entirely. The guard was right and
   unreachable for the exact case it existed to catch.

3. **An empty collection silently asserts a fact.** Returning `[]` for "I
   cannot enumerate" is not neutral; it positively claims "there are none", and
   every consumer downstream believes it. The X1 discriminated result, the
   `null` seat resolver, and the per-channel `?? 'recovery_blocked'` default all
   exist to keep _unknown_ distinguishable from _empty_. Residual 2 is the one
   place that discipline breaks, and it is disclosed rather than hidden.

A fourth, procedural: **a rewritten assertion is not automatically a weakened
one.** Three pins were rewritten this round, each by **inversion** — a pin that
required a legacy union now asserts its absence; a pin that required the
retention port now asserts the port is gone. Each ended stronger than what it
replaced. The distinguishing evidence is the commit message stating why the
contract changed.

## Corrections

Recorded as corrections because a proof record that inherits its round's wrong
turns is worth less than one that names them.

- **"X3 supplied a global recovery barrier" was wrong** (`@Orchestrator`).
  `@Advisor` proved the check was member-conditional: it was consulted only
  while iterating active external members, so an owner-only Channel and a
  People-only share bypassed it entirely. X3-FIX and X1-BARRIER closed it.
- **"`src/main/index.ts` is unclaimed" was time-sensitive and later false**
  (`@Orchestrator`). The file's claim state changed at least four times during
  the round. Every write was re-verified at the moment of writing, which is why
  no collision occurred.
- **`@Challenge2`'s legacy-write-gate proof supersedes `@Orchestrator`'s.** It
  traced the degraded-launch path, which the earlier proof missed: the degraded
  startup constructs and quiesces a fresh gate, so "new People writes are
  impossible" holds on both the success and failure paths.
- **The People-only fail-closed behaviour was DESIGN-RULED by `@Advisor`, not
  user-approved.** The user ruled only on how the barrier _composes_ (scoped,
  per channel). The decision that a People-only share resolves
  `recovery_blocked` is `@Advisor`'s, justified on startup-ordering merits. The
  two must not be merged in any later summary.
- **This record itself went stale for three slices, and that is an
  orchestration failure rather than an authoring one.** D1 (`80b960af8`), X4b
  (`8b699c9f0`) and the production builds all landed after the last content
  update, and none of them carried the obligation to update the record. It was
  caught only by the final adversarial audit — **independently, by two
  reviewers** — which is the strongest signal an audit can give, and also the
  latest possible moment to find it. The structural rule at the end of this
  document exists because of it.
- **Two citations and three symbols were fabricated during the round** by three
  different seats, and none reached a commit. Every one was caught by opening
  the file. That is the only reason this record can be trusted.

## Workspace safety finding — work-guard claim ownership

`work-guard` matches claim ownership on `agent` + `participantId`. Two
concurrent rounds were running `claude/opus-5` at seat `p9`. The commit hook
therefore attributed a **different live session's** claims to this one, and
twice instructed this seat to release them:

- `.WORK-IN-PROGRESS-studio-stale-hydration-overwrite.md`
- `.WORK-IN-PROGRESS-studio-startup-delivery-order.md`

Both belonged to a **different concurrent round's session**, declared Swift
Studio paths, and were covering work actively in flight — that session's work
subsequently landed as `6516f5a0d`. Obeying the hook would have stripped a live
session's protection on three files.

**Rule:** before releasing any marker on a hook's say-so, open it and compare
the **session id**. Ownership attribution on `agent` + `participantId` alone
cannot distinguish concurrent sessions.

## Acceptance boundary

- Base: `3d576061d`, branch `master`. First written at `7a723b835` and updated
  in place at `1b3085f39` and again here, as its own closing instruction
  required.
- Verified at this boundary: the Channels-surface suites, the full node/web/tui
  typecheck triple, architecture guard, doctrine-integrity guard, the format
  ratchet, and `npm run build` (exit 0).
- Proven by committed disposable-profile mission: blocked-channel deferral with
  queue survival across relaunch (`46ee7e14a`), and inherited-share
  non-survival with Channel-only/transitional equivalence (`fc98b705b`).
- Not verified at this boundary: full platform packaging, which was never in P5
  scope.
- **The code boundary did not move when the verdict changed.** The People
  substrate was retained by decision, not by a code change, so `3d576061d`
  remains the verified boundary and the commits after it are docs-only.
- This record must be updated, not replaced, if the retained People substrate is
  ever revisited.

**A rule this record learned the hard way, and the reason it is written here
rather than in a commit message: the record must be updated by the slice that
changes its truth, not by a later pass. A slice is not complete until the
record reflects it.** This document went stale for three consecutive slices —
D1, X4b and the production builds — because each was routed without the update
being part of it. A document that describes live state and has no
owner-by-default goes stale silently, which is precisely the failure mode this
round spent its time hunting in code.
