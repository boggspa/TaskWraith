# Channels P1 proof record

**Result:** PASS — two clean-profile process missions on 2026-08-09.

**Boundary:** human-only, headless P1. This evidence does not claim a renderer
surface, production IPC/preload API, People migration, agent membership, or
provider dispatch.

## Evidence identity

| Item | Recorded value |
| --- | --- |
| P0 prerequisite | User attestation: the existing People flow passed between two real Macs on unrelated networks on 2026-08-09. |
| Durable-authority commit | `f2b88a2cfaf1968fa52735e054276a70552726ad` |
| Encrypted-runtime commit | `a188c8503b726c31967d78a610fa91620a849b37` |
| Process-harness/source commit | `896bd89143a485721ed9b185322545e4cfb32442` |
| Harness | [`scripts/channels-p1-proof.cjs`](../scripts/channels-p1-proof.cjs) |
| Worker | [`scripts/channels-p1-proof-worker.ts`](../scripts/channels-p1-proof-worker.ts) |
| Local evidence | `.local-only/channels-p1-proof-evidence.json`, deliberately gitignored and mode `0600` |

The evidence file records fingerprints and content hashes, never invite tokens,
raw room ids, public/private keys, SAS confirmation codes, or message content.
Temporary instance profiles and the bundled worker are deleted after the run.

## What actually ran

The coordinator bundled the proof worker and spawned four independent OS
processes:

- the real blind relay from `relay/src/server.ts`;
- Host with `TASKWRAITH_INSTANCE_ID=1`;
- Member B with `TASKWRAITH_INSTANCE_ID=2` and `IOS_REMOTE_TRUE=0`; and
- Member C with `TASKWRAITH_INSTANCE_ID=3` and `IOS_REMOTE_TRUE=0`.

Host, B, and C each used a distinct temporary user-data profile and persisted
Ed25519 identity. The harness checked distinct profile paths, identity
fingerprints, process ids, and process birth identities before admission.

It then exercised two independent single-use rooms, cross-room invite misuse,
matching host/member SAS confirmation, concurrent three-member appends,
offline cursor recovery, a host crash after durable append but before reply or
fan-out, idempotent retry, more than 1 MiB of retained history, bounded replay,
scoped revocation, and a final host restart.

## Repeatability results

Run with:

```sh
node scripts/channels-p1-proof.cjs --runs 2
```

| Measurement | Run 1 | Run 2 |
| --- | ---: | ---: |
| Duration | 3,581 ms | 3,460 ms |
| Final durable high-water | 149 | 149 |
| Large replay batches | 3 | 3 |
| Largest replay batch | 70 records / 521,827 bytes | 70 records / 521,827 bytes |
| Largest observed wire frame | 696,117 bytes | 696,117 bytes |
| Encrypted frames observed | 613 | 613 |
| Plaintext application frames | 0 | 0 |
| Final log digest | `0f5dbbe632fa6f62cfd8b9456e74b964e91c3d80b540de840e586c18cb3fc8ed` | `7b4c5d41702816565150f69c724baee5302498638be450e6ad3cb4aef6d21aa0` |

The two final digests intentionally differ because each clean run generates new
opaque ids and acceptance timestamps. Within each run, every surviving applied
view and every post-restart host view matched byte-for-byte at the same
high-water mark.

Both runs proved all of these assertions:

- isolated profiles and identities;
- two independent single-use relay rooms;
- SAS equality before confirmation;
- encryption of every application request crossing the relay;
- one gapless global order for simultaneous Host/B/C appends;
- exactly-once offline replay;
- recovery after the injected durable-before-fan-out crash;
- retry deduplication without a second logical fan-out;
- replay above 1 MiB using bounded batches and an atomic live boundary;
- revocation scoped to Member B while Host and C continued;
- stable durable history after the final host restart; and
- no agent or provider route in the exercised protocol.

## Deterministic verification

The focused P1 suite passed on the proof source:

```text
Test Files  7 passed (7)
Tests       35 passed (35)
```

The suite covers the store/log, audit, raw host transport, runtime, wire parser,
key schedule, and cipher. The proof worker also bundled successfully for Node
20 before either process mission ran.

## Phase boundary

P1 stops here. P2 is the first user-facing Channel experience under Chat and is
a separate, substantial surface phase: production main lifecycle/wiring,
strict IPC and preload contracts, renderer state/projection, admission and
membership UX, transcript/composer/reconnect behavior, and packaged UX proof.
People remains available beside it; migration or retirement is P4, not P2.
