# Channels P3 — signed-agent security design and review package

**Status:** REVIEW ACCEPTED for candidate
`b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4`. The explicit decision and residual
risks are recorded in
[`channels-p3-adversarial-review.md`](channels-p3-adversarial-review.md).
Production agent participation is **ENABLED** and has been since 2026-08-10.
The enable slice `191e5e37d` landed ten minutes after the acceptance commit
`92ad1e982`, and `e0d7d1be4` retained the review provenance in the package.
[`ChannelAgentReviewGate.ts`](../src/shared/collaboration/ChannelAgentReviewGate.ts)
now reads `status: 'accepted'` with `participationEnabled: true`, and its
`acceptanceRecord` names this review record. The capability shipped in 1.9.5.
The enable slice's own proof lives in `scripts/channels-p3-enabled-proof.cjs`;
there is no prose record of it beyond this note.

**Implementation order:** identity and signed authority first; participation
second. The complete production path may be built behind the gate, but the gate
must remain blocked until an adversarial review is accepted explicitly.

## Decisions

The user fixed these choices on 2026-08-10:

1. **Stable seat identity.** One key follows a durable pooled Agent or persisted
   per-chat seat across runs, provider sessions, and model changes. A transient
   run id or child-agent thread is never an agent identity. Key rotation creates
   a new generation and requires new delegation and dispatch grants.
2. **Granted mentions auto-dispatch.** After review enables participation, a
   durable message that mentions an agent may start that agent without another
   local confirmation only while an exact owner-signed Channel/agent grant is
   active. The grant names the eligible human mentioners, workspace principal,
   run-permission posture, expiry, and dispatch budget.
3. **Full code before review, hard-disabled.** Production identity,
   participation, grant, IPC, and UI paths may be completed before review, but
   there is no environment, settings, IPC, renderer, or payload override for
   the review gate. Enabling requires a reviewed source change naming the
   accepted review record.

The existing Channel owner's pinned Ed25519 identity is the trust root. It
signs delegations, dispatch grants, and revocations with new domain strings; no
second self-asserted owner key is accepted. Each agent private key is generated
and held by main. Providers receive neither owner nor agent private key bytes.

## Principal model

An agent principal is a TaskWraith-managed seat, not a provider process:

| Source                         | Stable `agentSeatId`                         | Lifecycle                                                                            |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Pooled Agent                   | Existing `pooled-agent-*` id                 | Survives chats, runs, provider sessions, and model changes.                          |
| Persisted non-pooled chat seat | Main-minted id persisted with that chat seat | Survives runs and native-session replacement; does not become a cross-chat identity. |
| Child/subagent thread          | None by default                              | Must be promoted into a persisted seat before it can receive a key or delegation.    |
| Run/provider session           | Never an identity                            | Appears only as signed post provenance.                                              |

Display name, icon, provider, model, role, and provider session id are mutable
descriptors. None identifies the cryptographic principal. A seat key has a
monotonic `keyGeneration`; reuse of an earlier generation after rotation fails
closed.

The eight-member Channel ceiling includes both human and active agent members.
The owner remains a human Channel member.

## Threat model

### Protected outcomes

- A durable agent post says which stable seat authored it, under which Channel
  owner delegation, from which authoritative run, without relying on renderer
  or provider claims.
- A remote human can trigger only the exact agent, Channel, workspace, and
  permission posture the owner granted, within the signed time and dispatch
  budget.
- Revoking a grant, delegation, member, or key stops future dispatch and posts
  while historical signatures remain verifiable.
- A Channel remains an inbound content surface. It does not become a generic
  message gateway, provider-history feed, live-steering path, or authority
  source.

### Adversaries

- a malicious or compromised relay that can replay, reorder, delay, duplicate,
  or mutate frames but cannot break the existing pairwise Channel encryption;
- an active or later-revoked human Channel member crafting mentions and text;
- a renderer process that fabricates membership, grants, signatures, posture,
  or review state;
- provider output that contains prompt injection, forged attribution, fake tool
  instructions, or another agent's name;
- stale or rolled-back local authority files;
- a copied agent post replayed into another Channel, seat, key generation,
  delegation, grant, trigger message, run, workspace, or posture; and
- a local attacker who can edit user-data files but cannot execute arbitrary
  main-process code or extract an unlocked OS credential store.

Compromise of main-process execution or the unlocked OS account is outside the
cryptographic boundary. Existing runtime containment, approvals, provenance,
and audit remain authoritative inside that boundary.

## Signed protocol

[`ChannelAgentProtocol.ts`](../src/shared/collaboration/ChannelAgentProtocol.ts)
defines four strict version-1 objects. Every parser rejects unknown keys,
non-canonical base64, controls or surrounding whitespace in identifiers,
unsorted set-like arrays, unsafe numbers, invalid hashes, and malformed time
windows.

### Owner delegation

Domain: `taskwraith.channel.agent-delegation.v1`

The owner signature binds:

- delegation, Channel, owner-member, and agent-member ids;
- stable agent-seat id, raw Ed25519 public key, and key generation;
- sorted `channel.post` / `channel.dispatch` scopes;
- issue, not-before, and expiry times; and
- maximum signed-post bytes.

The verifier receives the owner's public key from the existing pinned Channel
owner record. An owner key supplied inside the signed object or renderer input
is never authoritative.

### Mention dispatch grant

Domain: `taskwraith.channel.agent-dispatch-grant.v1`

The owner signature repeats the complete agent/delegation binding and adds:

- `trigger: mention`;
- a sorted, explicit list of active human member ids allowed to trigger it;
- SHA-256 of the main-resolved workspace principal, never a local path;
- SHA-256 of the exact main-authored effective permission posture;
- issue, not-before, and expiry times; and
- a positive bounded dispatch count.

There is no wildcard mentioner and no ambient workspace or permission fallback.
Changing the workspace or posture invalidates the grant rather than silently
adapting it. Runtime posture may clamp the signed authority further; it may
never widen it.

### Agent post

Domain: `taskwraith.channel.agent-post.v1`

The agent-seat signature binds:

- Channel/member/seat/key-generation/delegation identity;
- dispatch-grant and triggering durable-message ids;
- TaskWraith run id and a digest of its launch seal plus effective posture;
- client message id, `agent.text` kind, exact content, and content hash; and
- creation time inside the active delegation window.

Main constructs and signs the object only after an authoritative run settles.
The provider cannot request arbitrary signature bytes and never receives the
private key. The Channel host recomputes the content hash, verifies the owner
delegation and agent signature, checks current revocation state, and derives
the log author from the verified member binding rather than the payload alone.

### Owner revocation

Domain: `taskwraith.channel.agent-revocation.v1`

A signed revocation targets one agent-key generation, delegation, or dispatch
grant and carries a bounded reason. Rotation revokes the old generation and
requires a new delegation/grant chain. A historical post made while authority
was active remains historically valid; revocation blocks future append and
dispatch rather than rewriting the append-only log.

## Canonical encoding and vectors

A signature covers:

```text
<domain>\n<UTF-8 canonical JSON>
```

Object keys are recursively sorted. Arrays retain their order, and parsers
require arrays that represent sets to be sorted and unique. Numbers must be
finite safe integers where the schema requires integers. Signatures use
Ed25519; wire keys are canonical base64 raw 32-byte public keys and signatures
are canonical base64 64-byte values.

The deterministic test fixture uses RFC 8032 seed/public-key pairs. These
values are pinned for a second implementation and review tooling:

| Vector                         | Value                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Delegation canonical SHA-256   | `c2665be7fae2e47f389ff761fb8a5243c7b86c45cfbc7979b49c14a2c120fc90`                         |
| Agent raw-key SHA-256          | `39f713d0a644253f04529421b9f51b9b08979d08295959c4f3990ee617f5139f`                         |
| Owner delegation signature     | `XVUDyNKvvjJPXDfAd69gyLsTqHNvJfccb9SZepCK8zyXeIvFWOFpv5kIKJG4fOV8DyE+V1f/IeOw37ooAWhdDQ==` |
| Owner dispatch-grant signature | `uifB5F1MD4qYEQKAFEgZsOzDiXIx+1//Fp79tVTStL/yZbrX4AOF7xo/xnuDPBHwSsYaUcBOh0ZMdgRZIvfWAA==` |
| Agent post signature           | `EZtrTtei4jPelc5U0JrPEnXd1vIbcioFameSFVRLtukEkspgKSPAsfQaP0u2zM1V182s8EFyTU8qISn+xM9aDg==` |
| Owner revocation signature     | `huQl26jdqGz7OIjKbYzMkCT9nceG3kXdKYd69szfKBjcLrgPY39DFH9z+lm69eHWzcIDMp4z8NYXQVPy+IwfCQ==` |

## Auto-dispatch path after review

The only permitted order is:

1. A human message is authenticated by its existing encrypted Channel session,
   accepted durably, and assigned an immutable message id and author member id.
2. Main parses mentions from that accepted record. Raw relay frames, renderer
   drafts, notifications, and provider text cannot trigger dispatch.
3. Main proves the author is an active human member and deduplicates the trigger
   by `(grantId, triggerMessageId)`.
4. The source-only adversarial-review gate is checked. It currently stops here.
5. Main verifies the owner delegation, dispatch-grant signature, revocations,
   time window, remaining crash-safe dispatch budget, allowed mentioner,
   stable-seat/key generation, workspace identity hash, and effective posture
   hash.
6. Main resolves the persisted seat. Mutable provider/model/session descriptors
   cannot substitute another principal.
7. The accepted message enters prompt composition only inside the standard
   untrusted-context wrapper. Channel logs remain excluded from provider history
   serializers. Dispatch uses the regular run/approval/provenance path—not
   direct provider invocation and not live steering.
8. The effective runtime permission posture is recomputed at launch and may
   clamp the grant. A mismatch invalidates the grant; no field is silently
   upgraded.
9. After a terminal run, main binds the run authority digest and trigger into an
   `agent.text` post, signs it with the seat key, verifies the complete chain at
   append, commits it durably, fans it out, and audits the dispatch and post.

The user chose auto-run for a valid grant, so there is no additional local
confirmation at step 5 after review. Removing any check above would widen that
explicit choice and requires a separate user decision.

## Key custody and durable state

The next identity slice must:

- keep private keys in a dedicated main-owned store encrypted through Electron
  `safeStorage`, with mode-`0600` atomic files and no renderer/preload/private
  key projection;
- index keys by stable seat id and monotonic generation, never provider session
  id, display name, or model;
- preserve old public keys and signed authority for historical verification
  while erasing rotated/revoked private material;
- persist delegations, grants, revocations, dispatch consumption, and trigger
  deduplication atomically enough that a crash cannot restore spent authority;
- quarantine damage and block affected agent authority rather than silently
  regenerating a key that existing delegations name; and
- include explicit erasure in Channel/global collaboration purge paths.

## Review attacks and required evidence

The review package is incomplete until it demonstrates all of these:

- parser fuzzing and unknown-field rejection for every signed object;
- cross-language canonical vectors, including Unicode, escapes, object order,
  array order, maximum values, and invalid base64;
- domain swapping and signature substitution;
- Channel/member/seat/key-generation/delegation/grant/trigger/run rebinding;
- expired, future, rotated, revoked, replayed, and rolled-back authority;
- wrong mentioner, workspace, posture, dispatch count, and duplicate trigger;
- durable crash points before and after grant consumption, run launch, signed
  append, metadata update, audit, and fan-out;
- renderer and IPC attempts to enable the review gate or submit private keys;
- every provider-history serializer excluding Channel records;
- untrusted-context framing for every provider dispatch route;
- no remote-author live-steering delivery;
- runtime posture never exceeding the signed grant;
- redaction and secret scans across posts, audits, errors, IPC, and evidence;
- eight-member ceiling and scoped revocation with human-only P2 behavior
  unchanged while the gate is blocked; and
- packaged proof that the disabled gate is present and cannot be toggled by
  settings, environment, preload, renderer, or Channel payload.

Review must name residual risks and a specific accepted commit. A green ordinary
test suite is necessary but not the adversarial-review decision.

## Vertical slices

1. **P3-A — protocol/review gate:** this document, canonical signed objects,
   strict parsers, deterministic vectors, hostile binding tests, and the
   immutable disabled gate.
2. **P3-B — identity authority:** safeStorage-backed stable-seat key store,
   owner signing, rotation, authority state, crash-safe budget/deduplication,
   purge, and no-participation composition.
3. **P3-C — signed membership/log:** schema migration, agent members,
   `agent.text`, signed append verification, replay/projection/audit, and
   historical verification while the gate remains blocked.
4. **P3-D — gated participation:** dispatch grants, mention resolver, regular
   run integration, IPC/preload/renderer controls, provider-history exclusion,
   and packaged disabled-gate proof.
5. **P3-E — adversarial review:** independent attack evidence and explicit
   accept/hold decision. Only an accepted review may change the source gate.

P4 People migration does not begin inside these files. People stays adjacent
and available until the separately rehearsed migration/compatibility phase.
