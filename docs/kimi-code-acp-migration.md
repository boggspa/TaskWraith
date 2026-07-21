# Kimi Code ACP production containment

Developer reference for TaskWraith's source-ahead Kimi runtime after the
`kimi-cli` to Kimi Code migration.

> **Version boundary:** v1.8.5 is the released baseline. This document describes
> the current source-ahead checkout and must not be read as a v1.8.5 guarantee.
> The next release notes decide when this posture becomes shipped behavior.

## Current status

Managed Kimi execution is ACP-only. `TASKWRAITH_KIMI_ACP` selects whether that
transport may be considered; it is not qualification evidence. There is no
Wire or print fallback.

Runtime admission is always enabled and structural in every build, packaged
included: descriptor-bound identity capture, bounded probes, an exact version
parse, and the ACP-only posture gate the seat. The embedded qualification
roster is intentionally empty today, so admitted runs are explicitly labelled
`unattested-development` rather than `reviewed`; that labelling is not
credentialed canary evidence and cannot qualify a release. A commissioned
reviewed roster tuple upgrades a matching binary's runs to `reviewed`.

The production guarantee is deliberately scoped to TaskWraith-managed Kimi
turns and native compaction. Explicit user-owned `kimi login` and `kimi upgrade`
terminal handoffs are setup operations outside managed-run containment. They
are labelled `user-owned-provider-setup` with `managedRunReady: false`; success
does not qualify the runtime. Kimi has no bounded logout command, so TaskWraith
does not replace it with a bare interactive Kimi session.

Managed ACP authentication is sourced only from the current `~/.kimi-code`
home: the OAuth credential written by `kimi login`, or a provider key already
configured in that home's `config.toml`. The encrypted Moonshot key stored in
TaskWraith Settings is used for usage queries and is not projected into ACP.
Legacy `~/.kimi` credentials remain usage-history compatibility only and never
make a managed seat ready.

## OAuth refresh authority

Kimi Code OAuth refresh tokens are rotating and single-use. Managed OAuth seats
therefore acquire a private, source-home keyed authority before TaskWraith
scrubs or seeds a seat home, and hold it until the provider has closed, any
rotated credential is committed, and runtime material is scrubbed. A second
managed OAuth seat fails closed while that lease is live. Provider-key seats do
not use the OAuth authority and can still run concurrently.

The authority snapshot and durable lease live under
`~/.kimi-code/.taskwraith-oauth-authority-v1`. Before TaskWraith sends the first
ACP initialize frame, it records the spawned provider PID and process-birth
identity. After a TaskWraith crash, a new process refuses to steal the lease if
that exact child may still be alive; otherwise it replays the durable
`claimed`/`seeded`/`committed`/`scrubbed` state machine before ordinary isolated-
home cleanup can remove a rotated candidate. Writeback rejects an independently
advanced source credential, fsyncs its exact candidate digest/outcome intent,
uses private atomic replacement, and commits the primary credential last. If
the isolated candidate is lost after that source commit, restart can finish
forward only when the descriptor-validated source primary matches the durable
intent exactly. TaskWraith then scrubs and fsyncs the isolated runtime home and
removes the durable lease only after the scrubbed marker is committed.

This authority covers TaskWraith-managed ordinary turns and native compaction.
User-owned `kimi login` remains outside managed-run containment and should not be
run concurrently with a managed Kimi OAuth seat.

## Runtime admission

`kimi/KimiRuntimeAdmission.ts` is the only production admission seam. It binds
an executable descriptor to:

- binary SHA-256, platform, and architecture;
- qualification scope `acp-synthetic-cwd-gateway-v1`;
- exact version and normalized ACP capability fingerprint;
- posture `synthetic-cwd-gateway-v1`; and
- reviewed attestation source.

The executable is opened, hashed, and stat-bound before probing. Known and
unknown binaries alike are probed with bounded output/time limits
(`--version`, `--help`, `acp --help`), then identity is checked again; a
reviewed roster match decides the `reviewed` vs `unattested-development`
labelling rather than whether probing happens. Every managed spawn calls the
branded `assertReadyForSpawn` callback immediately before process creation.

Admission runs before ordinary managed turns, native compaction, status/auth
inspection, and ensemble preflight. A PATH hit is not reported as a runnable
Kimi seat. Admission proves the local executable/startup surface; it does not
prove remote account entitlement, backend identity, or model equivalence.

The scheduled launch authority schema (`KimiLaunchControls` in
`ProviderLaunchAuthorityDigest`) signs this ACP composition directly: `acp`
transport, the pinned `synthetic-cwd-gateway-v1` posture, private synthetic
cwd, absent client-fs capability, the mandatory authenticated loopback HTTP
gateway, and the admission roster digest/mode. The retired Wire/print controls
are unrepresentable. The seal engine itself
(`mintScheduledOccurrenceSeal`/`verifyScheduledOccurrenceSealAgainstCurrentContext`)
is live for the Stage-2 claimed solo Cursor lane: TaskWraith mints, persists,
then immediately re-derives and verifies the occurrence before provider
dispatch. Kimi remains intentionally unsealed for now. Its ACP process uses a
fresh isolated home, private cwd, and gateway route created inside its launch
path; that exact dispatch-owned evidence is not yet injected into the seal
service, and it must not be approximated.

## Production launch composition

`launchKimiProductionAcp` is the executable composition root. A managed launch
must satisfy all of these conditions together:

1. An exact admitted runtime supplies the executable path.
2. A strict seat-isolated `KIMI_CODE_HOME` is prepared under
   `kimi-acp-seats-v2`.
3. A fresh, private, mode-0700, empty synthetic cwd is created inside that
   isolated home.
4. The authenticated loopback HTTP MCP gateway starts successfully.
5. The cwd and runtime identity are rechecked immediately before spawn.

The real workspace is never the process cwd or ACP `session/new`/
`session/resume` cwd. Project `.kimi-code` configuration in the workspace is
therefore inert rather than something TaskWraith must scan and race before use.
The real workspace is reachable only through TaskWraith's governed gateway.

Production advertises `clientCapabilities: {}` and installs no ACP client
filesystem request handler. An unsolicited `fs/*` request receives JSON-RPC
method-not-found. This prevents a provider update from shifting workspace
authority onto a client-fs fallback.

## Native-tool deny wall

The contained Kimi profile statically denies exactly these native tools:

| Class | Denied tools |
| --- | --- |
| Filesystem and execution | `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep` |
| Egress and fan-out | `WebSearch`, `FetchURL`, `AgentSwarm` |

The TOML transformer removes standing `allow` rules and rejects unsupported or
ambiguous permission encodings. The permission mediator repeats the exact
nine-tool deny wall as defense in depth if a provider build asks anyway. Only
sanctioned read-only TaskWraith MCP tools auto-allow; mutating gateway tools use
the normal signed approval/workspace-grant policy.

There is no native-tool fallback when the gateway is disabled or fails to
start. Both cases fail before provider spawn.

## Authenticated HTTP MCP gateway

Kimi ACP accepts HTTP/SSE MCP entries rather than TaskWraith's stdio bridge.
`kimi/KimiHttpMcpBridge.ts` therefore creates one per-run server on
`127.0.0.1` with a random bearer value. The exact URL and header are advertised
only to that ACP session. Requests enter the existing TaskWraith MCP dispatch,
so tool-catalog filtering, workspace/path checks, service policy, approvals,
grants, and audit events remain host-authoritative.

The Kimi process receives a positive-allowlist environment. Arbitrary runtime
profile variables, loader/interpreter injection, and real-workspace cwd hints
are stripped. Loopback is forced into both `NO_PROXY` and `no_proxy` so the
bearer-bearing gateway request is not forwarded to an inherited proxy.

Opt-in ACP debug output records fixed structural metadata only: direction,
frame kind, allowlisted method class, RPC-id presence, and numeric protocol
error code. It never serializes params/results, bearer headers, cwd, prompts,
or tool payloads.

## Durable continuity and posture fence

Each solo chat, delegated child, and ensemble participant has a distinct
seat-isolated home. Runtime credentials/config are scrubbed on every terminal
path. Only the recursively verified continuity allowlist (`sessions/` and
`session_index.jsonl`) may survive a strict durable cleanup.

Native resume requires all of the following:

- a Kimi `session_...` identity;
- the exact persisted posture marker `synthetic-cwd-gateway-v1`; and
- the same seat-isolated durable state.

Legacy/unmarked seats cold-start with full authorized context. They are never
resumed into the new boundary. The v1 seat root is retired.

Kimi's native `/compact` runs through the same admitted ACP composition. It is
resume-only, tool-denied, synthetic-cwd based, and uses the authenticated
gateway. Timeout handling requests graceful termination, applies a SIGKILL
backstop, and quarantines seat resources if the process has not closed; cleanup
and seat release occur only after the close boundary.

## Terminal and cleanup semantics

The neutral ACP core treats process `error` as a request to terminate, not as a
cleanup boundary. Terminal projection happens exactly once on `close`.
Production cleanup joins duplicate callbacks, retries strict removal once, and
runs before transcript/usage terminal projection and run-manager finish.
Cleanup failure produces a failed terminal result rather than silently leaving
credential-bearing residue.

The joined cleanup covers the private cwd, ephemeral home material, and HTTP
gateway. Gateway disablement, bridge startup failure, runtime identity change,
history-clear admission loss, normal completion, cancellation, process error,
and native compaction all use the same fail-closed lifecycle.

## Release qualification

The protected provider canary runs on a fresh GitHub-hosted `macos-15` worker.
Its reviewed Kimi scope is `acp-synthetic-cwd-gateway-v1`, and its sole
allowlisted suite is `KimiProductionContainment.live.test.ts` with 16 exact
assertion names. The suite proves private process/session cwd, no ACP client fs,
and forces each of the nine native tools to produce a structured terminal denial
with the same tool-call id. It also proves authenticated gateway-only workspace access,
legacy-posture cold start, strict teardown, and pre-spawn gateway failure.

Qualification evidence may be produced for review, but strict release
admission remains red until the reviewed tuple is intentionally projected into
the embedded roster; desktop admission is not gated on it and keeps running in
labelled `unattested-development` mode. Ordinary CI and this documentation do
not convert a skipped or unattested live run into a pass.

## Key files

| Concern | Module |
| --- | --- |
| Runtime qualification/admission | `kimi/KimiRuntimeAdmission.ts` |
| Executable production composition | `kimi/KimiProductionContainment.ts` |
| Neutral ACP lifecycle | `acp/AcpTurnClient.ts`, `acp/AcpProtocol.ts` |
| Kimi ACP adapter (no client fs) | `kimi/KimiAcpClient.ts` |
| Strict isolated home | `kimi/KimiAcpHome.ts`, `kimi/KimiAcpSeatState.ts` |
| OAuth lease, rotation CAS, and crash replay | `kimi/KimiOAuthCredentialLease.ts` |
| Config transform and nine-tool deny wall | `kimi/KimiAcpContainment.ts` |
| Permission defense in depth | `kimi/KimiToolPolicy.ts` |
| Authenticated loopback gateway | `kimi/KimiHttpMcpBridge.ts` |
| Managed turn and native compaction call sites | `index.ts` |
| Posture marker | `shared/kimiAcpPosture.ts` |
| Reviewed live evidence | `kimi/KimiProductionContainment.live.test.ts` |
| Canary runner | `scripts/provider-containment-canary.cjs` |
