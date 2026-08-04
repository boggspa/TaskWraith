# PROJECT CONSTELLATION — THE TASKWRAITH HOST ARC

## GOAL

Complete the TaskWraith Host Arc.

TaskWraith Host must become the sole authoritative owner of domain state, providers, missions, scheduling, approvals, audit and recovery.

Desktop, TUI and paired remote iOS must become first-class projections over one authenticated, versioned Host protocol. They may cache coherent snapshots for presentation/offline use, but must not create competing authority or independently reconstruct lifecycle state.

Renderer/window restart must not interrupt an active mission. Explicitly stopping Host remains a visible user-controlled action; do not create an undeclared or irremovable background service.

## HOP BUDGET

Initial ceiling: 455 hops.

@CodexBoss or @KimizCaptain may mark the goal complete and stop early as soon as all acceptance criteria are evidenced, required work is committed and no blocking finding remains.

They may extend up to an absolute maximum of 500 hops only with a written checkpoint listing unmet criteria, blockers, owners and remaining waves. Never extend merely to consume quota or manufacture scope.

## ARCHITECTURE

Host owns:

- workspaces, chats, missions, ensembles and participants;
- rounds, fan-outs, routing, handoffs and lifecycle;
- provider processes and session continuity;
- scheduling, queues and background execution;
- questions, approvals and governed commands;
- durable stores, audit, recovery and idempotency;
- usage/cost observations;
- projection generations, cursors and reconnect;
- existing workspace-lock authority through its unchanged public boundary.

Desktop, TUI and iOS own presentation, navigation, accessibility, local visual preferences, coherent caches and command composition.

Clients must not launch providers, read Host stores directly, infer authority from transcript prose, fabricate telemetry, reinterpret terminal outcomes, widen permissions or reimplement locking.

A provider terminal outcome, round outcome, mission outcome and client connection state are distinct. Provider success must never be rewritten as cancelled because its round later stopped. Unavailable telemetry is not zero. Cached state is not live state.

## HOST PROTOCOL

Create a transport-independent, versioned protocol with:

1. Bootstrap:
   Host identity/version, protocol/projection version, generation, cursor, authenticated client identity and available capabilities.

2. HostSnapshot:
   Bounded projections of workspaces, threads, runs, missions, rounds, waves, participants, providers/models, routing, health, questions, approvals, schedules, usage, artifacts, warnings and recovery.

3. Deltas:
   Stable ordering, generation boundaries, idempotent application, duplicate/late-event handling, tombstones, reconnect resumption and explicit full-resnapshot rules.

4. Commands:
   Typed commands with stable command ID, idempotency key, actor/client identity, exact target/arguments, authority evaluation, durable receipt and reconnect-safe result lookup.

Use existing authenticated bindings:

- Desktop: local Host connection
- TUI: authenticated local Host connection
- iOS: existing paired remote boundary

Do not open an unauthenticated listener or broaden remote access.

Compact projections/exports must exclude credentials, secrets, raw hidden reasoning, unrestricted tool output, diff bodies and unrestricted file/transcript content.

## STRICT BOUNDARIES

Do not edit or redesign:

- src/main/workLocks/**
- WorkspaceLock*, WorkspaceMutationClaims*
- src/main/workProvenance/**
- workspace-lock marker/provenance behavior
- scripts/work-guard*
- .githooks/**
- provider admission, retirement or live membership
- provider permission ceilings/security walls
- unrelated history-deletion machinery

Host may consume existing lock authority but must not change it.

Avoid domain logic in index.ts, App.tsx and EnsembleOrchestrator.ts. A tiny wiring hunk requires recon proof, exact-scope clearance and @CodexBoss approval.

Do not remove, restrict, silence or fail-close any provider/model to simplify Host integration. Preserve current capability with honest limitations.

No worktrees. Preserve unrelated dirty/untracked work. Use exact markers, disjoint scopes, exact staging and prompt commits. Never use bulk staging or repo-wide formatting.

No version bump, release, publication, push or notarisation unless separately requested.

## CURRENT STATUS

**As of 2026-08-04 (Wave 2E-2A/2E-2B sequencing):**

- **Overall completeness:** ~45-50%
- **Wave 0:** ✅ Complete (baseline captured)
- **Wave 1:** ✅ Complete (architecture proposal)
- **Wave 2A–2B:** ✅ Complete (protocol types, durable stores, bootstrap, receipts, projection, fingerprint, decision map)
- **Wave 2D-1:** ✅ Complete (routing, identity, arguments)
- **Wave 2D-2:** ✅ Complete (snapshot apply, deferred bridge, delta publisher)
- **Wave 2E-1:** ✅ **PASS** (HostSession + HostBridgeCommandExecutor, 5-reviewer formal PASS)
- **Wave 2E-2A:** ✅ **PASS** (commandId binding, session rebind refresh, read-alias pre-gate, receipt position semantics and recovery composition)
- **Wave 2E-2B:** 🔄 **OPEN**
  - ✅ 4/5 lane substrates and `HostCommandMutationPipeline` (`8e5c75677`) are landed and verified
  - 🔄 Next sequence: `HostDeferredCommandEnvelopeResolver.verifyCommand` split → `HostDeferredAllowPipeline` → deferred branch in `AppStoreHostAuthority`
- **Wave 3–6:** Not started

**Current activity:** The open slice is the resolver verification split to prevent double execution before allow/complete composition. After that, the deferred-allow adapter and authority branch remain to be integrated, then Wave 3+ client cutover work begins.

**See [`HOST_ARC_STATUS.md`](./HOST_ARC_STATUS.md) for detailed inventory, test coverage, gate status, commit links and active lane assignments.**

---

## EXECUTION

### Wave 0 — Baseline

@CodexBoss, @KimizCaptain and @GrokBG:

- set the durable goal and work board;
- capture HEAD, dirty state and markers;
- record forbidden paths and baseline tests;
- confirm unique participant aliases;
- define report/commit/review handoffs.

### Wave 1 — Read-only recon

All scouts remain read-only. Captain assigns one domain per scout:

- authoritative stores and recovery;
- Desktop state ownership;
- mission/fan-out lifecycle;
- authenticated control transports;
- iOS parity/pairing;
- TUI parity;
- archive/performance limits;
- export/redaction/integrity;
- provider health/usage semantics;
- transcript/Mission Control reuse;
- reconnect/idempotency;
- accessibility;
- golden fixtures;
- packaging/process supervision;
- visual interaction design;
- composition-root avoidance;
- migration/rollback risks.

Each scout returns existing machinery, exact paths/symbols, gaps, risks, tests and smallest safe slice.

@KimizCaptain consolidates one architecture proposal answering:

- What process is Host and how is it supervised?
- What survives renderer/window restart?
- What happens on explicit Host quit?
- How are current stores/providers migrated without duplication?
- What is the protocol and cutover sequence?
- How can each stage roll back safely?

@CodexBoss gates implementation.

### Wave 2 — Contract over current authority

Suggested lanes:

- @GrokWork1 — snapshot/delta/cursor core
- @CursorWork1 — Desktop Host client adapter
- @GrokWork2 — command receipts/idempotency
- @CursorWork2 — shared/iOS-compatible contracts
- @CursorWork3 — fixtures and protocol harness

Prove the contract over current behavior before extraction.

### Wave 3 — Host extraction

Extract Host-owned composition into Electron-independent modules, then introduce a dedicated supervised Host runtime.

Preserve all providers, permissions, scheduling, stores, recovery, audit and current lock-boundary use.

Electron main should become lifecycle/window/native integration and minimal transport wiring—not a replacement monolith.

### Wave 4 — Client cutovers

Desktop:

- consume Host projections/commands;
- reconnect after renderer restart;
- show stale/offline state;
- keep heavy scans outside UI-critical paths.

TUI:

- live/historical missions, participant/fan-out views, filters;
- governed commands, reconnect and JSON output;
- usable 80×24 and wide layouts.

iOS:

- paired connection, mission/participant timeline;
- existing authorized commands;
- background reconnect and coherent offline snapshot;
- phone/iPad, Dynamic Type and VoiceOver.

### Wave 5 — Flight recorder

Create bounded, privacy-safe `.twmission` export/import with manifest, schema/projection version, cursor range, integrity digest and redaction metadata.

Import is replay-only and cannot mutate live Host state.

Cover 30 participants, long missions, overlapping fan-outs, routing, provider success plus later round cancellation, delayed/duplicate/out-of-order events, missing usage, reconnect, renderer/Host restart and corrupt/oversized bundles.

### Wave 6 — Adversarial review

- @CursorReview1 — schema/API compatibility
- @GrokReview1 — authority/privacy/security
- @CursorReview2 — UX/accessibility
- @GrokReview2 — performance/recovery/chaos
- @CursorReview3 — integration/packaging/commit hygiene

Report P0–P3 with exact evidence. Reviewers remain read-only unless promoted. Resolve all P0/P1 and mission-blocking P2 findings.

## FINAL ACCEPTANCE

Prove:

1. Dedicated Host is canonical and supervised.
2. Desktop, TUI and iOS agree at the same generation/cursor.
3. Active providers continue through Desktop renderer/window restart.
4. Desktop reconnects without duplicate turns or commands.
5. A question answered on iOS yields the same receipt on Desktop/TUI.
6. Existing mission control from TUI appears identically elsewhere.
7. Controlled Host restart recovers durably and idempotently.
8. Duplicate/out-of-order deltas do not corrupt clients.
9. `.twmission` replay is deterministic and corrupt bundles are rejected.
10. No UI-critical process performs multi-gigabyte archive scans.
11. Slow clients cannot stall Host or other clients.
12. No provider capability, permission or admission was reduced.
13. Forbidden lock/provenance paths have zero diff.
14. Focused tests, Node/web/TUI typechecks, Swift tests, accessibility checks, format ratchet, doctrine/provider guards and appropriate production builds pass.
15. Commits, markers, remaining limitations and tree state are reconciled.

When these criteria are met, @CodexBoss or @KimizCaptain must mark the goal complete and end the mission even if hops remain.

Begin with Wave 0.

