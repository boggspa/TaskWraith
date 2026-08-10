# Channels P3 Muse delta review

Date: 2026-08-10

Status: accepted as a bounded post-acceptance provider delta

Original reviewed candidate: `b0f4d84e1fd84e2312f8375dcf7e6fc2d4ee63e4`

Original acceptance record: `92ad1e98259a95377b78c689b586e5e9f8d120d0`

## Decision

Accept Muse as an additional provider identity on the already accepted Channels P3 agent route. This decision does not widen who may start a Channel agent, what a signed grant authorizes, how often it may be consumed, or which provider is offered to a user.

The reviewed provider implementation entered master in merge commit `b8556ee603c0f8ac1f715a4ccbe985ba9450ca03`. Its only changes inside the P3 protected boundary were:

- `src/shared/collaboration/ChannelAgentIpc.ts`: add `muse` to the closed IPC provider identity union.
- `src/main/services/ComposerService.ts`: resolve Muse's canonical default model for a main-owned composed run.

No Channel-bearing line was added or removed in the three composition roots relative to the original reviewed candidate.

## Preserved authority boundaries

Provider recognition is deliberately broader than provider admission. The exhaustive recognition set now comes from `PROVIDER_RUN_MANAGEMENT_IDS`, whose contract explicitly does not decide whether a provider is selectable or dispatchable. The existing main-owned `providerAllowed` checks still decide availability before a seat can be resolved, enrolled, granted, or dispatched.

The remaining P3 boundaries are unchanged:

- A durable human message must contain the structured member id of an enrolled agent.
- The human author must be named by an active, signed, workspace- and posture-bound dispatch grant.
- Consumption is atomic and ordinal, so one accepted mention consumes the one reviewed dispatch exactly once.
- Main composes the run, performs final authorization immediately before adapter invocation, and verifies the exact invocation receipt.
- Terminal publication requires agreeing run signals, a closed run audience, a signed post, public proof verification, and durable restart recovery.

## Review and repair slices

Commit `a79bff720819fd4ae39888b0803c78c34ef741a6` made all Channel provider-recognition boundaries exhaustive and ran the exact enabled mission as Muse (`muse-spark-1.2`). It covers seat authority, native confirmation, durable dispatch-journal restoration, terminal event collection, IPC type parity, and run-composer coverage.

That review exposed one non-Channel completeness omission in the application settings default. Commit `63d5985665a21c89c28cabd6bc37432e4ca9918e` added Muse's existing 120-second completeness timeout to the closed `Record<ProviderId, number>` and restored the full Node typecheck.

## Evidence

- Focused review: 6 files, 52 tests passed.
- Exact in-process production mission: provider `muse`; one dispatch; one final authorization; one adapter receipt; two durable records; 14 of 14 assertions passed.
- The mission verified the public message proof and the signed post after service restart.
- Node typecheck passed after the settings completeness repair.
- No terminal reply, accepted human contribution, private key, or hidden workspace/posture hash is written to the audit record or retained in the proof summary.

The exact-package proof harness must pin the two Muse boundary blobs, the exhaustive review blobs, and this decision record before a later candidate can be accepted.
