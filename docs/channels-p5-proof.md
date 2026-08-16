# Channels P5 proof record

**Result: PARTIAL — P5 is NOT complete.** This record covers the boundary at
`7a723b8353c38dc71fdb8d981c047c65b557a43c` on 2026-08-16 (darwin/arm64, Node
v25.9.0).

What P5 achieved: the workspace-bootstrap question was answered and sealed, a
Channel-native external-seat authority was built and wired, and every People
read in the composition root was cut over to it.

What P5 did **not** achieve, stated first so no reader infers otherwise: the
Channel-only seal (X4) has not been taken, the legacy People substrate has
**not** been retired (D1/D2), the disposable-profile live migration and restart
mission has **not** been run, and the full production builds have not been
exercised. Three named residuals remain open and are recorded in full below.

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

Seventeen commits, in ancestry order. Listed by what they *proved*, not by what
they touched.

| Commit | Slice | What it proved |
| --- | --- | --- |
| `7a0aa69b7` | X0-RED | That a Channel-shared chat was reachable by the create-time reaper. The red printed the defect: production `getSharedChatIds` had no Channel source. Also **bounded** the exposure — an ensemble-converted or renamed chat is never reaped, so the real window is a chat shared but not yet joined. |
| `471c8cd7f` | X0-FIX | That the reaper now sees Channel-shared chats, **and** that an unreadable Channel authority protects every chat rather than reading as "nothing is shared". |
| `e4d84087a` | P5-A | That a fresh finalization capture cannot declare a workspace-bootstrap producer: `derive` accepts only `{ shares }` and rejects any extra key at runtime, while an already-sealed P4 list stays readable as compatibility state. |
| `337e9ff5a` | X1 | That an external-seat authority can be a **projection** over existing Channel stores — enforced by type, since it is handed read-only method subsets and cannot write. Its result discriminates `ready` from `recovery_blocked`, and the blocked arm carries neither `isShared` nor `seats`, so a caller cannot destructure a roster off it. |
| `7c6e70b6d` | X1-HARDEN | That two distinct legacy identities can no longer collide into one seat. The delimiter-joined key was replaced with a JSON tuple encoding, making the ambiguity impossible rather than unlikely. |
| `e80471598` | X3 | That runtime member presence has an explicit state machine, with `unknown` treated as absent after restart and never optimistically present. |
| `88ed1870a` | X3-FIX | That a member who reconnects after the grace window returns to `live` (it previously stayed `expired` forever), and that recovery blocking is **per channel**, with an uncertified channel defaulting to blocked. |
| `066ac40d9` | X1-BARRIER | That the barrier is consulted **unconditionally**, not only while iterating members — closing the bypass where an owner-only Channel resolved `ready` without the barrier ever being read. |
| `e67aac3e7` | X2-a′ | That the service certifies per-channel recovery to the barrier before reporting running. The red was a production bug: after **any** restart nothing certified a disk-recovered channel, so every channel stayed blocked for the whole session. |
| `22cf8c760` | X2-a″ | That the authority is constructible **from the public service API alone** — proven end to end by building a real authority in a test and resolving a chat, which also proves X2-a′'s barrier certified the channel. |
| `d404e481a` | X2-b | That the iOS shared projection is Channel-native, and that the retired People arm cannot return — asserted by inversion, not deletion. |
| `2ebc72ef9` | X2-c | That an approval gate refuses when the external set **cannot be enumerated**. It previously answered "a non-external authority exists" whenever the resolver was absent, and both callers use that answer to *permit*. |
| `bd49d3887` | X2-c2 | That external collaborator seat ids come from the Channel authority in explicit `transitional` mode, and that a blocked authority answers `null` rather than an empty array. Also that an omitted `externalParticipantIds` key skipped the external check entirely. |
| `d6b22a4cc` | X2-c2-fix | That the last path returning `[]` for an unidentifiable chat now returns `null` like its siblings. Reachability was **established, not assumed**: both call sites guard on a truthy chat id, so the line was unreachable; it was changed as hardening. |
| `c965f2fb3` | X2-d | That Ensemble seat delivery projects from the same authority through a single construction site, and that the adapter introduces no invented identity. |
| `25d676263` | P5-C | That production declares no workspace-bootstrap People producer **at all** — not even an empty one. |
| `7a723b835` | P5-C2 | That the now-dead runner shim is gone, with both P5-A proofs **converted rather than deleted**, and the durable persisted scope preserved. |

Ownership: `@Work1` produced P5-A, X1, X1-HARDEN, X1-BARRIER, P5-C2. `@Work2`
produced X3 and X3-FIX. `@Work3` produced the remaining ten.

## Definition of done — evidenced versus open

### Evidenced

- **The workspace-bootstrap contract is explicit** and frozen in source, with
  fresh captures unable to declare a producer.
- **A retained legacy share is identified by exact durable authority.** The
  sealed P4 list comes from the encrypted finalization execution; nothing is
  inferred from chat ids or People content.
- **The Channel-native path has focused unit and production-composition
  tests.** 922 tests across 81 files in the Channels surface pass.
- **Full typechecks pass** — `typecheck:node`, `typecheck:web`, and
  `typecheck:tui` are all clean at this boundary.
- **Architecture and doctrine-integrity guards pass.**
- **No People ids leak through the seat projection.** The public seat shape
  carries no share id, relay room, token, or policy rule. A legacy
  `collaboratorId` surfaces only for a member whose migration policy explicitly
  binds it — verified at source by `@Challenge2`.

### Open — not done, and not claimed

- **The Channel-only seal (X4).** Production runs `transitional` mode with the
  People fallback attached. The seal is a deliberate, explicit mode change and
  has not been taken.
- **D1/D2 People retirement.** The remaining live consumers are
  `HumanCollaborationRuntime`, the `ChatService` collaboration lifecycle,
  clear/delete preservation, the external contribution queue, and the
  promote-comment compatibility path. `index.ts` being clear is necessary, not
  sufficient.
- **Obsolete People IPC, preload types, sessions, invitations, storage, and
  startup wiring** are still present. Note: `src/preload/index.ts` was
  foreign-claimed during this round, so preload retirement was never openable.
- **The disposable-profile live migration and restart mission** has not been
  run. This is P5-E2.
- **Applicable production builds** have not been run at this boundary.
- **Crash recovery across every new durable boundary** is proven for the
  runtime presence and per-channel barrier work, but not end to end through a
  real migrated profile.
- **Startup and interrupted-start recovery cannot serve inconsistent state** is
  evidenced at the unit level; the live interrupted-start matrix belongs to
  P5-E2.

## Named residuals

These are the three things a reader must not have to discover.

### 1. Transitional dual-state dedupe is proven only at authority level

The dedupe that merges a migrated People participant with its bound Channel
member is proven in `ChannelExternalSeatAuthority.test.ts` with **injected
stores**. It is not proven end to end through the production composition
feeding it real data. Doing so requires a migrated policy binding plus a People
participant admitted through the real invite flow — the population the
disposable-profile mission creates naturally.

**Bound:** the logic is tested; the production wiring that feeds it is proven
only by a textual composition pin asserting `mode: 'transitional'` and the
presence of the share store and presence resolver.

**Owner:** P5-E2, as a *named* acceptance item. If the round ends before P5-E2
runs, this remains unproven and this record is the disclosure.

### 2. Ensemble delivery collapses a blocked authority to `[]`, session-long

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

**Accepted as a residual for P5, not fixed.** Fixing it properly means either
widening the orchestrator dependency to express "unknown", or adding a
re-certification path.

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
   textual pin.** A pin asserts that the source *says* something, never that it
   is *right*. Both of this round's real defects lived in `src/main/index.ts`:
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
   exist to keep *unknown* distinguishable from *empty*. Residual 2 is the one
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
  user-approved.** The user ruled only on how the barrier *composes* (scoped,
  per channel). The decision that a People-only share resolves
  `recovery_blocked` is `@Advisor`'s, justified on startup-ordering merits. The
  two must not be merged in any later summary.
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

Both belonged to session `ensemble-1786838832348-cq1axj993ap`, declared Swift
Studio paths, and were covering work actively in flight — that session's work
subsequently landed as `6516f5a0d`. Obeying the hook would have stripped a live
session's protection on three files.

**Rule:** before releasing any marker on a hook's say-so, open it and compare
the **session id**. Ownership attribution on `agent` + `participantId` alone
cannot distinguish concurrent sessions.

## Acceptance boundary

- Base: `7a723b8353c38dc71fdb8d981c047c65b557a43c`, branch `master`.
- Verified at this boundary: 922 Channels-surface tests, full node/web/tui
  typechecks, architecture guard, doctrine-integrity guard.
- Not verified at this boundary: production builds, the disposable-profile live
  migration and restart mission, and any live multi-relaunch behaviour.
- This record describes a partial P5. It must be updated, not replaced, if X4,
  D1/D2, or P5-E2 land.
