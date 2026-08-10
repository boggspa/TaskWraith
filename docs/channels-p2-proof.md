# Channels P2 proof record

**Result:** PASS — packaged-surface validation and two clean-profile process
missions on 2026-08-10.

**Boundary:** human-only P2. This evidence covers the production Channel host
and member lifecycle, strict IPC/preload contracts, mounted renderer surfaces,
admission and membership controls, transcript/composer/reconnect behavior, and
packaged surface presence. It does not claim People migration, agent
membership, provider dispatch, macOS DOM automation, or a new two-Mac run.

## Evidence identity

| Item | Recorded value |
| --- | --- |
| P0 prerequisite | User attestation: the existing People flow passed between two real Macs on unrelated networks on 2026-08-09. |
| P1 proof | [`channels-p1-proof.md`](channels-p1-proof.md) |
| P2 process-harness commit | `fa5a638c4c94ffb5462bde553d7fbcce0f15e458` |
| Harness | [`scripts/channels-p2-proof.cjs`](../scripts/channels-p2-proof.cjs) |
| Worker | [`scripts/channels-p2-proof-worker.ts`](../scripts/channels-p2-proof-worker.ts) |
| Harness tests | [`scripts/channels-p2-proof.test.ts`](../scripts/channels-p2-proof.test.ts) |
| Packaged artifact | `dist-debug/mac-arm64/TaskWraith Debug.app/Contents/Resources/app.asar` |
| Package size / SHA-256 | 125,132,538 bytes / `f85a5ef33afdf05c8e918d128cd245af1648f5b9153912ab0bebbce3e8d9c55e` |
| Worker size / SHA-256 | 415,784 bytes / `8a2d73cc52bd67e00eb94d6037de3639a2679a5c41708bfd13c17b57ae6f3ca4` |
| Local evidence | `.local-only/channels-p2-proof-evidence.json`, deliberately gitignored and mode `0600` |

The proof command requires an explicit package path. It rejects a stale package
before launching a mission if any required main, preload, or renderer marker is
absent.

## Packaged surface

The exact `app.asar` above was built from the recorded commit with:

```sh
npm run build:debug:mac
```

Node, web, and TUI typechecks; Electron/Vite and TUI builds; package size,
native-binding, bridge, TUI-runtime, notice, fuse, permission, entitlement,
signature, static Electron, TUI help, and TUI live-control checks passed. The
packaged GUI launch sub-smoke skipped because TaskWraith was already running;
the independent Channel process mission below still ran in full.

The package scanner recorded these independently hashed groups:

| Group | Files | Bytes | SHA-256 | Required markers |
| --- | ---: | ---: | --- | --- |
| Main | 12 | 11,934,959 | `e8ac861790b3623e861315ff885e684c8e6aec4edb4706a5f193b25467e9004d` | host invite, member begin-join, member reset-history IPC |
| Preload | 1 | 110,091 | `67238e9b9a57f614d6b7cd790e978bf385f824815d785fa2591d3193ae7a71a1` | memberships API, change subscription, member begin-join |
| Renderer | 2 | 12,624,840 | `f071f66685f158cade4f38674acfdf968339d8ab2c504384aa8a1f65af90018a` | host confirmation, two-sided SAS guidance, revoked retained history, People adjacency, no-agent-run copy |

## What actually ran

The coordinator spawned a real blind relay plus isolated Host and Member
application child processes. Host and Member used different temporary profile
directories, process ids, and process birth identities. The Member process was
then stopped and restarted twice against the same profile: once for offline
replay and once for revoked-history selection.

The child processes exercised:

- `relay/src/server.ts` through `createRelayServer` and real WebSockets;
- `createChannelProductionBootstrap` and
  `createChannelMemberProductionBootstrap`;
- the production host and member IPC-handler registrars behind an
  Electron-compatible local registrar;
- `ChannelHostPanelController` and `ChannelMemberPanelController`; and
- the production encrypted Channel transport, stores, identities, cursors,
  revocation, close, and read-only replica paths.

The registrar exposed exactly the closed eight-operation host catalogue and
ten-operation member catalogue. No extra test-only IPC operation was admitted.

Each mission then:

1. created a Channel and single-use invite through the host controller;
2. began admission through the member controller and proved that the host and
   member displayed the same SAS before either side confirmed;
3. appended concurrently through both controllers and proved one gapless
   durable order;
4. stopped the Member, appended while it was offline, restarted it with the
   same durable identity and cursor, and replayed the missing record exactly
   once;
5. appended as the restarted Member, revoked it from Host, proved its next
   append failed, and proved Host could continue;
6. restarted the revoked Member, selected its retained history offline without
   opening a socket or producing a new relay frame; and
7. closed the Channel, retained readable history, rejected further appends,
   and removed every relay registration.

## Repeatability results

Run with:

```sh
node scripts/channels-p2-proof.cjs \
  --package 'dist-debug/mac-arm64/TaskWraith Debug.app' \
  --runs 2
```

| Measurement | Run 1 | Run 2 |
| --- | ---: | ---: |
| Duration | 1,052 ms | 1,001 ms |
| Initial consensus high-water | 2 | 2 |
| Offline-replay high-water | 3 | 3 |
| Revoked retained high-water | 4 | 4 |
| Final closed host high-water | 5 | 5 |
| Largest observed wire frame | 1,037 bytes | 1,037 bytes |
| Encrypted application frames | 26 | 26 |
| Handshake frames | 12 | 12 |
| Plaintext application frames | 0 | 0 |
| Final log digest | `84a7889d31329005444b46af575d504d944148a1b35a4977e81d3b5fafd6510c` | `b19156f48f21cf78c608baf69ac294cc6e1722aead13ed19ab0556d6aed4bdec` |

The final digests intentionally differ because clean runs generate new opaque
ids and acceptance timestamps. Within each run, every asserted view agreed at
the recorded high-water sequence.

Both runs proved all of these assertions:

- separate Host and Member application processes and profiles;
- exact closed host and member IPC catalogues;
- matching, two-sided SAS before confirmation;
- encryption of every application frame observed at the relay;
- one gapless order for controller-driven concurrent appends;
- exactly-once durable offline replay;
- one durable Member identity across both restarts;
- revocation making retained history read-only;
- revoked-history selection opening no socket;
- host close retaining history; and
- no agent or provider route in the exercised graph.

## Evidence and secret hygiene

The evidence records bounded process/profile/identity fingerprints, content
hashes, opaque record ids, catalogue names, sequence numbers, digests, and wire
metrics. It rejects invite tokens, room ids, SAS confirmation codes, message
content, payloads, and absolute local paths before writing. The write is atomic
with mode `0600`; temporary profiles and the generated worker bundle are
deleted after the run.

For the headless Node worker only, the Electron `safeStorage` boundary is
implemented by a proof-local AES-256-GCM adapter with a mode-`0600`,
profile-persisted key. The shipping packaged application continues to use
Electron `safeStorage`. The proof therefore establishes durable encrypted
restart behavior through the production store interfaces without claiming a
headless Node process exercised the macOS keychain.

## Deterministic verification

The focused harness suite passed:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

The harness tests pin the explicit-package requirement, bounded repeat count,
stale-package rejection, production bootstrap/controller imports, and a real
worker bundle. Node typecheck and scoped zero-error ESLint, Prettier, and
whitespace checks also passed before the harness commit.

The coherent Channels suite then passed against the committed harness and
proof document:

```text
Test Files  26 passed (26)
Tests       324 passed (324)
```

The exact-head package build passed node, web, and TUI typechecks. Scoped
Prettier remained clean, and the repository format ratchet remained at its
1,216-file baseline across 4,071 considered files.

## Boundary honesty

This is two complementary proofs, not one inflated claim:

1. The `app.asar` scan proves that the built package contains the expected
   shipping main, preload, and renderer Channel surfaces.
2. The process mission bundles production modules from the same exact source
   commit and drives their registered handlers and controllers through real
   relay/WebSocket traffic. It does not load those modules back out of
   `app.asar`, click the packaged DOM, or claim visual-layout coverage.

Renderer model, component, layout, IPC policy, and preload behavior remain
covered by deterministic tests. The user's prior unrelated-network two-Mac
People attestation remains the P0 transport prerequisite; this is not a second
two-Mac attestation.

The local debug package also contains one unrelated, decayed Observatory work
marker inherited from the shared checkout. It is not executable and is outside
all hashed Channel surface groups. This record is consequently an exact local
acceptance artifact, not a release-package hygiene or reproducible-build
attestation.

## Phase boundary

P2 stops here and is complete on `master`: the human Channel experience is
mounted and its packaged surface plus production path have repeatable evidence.
People remains available beside Channels. Conversion, compatibility, soak, and
any retirement decision remain P4 work and require an explicit migration slice;
P2 does not remove or narrow People.

P3 is a separate conditional branch for cryptographic agent membership. It is
not required for the human P0 → P1 → P2 → P4 path and must not open until the
signed agent identity, delegation, revocation, audit, and adversarial-review
design is accepted. No agent or provider route was added by P2.
