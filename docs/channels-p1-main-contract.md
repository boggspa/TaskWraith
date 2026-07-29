# Channels P1 — bounded main-side contract and proof plan

**Status:** design contract only, written for the 1.9.2 exit. No Channels code,
schema, renderer surface, or agent path is implemented by this document.

**Gate:** P1 remains blocked until the existing People flow passes the
[two-Mac test](human-collaboration-two-mac-test.md) between two real Macs on
unrelated networks. The same-Mac instance/port preflight is not P0. A unit test,
fake relay, or this design cannot substitute for the human E2EE, SAS, public
relay traversal, reconnect, and revoke exercise.

This document freezes the smallest P1 contract that can be implemented after
P0. It is derived from the canonical private 1.9.x roadmap and the current
People transport/store implementation. It satisfies the 1.9.2 requirement for
a bounded main-side contract and a multi-instance test plan; it does not claim
the 1.9.3 three-member proof has run.

## 1. Scope and phase boundary

P1 is a headless, main-process substrate for human Channels:

- main-owned `Channel`, `Member`, and `ChannelMessage` state;
- a host-authoritative, durable append log with one monotonically increasing
  sequence per channel;
- one existing two-seat relay room per non-host member, with the host fanning a
  committed record out across those rooms;
- cursor-based replay and resume after a client or host restart; and
- an automated three-member, three-instance proof using
  `TASKWRAITH_INSTANCE_ID`.

The member ceiling is eight, including the human host. The topology therefore
has at most seven live member rooms for one channel.

P1 explicitly does **not** include:

- Chat UI, renderer IPC, a composer, presence UI, or admission UI;
- agents, agent identities, agent-authored messages, `@mention` dispatch,
  provider context, or provider runs;
- a tool, MCP route, workflow action, scheduled action, or remote command that
  can read or mutate a channel;
- People migration or retirement;
- group crypto, relay changes, a windowless Host split, or an alternate server;
  or
- a second store implementation in the renderer.

The only P1 entry points are an in-process main-side service API and a
test-only process harness. Production user-facing entry points belong to P2.
Agent membership and dispatch belong to P3 only after its separate identity
design and adversarial review. People conversion belongs to P4.

## 2. Donor organs and replacements

P1 reuses reviewed mechanics without pretending People already has the Channel
data model.

| Current People component | P1 treatment |
| --- | --- |
| [`HumanCollaborationCipher`](../src/shared/collaboration/HumanCollaborationCipher.ts) and [`HumanCollaborationKeySchedule`](../src/shared/collaboration/HumanCollaborationKeySchedule.ts) | Reuse pairwise E2EE, fresh ephemeral keys, transcript signatures, and SAS derivation unchanged. There is one independent encrypted session per member room. |
| [`HumanCollaborationIdentityStore`](../src/main/collaboration/HumanCollaborationIdentityStore.ts) | Reuse the persisted human identity key and pinned-key reconnect rule. A member id never substitutes for proof of the pinned key. |
| [`HumanContributionRules`](../src/main/collaboration/HumanContributionRules.ts) | Reuse fail-closed normalization and the existing 8,000-byte contribution bound as design inputs. P1 admits only the human text append capability; host-action requests and provider dispatch are absent. |
| [`HumanCollaborationAuditLog`](../src/main/collaboration/HumanCollaborationAuditLog.ts) | Reuse bounded, redacted audit conventions for admission, rejection, revocation, recovery, and protocol errors. The audit log is not the Channel message log. |
| [`secretRedaction`](../src/shared/secretRedaction.ts) and the path scrubber in [`HumanShareProjection`](../src/main/collaboration/HumanShareProjection.ts) | Reuse before content becomes a committed outbound Channel record. Raw secrets and host paths are neither persisted in the Channel log nor fanned out. |
| [`HumanCollaborationHostTransport`](../src/main/collaboration/HumanCollaborationHostTransport.ts) | Keep one host `mac` seat paired with one remote `iphone` seat per room, reconnect backoff, and bounded frames. Replace the single-share projection routing with channel/member routing and N-room fan-out. |
| [`HumanCollaborationStore`](../src/main/collaboration/HumanCollaborationStore.ts) | Do not extend the share snapshot into Channels. Replace it with Channel and Member metadata plus a separate append-log owner. |
| `HumanShareProjection` | Do not reuse. A trimmed view of a host chat is the wrong primitive for mutually visible Channel history. |
| [`relay/src/server.ts`](../relay/src/server.ts) | No change. It remains a blind two-seat forwarder with single occupancy per role and a 1 MiB frame ceiling. |

The existing People flow remains operational and unchanged until P4. P1 code
must live beside it, not dual-write People shares into an unfinished Channel
store.

## 3. Conceptual records

These records specify ownership and invariants, not an executable schema for
this release.

### 3.1 Channel

| Field | Contract |
| --- | --- |
| `channelId` | Opaque stable id generated by main. |
| `chatId` | Stable owning General-chat id. Exactly one Channel per General chat in the future model; P1 must not mutate current chat records. |
| `createdAt`, `updatedAt` | Host timestamps. |
| `status` | `active` or `closed`; unknown values fail closed as closed. |
| `nextSequence` | Next host sequence, starting at 1. Recovered from the durable log, never trusted only from mutable metadata. |
| `membershipRevision` | Monotonic main-owned revision for membership snapshots. |
| `ownerMemberId` | The local human host member. |

### 3.2 Member

| Field | Contract |
| --- | --- |
| `memberId` | Opaque stable id generated by main. |
| `channelId` | Owning Channel. |
| `kind` | Literal `human`. No other value is valid in P1. |
| `displayName` | Host-normalized, bounded display name; never an authority identifier. |
| `identityPublicKey` | Pinned Ed25519 public identity established by SAS admission. |
| `status` | `pending`, `active`, or `revoked`; unknown values fail closed as revoked. |
| `roomId` | Unique two-seat relay room for a non-host member. It is routing data, not identity or authorization. |
| `joinedAt`, `revokedAt` | Host timestamps. |

The host is a human member but has no relay room. The active-member limit is
checked transactionally before admission. Reconnecting the same pinned identity
does not allocate another member or consume another seat. A revoked key cannot
rejoin through a fresh invite in P1.

### 3.3 ChannelMessage

| Field | Contract |
| --- | --- |
| `channelId` | Owning Channel. |
| `sequence` | Host-assigned positive integer, unique and strictly increasing within the Channel. |
| `messageId` | Opaque stable id generated by main. |
| `authorMemberId` | Derived from the authenticated session; never accepted from the inbound body. |
| `clientMessageId` | Bounded sender-generated id used with `authorMemberId` for idempotency. |
| `kind` | Literal `human.text` in P1. Unknown or agent-shaped kinds are rejected. |
| `content` | UTF-8 human text, non-empty after validation, secret/path-redacted before persistence, at most 8,000 bytes after redaction. |
| `acceptedAt` | Host timestamp stamped when the record is sequenced. |
| `contentHash` | Hash used for idempotency-conflict and evidence checks; it is not an authentication signature. |

No provider name, model, run id, tool call, prompt intent, action request, or
dispatch field exists in a P1 message.

## 4. Main-owned service boundary

The future implementation has one main-side authority with four narrow roles.
They may be separate classes, but callers must observe one contract.

### 4.1 Metadata owner

The metadata owner creates/closes Channels, admits/revokes human members, pins
identities, enforces the eight-member ceiling, and persists membership
revisions. It alone maps a live encrypted session to a member and room.

Every inbound operation revalidates all of the following immediately before it
can reach the sequencer:

1. the Channel is active;
2. the session is established over pairwise E2EE;
3. the session's identity key equals the active member's pinned key;
4. the session is bound to that member's room;
5. the member is active; and
6. the operation is one of the P1 human-only methods.

Revocation first persists the member state, then makes the session unusable,
then closes only that member's room. It does not close the Channel or another
member's room.

### 4.2 Sequencer

There is exactly one serialized append queue per Channel inside the main
authority. For each request it:

1. performs the authorization checks above;
2. validates bounds, normalizes text, and applies secret/path redaction;
3. resolves idempotency against that canonical committed form;
4. assigns `nextSequence`;
5. appends the complete record durably;
6. advances durable sequence/idempotency state in the same commit;
7. acknowledges the accepted record; and
8. asks the transport to fan out that exact committed record.

Arrival at a relay socket is not acceptance. Fan-out is not acceptance.
Durability is acceptance. The host must never acknowledge a sequence that
recovery can later forget.

Concurrent arrivals are ordered only by the sequencer's serialized admission.
Wall-clock time and a client-supplied timestamp never reorder records. An
accepted sequence is never reused. Rejected requests consume no sequence.

The idempotency key is `(channelId, authorMemberId, clientMessageId)`.

- Repeating it with the same canonical content returns the original committed
  record and does not fan out a second logical message.
- Repeating it with different content fails with an explicit idempotency
  conflict.
- Idempotency evidence must survive restart for at least as long as the
  corresponding message remains in the log. It cannot use the current People's
  bounded in-memory-style map if eviction would permit a duplicate append.

The principal is supplied out of band by main: either the local
`ownerMemberId` on a host-only in-process call or the member resolved from an
authenticated remote session. The append body never chooses its author.

### 4.3 Durable log owner

Each Channel has one append-ordered durable log owned by main. A commit record
contains enough data to reconstruct `ChannelMessage`, the next sequence, and
idempotency after a crash. Mutable Channel metadata is not the sequencing
source of truth.

The implementation must obey these persistence outcomes:

| Failure point | Required recovery result |
| --- | --- |
| Before the durable append starts | No record and no consumed sequence. |
| Partial/torn final record | Discard or truncate only the provably incomplete tail; never invent an acknowledgement. |
| Durable record complete, process dies before reply/fan-out | Record exists after restart; retry returns it through idempotency; replay delivers it. |
| Reply sent, process dies before some fan-out sends | Record exists; lagging members receive it through resume. |
| Corruption before the final tail | Mark the Channel recovery-blocked and surface a typed error. Do not silently reset history or continue at a guessed sequence. |
| Metadata lags a valid log | Rebuild metadata-derived sequence/idempotency from the log. |

The writer must use a single ordered write path and sync accepted bytes before
acknowledgement. Startup validates version, channel id, sequence continuity,
record length/checksum, message bounds, and known `kind`. Unknown record
versions or message kinds fail closed.

P1 does not silently trim committed history. The implementation must declare a
storage ceiling and fail new appends explicitly with `quota_exceeded` before
disk exhaustion; compaction/retention is a later separately tested migration.
Replay is bounded even when retained history is large.

### 4.4 Transport owner

For `N` members, the host opens `N - 1` existing two-seat relay rooms. Each room
has its own pairwise session keys and frame sequence. The relay never sees
Channel plaintext and never sequences or broadcasts.

After a durable commit, the host sends the same logical `ChannelMessage` to
every active non-host member, including the author. Echoing the committed
record lets the author replace optimistic local state with the authoritative
sequence. A failed or disconnected room does not roll back the commit and does
not block another room.

Transport-frame sequence protects each encrypted connection from replay;
Channel sequence orders durable history across all rooms. These counters are
different and must never be substituted for one another.

The host being offline makes the Channel unavailable. No relay-side queue,
peer-to-peer fallback, alternate sequencer, or group key is introduced in P1.

## 5. Bounded wire behavior

P1 needs a versioned, closed method set inside the pairwise encrypted envelope.
Names are illustrative until implementation, but the semantics are fixed:

| Method/event | Direction | Semantics |
| --- | --- | --- |
| `channel.admission.begin` / `confirm` | member → host | Existing signed transcript and human SAS admission, scoped to one Channel invite. |
| `channel.reconnect` | member → host | Fresh session keys, same pinned member and host identities, no new seat. |
| `channel.members.snapshot` | host → member | Bounded human-member attribution at one `membershipRevision`; sent at admission/resume and after a revision change. |
| `channel.log.append` | member → host | Request id, human text, and `clientMessageId`; no author, agent, dispatch, or action field. |
| `channel.log.appendResult` | host → member | Correlated accepted/deduplicated record or typed rejection. A committed echo in a batch still converges the sender's applied view. |
| `channel.log.resume` | member → host | Request records strictly after `resumeAfter`. |
| `channel.log.batch` | host → member | Ordered committed records and a high-water cursor. |
| `channel.member.revoked` | host → member | Terminal notice for that member when delivery is possible. |

The parser rejects unknown methods, unknown record kinds, non-human actors,
overlong ids, oversized content, invalid cursors, and unexpected fields that
attempt to name an author or dispatch target. Rejection is typed and audited;
it never degrades into a provider prompt or an empty success.

Resource limits for the first implementation:

- 8 active members including the host;
- 8,000 UTF-8 bytes per human text message;
- 200 characters per `clientMessageId`;
- a replay batch no larger than 256 records and no larger than 512 KiB after
  serialization; and
- an encrypted transport frame below the relay's 1 MiB ceiling.

If one record cannot fit a replay batch under those limits, the Channel is
recovery-blocked rather than sending an oversized frame. Batches contain only
whole records.

## 6. Replay and resume

The member persists the last contiguous Channel sequence it has applied. On a
fresh admission it resumes after `0`. On reconnect it sends `resumeAfter` only
after the pinned-identity handshake has established fresh pairwise keys.

The host:

1. validates that the cursor is an integer from `0` through the current
   high-water sequence;
2. snapshots the current membership revision for the session;
3. reads records strictly after the cursor;
4. emits bounded batches in ascending sequence with no gaps or duplicates; and
5. transitions the session to live delivery only at a defined high-water mark,
   buffering or subsequently replaying commits that race with catch-up.

The catch-up/live boundary must be atomic from the member's perspective. A
record committed while replay runs appears exactly once: in the final replay
window or in live delivery. The member deduplicates by `(channelId, sequence)`
as defense in depth and rejects a different record for an already-applied
sequence.

A cursor ahead of the host, a gap in durable history, or a conflicting record
at the same sequence returns an explicit resync/recovery error. P1 has no
silent full-reset path. Restarting the host rebuilds the high-water mark before
it accepts rooms or appends.

## 7. Human-only security invariant

P1 is an inbound content path, never an inbound command path.

The invariant is structural:

- `Member.kind` and `ChannelMessage.kind` are closed literal sets containing
  only human values.
- The P1 package has no dependency on provider runners, composer/run services,
  agent tool dispatch, schedules, workflows, or MCP catalogues.
- Channel logs are not Chat transcripts and are excluded from every provider
  history serializer.
- No Channel event can enqueue, start, steer, or resume a provider run.
- No renderer or agent tool can call the P1 test harness.
- `providerDispatch: 'never'` and rejection of `directLimited` remain the
  People donor rule; neither field is accepted on a P1 append.
- Display names and inbound author fields never establish identity.
- Every outbound plaintext record is intentionally limited to Channel content
  and bounded member attribution before pairwise encryption. Host paths,
  secrets, run ids, and provider metadata are not part of the record.

Tests must fail if an agent-shaped member/message, dispatch field, provider
serializer inclusion, or tool route is added. P3 cannot widen these types in
place: it requires a new protocol version and its separately reviewed signed
agent identity/delegation contract.

## 8. Error contract

Main returns stable machine codes with bounded human text:

| Code | Meaning |
| --- | --- |
| `protocol_unsupported` | Unknown protocol version, method, or record kind. |
| `human_only` | An actor/message/field attempts agent or dispatch semantics. |
| `not_member` | Session does not map to a Channel member. |
| `identity_mismatch` | Session identity differs from the pinned identity. |
| `revoked` | Member or Channel is revoked/closed. |
| `quota_exceeded` | Member, message, rate, replay, or storage bound reached. |
| `idempotency_conflict` | Same sender/client id names different canonical content. |
| `invalid_cursor` | Cursor is malformed or ahead of the host. |
| `resync_required` | Replay cannot continue from the requested cursor. |
| `recovery_blocked` | Durable state is corrupt or cannot be proven safe. |
| `host_unavailable` | The host/sequencer is offline or restarting. |

Errors never include raw keys, invite tokens, message content, local paths, or
unbounded peer-controlled text.

## 9. Three-instance proof plan

P0 is a separate human prerequisite. Once its evidence is recorded, P1 is
proven in three layers.

### 9.1 Deterministic unit and in-process integration tests

Before launching apps, automated tests cover:

1. metadata round-trip, eight-member admission, ninth-member rejection,
   identity pinning, reconnect, and per-member revocation;
2. concurrent append serialization with gapless increasing sequence;
3. retry-before-ack, retry-after-ack, and different-content idempotency cases;
4. every durability failure row in §4.3 through fault injection;
5. restart recovery of high-water sequence and idempotency;
6. two fake member rooms receiving the same committed record;
7. one failed room not blocking commit or the healthy room;
8. bounded multi-batch replay and the replay/live race;
9. invalid cursor, interior corruption, torn tail, and unknown-version failure;
10. oversized content/ids/frames and explicit quota errors;
11. closed-protocol rejection of agent actors, agent messages, dispatch fields,
    and provider-facing routes; and
12. no Channel record entering any provider history serializer.

The existing in-memory relay pattern in
[`HumanCollaborationTransport.integration.test.ts`](../src/main/collaboration/HumanCollaborationTransport.integration.test.ts)
is the donor harness, extended to two independent member rooms. It is not P0
evidence.

### 9.2 Process-level topology

Run three unpackaged app instances so each receives an isolated app name,
userData directory, identity store, single-instance lock, and relay allocation:

```text
Host:     TASKWRAITH_INSTANCE_ID=1
Member B: TASKWRAITH_INSTANCE_ID=2 IOS_REMOTE_TRUE=0
Member C: TASKWRAITH_INSTANCE_ID=3 IOS_REMOTE_TRUE=0
```

The test harness may call only the main-side P1 service. It must not add a
temporary production UI or IPC surface. Instance 1 owns one Channel and two
different room ids; instances 2 and 3 each dial only their assigned room.

`TASKWRAITH_INSTANCE_ID` is an unpackaged-development isolation control, not a
production trust credential. The proof must verify distinct resolved userData
paths and identity public keys before admission.

### 9.3 Required mission

Use human labels `Host`, `Member B`, and `Member C`, but authenticate only by
their pinned keys and member ids.

1. Start all three instances and record instance id, resolved userData path,
   public identity fingerprint, process id, and process birth identity.
2. On the host, create a Channel with the host member and issue two independent
   single-use invites/rooms.
3. Admit B and C separately through the real pairwise handshake. The harness
   displays both SAS values; the test asserts each pair matches before
   confirming. One room/session must not be usable for the other invite.
4. Have all three members submit messages, including simultaneous B/C
   appends. Wait for the host's durable acknowledgements.
5. Assert every member observes byte-identical records in the same gapless
   Channel sequence and attributes each record to the session-bound member.
6. Disconnect B after persisting cursor `k`. Commit messages from Host and C.
   Restart B with the same instance id and identity, reconnect without a new
   seat, resume after `k`, and prove every missed record arrives exactly once.
7. Fault the host after a record is durable but before fan-out. Restart it with
   the same instance id; prove the record is replayed, a retry deduplicates, and
   the next accepted sequence is greater.
8. Build more than 1 MiB of valid retained history from bounded records.
   Reconnect C from `0`; prove replay uses multiple ordered batches, every
   serialized batch is within both bounds, and live commits at the catch-up
   boundary appear exactly once.
9. Revoke B. Prove B's subsequent append/reconnect fails, B's room closes, C
   remains connected, and Host/C can still append.
10. Shut down cleanly, restart the host once more, and compare the recovered
    log digest and high-water sequence with the evidence captured before exit.

### 9.4 Evidence and pass criteria

The harness writes a secret-free evidence bundle outside production stores:

- exact commit, platform, Node/Electron versions, and instance launch inputs;
- P0 evidence reference;
- instance isolation and public-key fingerprints;
- room topology using redacted room ids;
- every committed `(sequence, messageId, authorMemberId, contentHash)`;
- replay batch record/byte counts;
- injected crash point and recovery result;
- typed rejection codes;
- final log digest/high-water mark from all three applied views; and
- pass/fail for every mission step.

P1 proof passes only when:

- all three applied views are identical and gapless;
- an acknowledged record survives host restart;
- disconnected members catch up without duplicate logical messages;
- the two member rooms fail independently;
- revocation is scoped to one member;
- no frame exceeds its bound;
- no agent/provider path exists or is observed; and
- the run is repeatable from clean instance profiles.

A single in-process test, two clients sharing one identity/profile, a same-Mac
People projection test, or a manually edited log does not satisfy this proof.

## 10. Release accounting

For 1.9.2, this document can close only the roadmap's “bounded main-side
contract and multi-instance test plan” line.

The release evidence must continue to say:

- **P0: human-only and outstanding** until the two real unrelated-network Macs
  complete the tracked runbook;
- **P1 implementation: blocked by P0**, so no Channel store, wire protocol,
  fan-out, schema, UI, or agent route has landed; and
- **P1 proof: planned, not run** until the post-P0 three-instance mission
  produces the evidence in §9.4.

That accounting is intentional. It makes 1.9.2 releasable without claiming a
human gate passed or quietly beginning the architecture above it.
