# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (docs lane, pass-2)  
**Last updated:** 2026-08-05 pass-2 checkpoint (SolBoss)  
**HEAD:** `18e0d6c6d` · **Branch ahead of origin/master:** 279+  
**Overall completeness:** ~70% (2E-1 PASS · 2E-2 COMPLETE · Gate-2 PASS · Gate-3 PASS · 3.4 adopted · 3.5/Scope-4/3.6 pending)

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` formal | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery composition |
| **Wave 2E-2B** (Deferred allow enabling + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split PASS @ `aceb0993a`; `HostDeferredAllowPipeline` PASS @ `9d4a2a104`; micro-fix `167f6916b` landed |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` / @SparkDocs | `joinFor` cleanup landed (`5a0761793`), Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | 🔄 **OPEN** | `@SolBoss` | Waves 3.1/3.2/Scope 1/Scope B/Scope 2/3.3/3.4 landed; 3.4 adopted @ `516ec6a77`; Gate-3 closed; 3.5 + Scope-4 + 3.6 remain |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | NOT STARTED | `@SolBoss` | Blocked by remaining Wave 3 items |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–5 |

---

## Chronology (Host Arc commits, newest first)

```text
18e0d6c6d  feat(ensemble): swap the speaking-chip glow for the shared shimmer sweep  (foreign concurrency · non-arc)
83970a4c4  feat(perf): wire T9a persistence-stats sampler for comparison runs         (foreign concurrency · non-arc)
516ec6a77  feat(host): add HostMainComposition production in-main Host composition   (@GrokCapt; 3.4 adopted)
6a6b2cc4c  docs(host): refresh Host Arc status through Gate-2 closure                (@DSeekWork)
5a0761793  chore(host): remove unused joinFor helper from host paths                 (@DSeekWork)
24d2c876f  feat(host): add HostLocalServer authenticated v2 local listener           (@SolBoss, 3.3)
08fba66a9  feat(host): bind Authority allowed branch to observe/complete pipeline      (@CursorWork)
167f6916b  test(host): repair HostDeferredAllowPipeline test-only diagnostics          (@GrokCapt)
756e909b6  feat(host): add v2 host paths and discovery module                       (@GrokCapt)
85127999e  feat(host): add Host v2 local transport envelope                          (@GrokCapt)
85dcbfb2e  feat(host): bind typed deferred authority path                            (@GrokCapt)
ddaa786c0  feat(host): construct deferred envelope store in HostRuntimeBootstrap       (@GrokCapt)
9d4a2a104  feat(host): compose verifyCommand -> mutation pipeline                     (@GrokCapt)
aceb0993a  refactor(host): split zero-H verifyCommand from resolver execute            (@GrokCapt)
4cbc5cfe1  style(host): format HostCommandIdentity and HostDomainDeltaPublisher
d612e1e7  docs(host): refresh Host Arc status snapshots                               (@SparkDocs)
8e5c75677  feat(host): add command mutation pipeline                                 (@DSeekWork)
```

**Concurrent-session foreign commits** are present above and below the arc lane (non-arc): `b572d4d0c`→`18e0d6c6d`.

---

## Gate-2 / Gate-3 Closure Evidence

### Gate-2 (host-core formal closure) — PASS

- `167f6916b`, `08fba66a9`, `24d2c876f` exact-path scope checks completed; no forbidden paths in scope.
- Quorum signatures collected: adversarial + final validation + static + Boss live-item (f).
- Ruling A remains: `658/658` under `src/main/host/` and `704/31` under the broad Host glob.

### Gate-3 (post-adoption 3.4 + Ruling-C static closure) — PASS

- `host-arc-gate3-k3review` posted as final validation static pass.
- `516ec6a77` adoption evidence: exact-pair commit (`HostMainComposition.ts` + `HostMainComposition.test.ts`) only.
- `5a0761793` and `6a6b2cc4c` complete Ruling-C and clear arc-owned typecheck debt (`joinFor` TS6133 no longer present in owned files).

---

## Wave 3 — Live Detail

### What’s done

- ✅ Host v2 protocol transport, session, authority, deferred stack, projection substrate, local server, and production composition are in production.
- ✅ 3.4 (`HostMainComposition`) is adopted and constructible in current branch.
- ✅ Ruling-C micro-lane complete (typecheck debt + docs refresh).

### What remains

| Item | Owner | Status |
|---|---|---|
| 3.5 | `HostSupervisor` lifecycle owner | `@DSeekWork` (re-dispatched backup; no lane started yet) |
| Scope 4 | deferred decision recomposition (`approval.decide` / `question.answer`) | `@CursorWork` recon complete; pinned by `host-arc-scope4-pins`; gated on 3.5 and live challengeId/card projection decisions |
| Wave 3.6 | `index.ts` wiring from Host composition into renderer path | `@SolBoss` (tiny exact-scope handoff) |
| Wave 4/5/6 | desktop/TUI/iOS projection cutovers + recovery / mission evidence | `@SolBoss` sequencing follows once Wave 3 is green |

### Open design constraints now pinned

1. `deferredResolution` must be **REQUIRED** wired in Scope-4 (Ruling-B).
2. No implicit/hidden restart or background Host process; host-stop must remain user-visible and persistent.
3. Do not alter `buildHostBootstrapWelcome`; `supervised` must come from injected health provider path.

---

## Acceptance Criteria (current status)

| AC | Status | Note |
|---|---|---|
| AC1–AC6 | ❌ FAIL | No dedicated Host process or client projections yet |
| AC7–AC8 | ⚠️ PARTIAL | Host core is authoritative; no projection cutovers live |
| AC9 | ❌ FAIL | `.twmission` / mission evidence not started |
| AC10–AC11 | ❌ NOT STARTED | No desktop/TUI/iOS projection cutovers |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | `typecheck:node` remaining errors are forbidden diagnostics only (`RemoteTranscriptMessageDeletionHost.test.ts`)
| AC15 | ✅ PASS | No forbidden path drift in scoped arc handoffs; marker/deadline hygiene pinned |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain) · `@K3Review` (final validation gate)

**Aliases:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Commits are exact-path only; marker-before-first-byte and marker-drop-after-byte discipline applies to all writers.

---

## Forbidden Paths (zero diff)

- `src/main/workLocks/**`, `WorkspaceLock*`, `WorkspaceMutationClaims*`
- `src/main/workProvenance/**`, workspace-lock marker/provenance behavior
- `scripts/work-guard*`, `.githooks/**`
- Provider admission / retirement / live membership / security ceilings
- Unrelated history-deletion machinery

---

## Foreign Dirt (do not touch)

- `.WORK-IN-PROGRESS-observatory-gpu-calm.md`
- `scripts/perf/*` and `src/main/store/*`
- `src/main/store/perfStatsHandle.ts` / `src/main/store/index.ts`

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits on papering only.
- QA remains with user.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-gate2-closed`, `host-arc-wave3-k3review`, `host-arc-scope4-pins`, `host-arc-wave35-contract`, `host-arc-status-checkpoint`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork
