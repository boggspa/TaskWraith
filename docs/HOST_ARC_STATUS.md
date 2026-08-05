# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (docs lane, pass-3 — verified against committed `git log` + live `git status`, not transcript self-reports)  
**Last updated:** 2026-08-06, continuous round (hop count: see latest `host-arc-status-checkpoint` blackboard post — omitted here, it goes stale within a pass)  
**HEAD (at time of writing):** `7b9932bf7` — churns every pass under concurrent foreign sessions; verify with `git log --oneline -1` before acting, don't trust this pin  
**Branch ahead of origin/master:** 352 (moving)  
**Overall completeness:** ~80-82% substrate, 0% cutover — Wave 3.1-3.5 + Scope-4 (S4a/S4b/S4c) all **committed**; Wave 3.6a/3.6b/4.1/W36-S2 are validated handoffs **on disk, not yet committed**; 3.6c (`index.ts` wiring) blocked on the evaluator-sourcing ruling; Waves 4/5/6 not started

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` formal | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery composition |
| **Wave 2E-2B** (Deferred allow enabling + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split PASS @ `aceb0993a`; `HostDeferredAllowPipeline` PASS @ `9d4a2a104`; micro-fix `167f6916b` landed |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` / @SparkDocs | `joinFor` cleanup landed (`5a0761793`), Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | 🔄 **OPEN** | `@SolBoss` | 3.1-3.5 + Scope-4 (S4a/S4b/S4c) all **committed** (see chronology); 3.6a/3.6b/4.1/W36-S2 are validated handoffs **on disk, not yet committed**; 3.6c (`index.ts` wiring) not started — blocked on 3.6a/3.6b adoption + the evaluator-sourcing ruling |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | NOT STARTED | `@SolBoss` | Blocked by remaining Wave 3 items |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–5 |

---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits (UI/perf/ensemble work unrelated to this arc). This table lists **arc-owned commits only** — don't infer current HEAD from it; run `git log --oneline -1`.

```text
eab4d302f  feat(host): wire S4c required deferred pipeline and challenge-card donor wrap  (@GrokCapt; Scope-4 S4c)
5810c3804  feat(host): add HostDeferredResolutionAdapter over AllowPipeline               (@GrokCapt; Scope-4 S4a)
264426d15  feat(host): E-first deferred decision pre-route on Authority                   (@GrokCapt; Scope-4 S4b)
3376b6c7b  feat(host): add HostSupervisor in-main Host lifecycle owner                    (@GrokCapt; 3.5 adopted)
6dec6348d  docs(host): record 3.4 adoption and Gate-3 closure                             (@SparkDocs)
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

**Concurrent-session foreign commits** are present above, below, and interleaved with the arc lane throughout (non-arc; UI/perf/ensemble work) — the range grows every pass, so a pinned SHA range is not tracked here.

**NOT yet committed** (validated handoffs on disk this pass — see "Pending Adoption" table below): Wave 3.6a (`pipelineFactory` seam), Wave 3.6b (`HostProductionSuppliers`), Wave 4.1 (`HostProjectionClient`), W36-S2 (`HostDeferredRoundTrip.test.ts`).

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

### What’s done (committed)

- ✅ Host v2 protocol transport, session, authority, deferred stack, projection substrate, local server, and production composition are in production.
- ✅ 3.4 (`HostMainComposition`) and 3.5 (`HostSupervisor`) landed and adopted.
- ✅ Scope-4 **S4a** (deferred-resolution adapter), **S4b** (E-first pre-route on Authority), **S4c** (required pipeline + challenge-card donor wrap) all landed — `approval.decide` / `question.answer` recompose through the deferred pipeline per the `host-arc-scope4-pins` vocabulary (S4-V).
- ✅ Ruling-C micro-lane complete (typecheck debt + docs refresh).

### Validated handoffs on disk, not yet reviewed-and-adopted

| Item | Owner | Review status | Files |
|---|---|---|---|
| 3.6a `pipelineFactory` seam | `@GrokWork` | Quorum **PASS** (MistralReview adversarial, GrokReview static, K3Review final-gate) + a post-review self-fix (stale docblock + a vacuous test replaced) | `HostMainComposition{,.test}.ts` (modified) |
| 4.1 `HostProjectionClient` | `@CursorWork` | Quorum **PASS** (same three reviewers) | `HostProjectionClient{,.test}.ts` (new) |
| 3.6b `HostProductionSuppliers` | `@DSeekWork` | **Not yet reviewed** — delivered this pass; binds `ChatStore.getChatList()` per the W42-T3 accessor ruling | `HostProductionSuppliers{,.test}.ts` (new) |
| W36-S2 deferred round trip | `@SolWork` | **Not yet reviewed** — delivered this pass; first test to drive `ask → approval.decide → allow → execution` through `composition.authority` end-to-end | `HostDeferredRoundTrip.test.ts` (new, test-only) |

Combined-tree evidence cited by the delivering seats (not independently re-run by this seat): 835/835 across 36 files with all four pairs dirty together; Prettier clean; zero arc-owned `typecheck:node` diagnostics (6 foreign remain — see "Foreign Dirt" below). `@GrokCapt` holds these under `.WORK-IN-PROGRESS-host-arc-captain-hold-36a-41.md` pending exact-path adoption; RULE 4 (re-verify on the adopter's own shell at current HEAD) still applies before staging.

### What remains after adoption

| Item | Owner | Status |
|---|---|---|
| Wave 3.6c | `index.ts` wiring from Host composition into the app | `@SolBoss` — recon complete (`host-arc-36c-wiring-recon-dseekscout`); **blocked**: no production `AppStoreHostAuthorityEvaluator` implementation exists anywhere in `src/main` (evaluator-sourcing ruling still open, see below) |
| Wave 4/5/6 | desktop/TUI/iOS projection cutovers + recovery / mission evidence | `@SolBoss` sequencing follows once Wave 3.6 is green |

### Open design constraints now pinned

1. `deferredResolution` must be **REQUIRED** wired in Scope-4 (Ruling-B).
2. No implicit/hidden restart or background Host process; host-stop must remain user-visible and persistent.
3. Do not alter `buildHostBootstrapWelcome`; `supervised` must come from injected health provider path.

---

## Rulings & Governance Gaps (this pass)

- **A Boss ruling did not durably land.** `@SolBoss` stated two of a promised four rulings in-transcript this pass — accepting the W42-T3 180-char preview accessor (with two written caveats: it's a length bound not a content filter, and the same bytes are a materially different call over the Wave-4.5 iOS remote boundary than over the local socket) and a split AC14 disposition (arc-owned-zero satisfies lane gating now; goal completion still needs foreign diagnostics resolved-or-escalated-with-provenance to the user, not silently redefined). The `blackboard_post` was cut off mid-sentence and never reached the board — `host-arc-boss-rulings-w42t3-ac14-evaluator` reads `not_found`, confirmed independently by `@SolWork` and this seat. The third ruling (evaluator sourcing) never appeared before the cutoff at all.
- **Action:** `@SolBoss` needs to re-post all four rulings durably before Wave 3.6c can be dispatched with a clean decision trail. Per the goal's own terms a transcript statement is not authority — this file records that the statement was made, not that it is ratified.
- **HEAD churns every pass.** Foreign concurrent-session commits land continuously beneath the arc's dirty bytes. Any pre-adoption evidence quoted against an older HEAD must be re-verified at current HEAD before staging (RULE 4) — this has already happened twice this round (once for the 3.6a+4.1 hold, once for 3.6a's post-review amendment).

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

The exact list below churns every pass along with HEAD — treat it as illustrative, not a live source of truth; re-check `git status` before staging. As of this refresh, `git status` shows the following **non-arc** paths dirty alongside the four arc-owned pending pairs:

- `src/renderer/src/App.tsx` — **forbidden composition root**, modified by a concurrent session
- `src/main/services/EnsembleOrchestrator.ts` (+ `EnsembleOrchestrator.fanoutOptionB.test.ts`) — **forbidden composition root**, modified by a concurrent session
- `src/main/run/RunItemEventCompat.ts`, `src/renderer/src/lib/runItemProjection.{ts,test.ts}`, `src/renderer/src/lib/GeminiAdapter.ts`, `src/renderer/src/lib/toolEventDualLane.test.ts`, `src/shared/toolEventNaming.ts`
- `src/renderer/src/components/CharOdometer.tsx`, `src/renderer/src/assets/css/08-theme-picker-overrides.css`

Exact-path staging (never `git add -A` / `git add .` / `commit -a`) is load-bearing this pass, not hygiene: two of the paths above are forbidden composition roots, and a bulk-add would blow AC12/AC13/AC15 in one commit.

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits on papering only.
- QA remains with user.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-gate2-closed`, `host-arc-gate3-k3review`, `host-arc-scope4-pins`, `host-arc-scope4-lane-contract`, `host-arc-wave35-contract`, `host-arc-status-checkpoint`, `host-arc-36c-wiring-recon-dseekscout`, `host-arc-wave36a-seam-handoff-grokwork`, `host-arc-w36s2-roundtrip-handoff-solwork`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures above are byte-verified against committed `git log` + live `git status` at time of writing (not transcript self-reports); validated-handoff evidence tables cite the delivering seat's own run, not an independent re-verification by this seat.
