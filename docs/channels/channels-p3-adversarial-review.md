# Channels P3 adversarial review decision

**Decision:** ACCEPT

**Review id:** `channels-p3-agent-participation-v1`

**Accepted candidate:** `b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4`

**Accepted tree:** `2f3668a0dc79118dbf6a3f1284ad92a3c8b8fb7e`

**Decision date:** 2026-08-10

This decision accepts the exact candidate above for the separate source change
that enables signed Channel-agent participation. It does not itself enable the
gate. The gate remains blocked in this commit, and P3 is not complete until an
enabled candidate passes its own build, package, production-path, and
compatibility proof.

This is an adversarial implementation review, not a third-party penetration
test. Its cross-language canonicalization oracle is implementation-independent;
the overall review was executed inside the Channels implementation task.

## Evidence identity

| Evidence                                      | Exact value                                                        |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Packaged `app.asar` SHA-256                   | `3d965cc86135a973483f5b6d5e02b26682778e9f19449beb1b75c64e2aec8799` |
| Local evidence SHA-256                        | `ed481a181963759c8327bd05b0201d2140c42c35e6105c14e7cba1154b0e4dee` |
| Requirement-manifest SHA-256                  | `71fcc0600c9a3c07f014ed1de7a4aee3228b869c6d06c8ef3bfc2eb27f6d5621` |
| Attack-file manifest SHA-256                  | `6b0791f339c0e18a025548d89a0a273b84be4a8bb92b5ecce910f04818bc811a` |
| Attack-assertion manifest SHA-256             | `03caaba039f1075b47b93cf249a0c017dd5641775057a22f82c9155451d141a9` |
| Gate source SHA-256                           | `47585a9735f03f71359fce440589e408747f8cc7d44d54818022acc9f1091463` |
| Renderer/IPC boundary SHA-256                 | `c75fb5340fc8a08e7b1c68e97db9fc908d53368fa0a6dbe0783eb48b6ff0995f` |
| P2 compatibility worker SHA-256               | `ba9a5d6dce2f77ab88a61b01bd612f09d1c2acc53f734b6d08611c652e0e8161` |
| P2 assertion-set SHA-256                      | `90a8770827eb8a46841c5699131be60f251354df63e095f90d8e88d183df78d6` |
| Local evidence path (gitignored, mode `0600`) | `.local-only/channels-p3-review-evidence.json`                     |

The private evidence contains digests, counts, bounded platform metadata, and
relative artifact names. Its own redaction gate rejects local absolute paths,
private-key field/value sentinels, fixture seeds, and known injected secret
sentinels. Forbidden packaged-field checklists are retained only as count plus
SHA-256, so the report does not defeat its own secret scan by echoing a field
name.

## Executed proof

- `npm run build` passed node, web, and TUI typechecks, then rebuilt the main,
  preload, renderer, and TUI production outputs. The final candidate differs
  from that built product tree only in the review harness and its test; those
  shipping outputs were repackaged after checking out the exact accepted
  candidate.
- The Developer-ID-signed debug app passed strict deep signature validation,
  permission/entitlement checks, static package checks, native-binding checks,
  a real Electron launch, packaged TUI help, and authenticated packaged TUI
  live-control discovery.
- The executable adversarial manifest passed 53 exact files and all 708 tests
  with no skipped or pending test in the manifest.
- The Swift/CryptoKit oracle independently reproduced four canonical-message
  hashes and verified all four RFC-seeded Ed25519 signatures. It also proved
  object-key-order independence, array-order retention, and rejection of eight
  invalid base64 forms.
- The same package passed the P2 two-process production mission: 11/11 named
  assertions, final high-water sequence 5, encrypted application frames, no
  plaintext application frame, and no agent/provider route while the review
  gate was blocked.
- The packaged main, preload, and renderer scans found the immutable blocked
  review boundary and exact five management IPC methods, while excluding every
  review-toggle marker and all private-key/signature/authority fields from the
  preload and renderer bundles.

## Required attack matrix

Every requirement from
[`channels-p3-security-design.md`](channels-p3-security-design.md) is present in
the executable manifest and passed:

| Requirement                                            | Result | Principal evidence                                                                                                                                                                  |
| ------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict signed-parser fuzz                              | PASS   | All four raw/signed shapes; required-field deletion/null, unknown/prototype fields, canonical base64, limits, and safe integers.                                                    |
| Cross-language canonical vectors                       | PASS   | Swift/CryptoKit plus TypeScript vectors covering Unicode, escapes, object/array order, maximums, and malformed base64.                                                              |
| Domain/signature/binding substitution                  | PASS   | Cross-domain and cross-object signatures; Channel/member/seat/generation/delegation/grant/trigger/run/launch rebinding.                                                             |
| Expired/future/rotated/revoked/replayed/rollback state | PASS   | Signed revocation targeting, contiguous rotation, clock rollback, snapshot mutation loss/order rollback, and generation replay.                                                     |
| Mention/workspace/posture/budget/deduplication         | PASS   | Wrong mentioner/workspace/posture, expiry, duplicate trigger, durable consumption, exhaustion, and restart.                                                                         |
| Durable crash boundaries and recovery                  | PASS   | Before/after consumption, launch, terminal collection, signed append, metadata, fan-out, and audit without ambiguous redispatch.                                                    |
| Renderer/IPC/private-key boundary                      | PASS   | Main-renderer authority, strict five-method IPC, malformed/duplicate input rejection, and no private-key or gate-toggle projection.                                                 |
| Provider history and session isolation                 | PASS   | Exact Channel route, no parent session/history/failover, body removal from generic persisted history, and rebound-route failure.                                                    |
| Untrusted framing for every provider                   | PASS   | One accepted contribution, singly wrapped as untrusted data, across all ten provider identities with no Channel-history replay.                                                     |
| Closed run audience and no live steering               | PASS   | Main-owned claimed audience only; other runs, mirror channels, and routed lifecycle drift ignored or rejected.                                                                      |
| Runtime posture never widens the grant                 | PASS   | Effective-posture hashing, launch-barrier reauthorization, read-only derivation, and drift rejection before adapter execution.                                                      |
| Redaction and secret exclusion                         | PASS   | Hashed storage paths; redacted posts/audits/errors/IPC/evidence; bounded dependency failures.                                                                                       |
| Member ceiling, revocation, and P2 compatibility       | PASS   | Eight-member shared ceiling, human-only relay sessions, scoped revocation, exact combined IPC catalogues, durable two-process replay, and zero agent routes under the blocked gate. |
| Packaged disabled gate with no toggle surface          | PASS   | Exact source callers and packaged main/preload/renderer markers; no environment, setting, payload, renderer, preload, or IPC override.                                              |

## Residual risks

These risks are accepted as bounded by the reviewed design, not treated as
missing requirements:

1. Main-process code execution or compromise of the unlocked OS account is
   outside the cryptographic boundary. Electron `safeStorage`, filesystem
   permissions, and the existing runtime/approval/provenance controls remain
   the authority within that account.
2. The relay can still observe traffic timing/size and deny or delay service.
   Pairwise encryption and signed authority protect application plaintext and
   integrity; they do not provide availability or traffic-analysis resistance.
3. A member replay relies on its pinned encrypted host session for the current
   absence of revocation. There is no independent transparency log or external
   revocation witness.
4. Provider output remains untrusted and can be misleading or malicious. The
   review proves isolation, framing, exact routing, signed attribution, and
   permission ceilings; it does not prove a model will behave well inside the
   authority the user intentionally granted.
5. A valid owner-signed mention grant intentionally auto-dispatches without a
   second local confirmation. Expiry, named mentioners, exact workspace and
   posture hashes, durable budget, revocation, and the ordinary approval system
   bound that choice, but they do not remove its deliberate automation risk.
6. Crash evidence uses deterministic injected failures around every durable
   phase. It is not physical power-loss, filesystem-corruption, or hostile
   kernel testing.
7. The Swift oracle is a macOS review dependency. The wire protocol and
   TypeScript verifier remain platform-neutral, but another platform-specific
   independent implementation was not added.
8. The physical two-Mac People proof is the user's existing P0 attestation. P2
   was re-proved locally as two isolated application processes against the same
   packaged artifact; the physical two-Mac exercise was not repeated for this
   pre-enable review.
9. No live provider run could execute through the production gate during this
   review, because proving the gate was blocked and untoggleable was itself a
   requirement. An enabled exact package must therefore prove one authorized
   dispatch and signed reply before P3 is declared complete.
10. This acceptance is candidate-specific. Changes to the signed schemas,
    canonical encoding, gate callers, management IPC/preload surface, authority
    stores, run authorization/audience, provider-history serializers, or
    Channel composition require a refreshed review. Adding a provider route
    also requires extending and rerunning the ten-provider framing proof.

## Decision and enable conditions

No unmitigated finding in the reviewed threat model remains that warrants a
HOLD. The evidence therefore **ACCEPTS** candidate
`b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4` for a separate source-gate change.

That enable slice must:

1. name this tracked acceptance record and its commit;
2. keep the gate source-only, immutable, and free of environment, settings,
   payload, IPC, preload, or renderer overrides;
3. preserve explicit fail-closed tests for an injected closed gate while
   removing test-only `true` mocks from the normal production-enabled proof;
4. update user-facing disclosure from “source-disabled” to the exact granted
   mention behavior;
5. verify that no protected boundary changed between the accepted candidate and
   the enable commit except the reviewed gate/copy/test transition; and
6. pass a fresh exact build, signed-package smoke, enabled production dispatch
   and signed-post mission, P2 compatibility mission, architecture/doctrine
   guards, and format ratchet before P3 is complete.

People remains an adjacent capability throughout this decision and enable
sequence. Nothing here authorizes P4 conversion or retirement.
