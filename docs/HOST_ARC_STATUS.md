# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (pass-5, byte-verified against committed `git log` + live `git status` + `blackboard_read`)  
**Last updated:** 2026-08-06, continuous round  
**HEAD (at time of writing):** `7265e1956` — churns every pass under concurrent foreign sessions; verify with `git log --oneline -1` before acting  
**Branch ahead of origin/master:** ~370 (moving)  
**Overall completeness:** Wave 3 substrate **committed** (3.1–3.5, Scope-4 S4a/S4b/S4c, 3.6a, 3.6b, 4.1, W36-S2, W5-S1); **R5 evaluator sourcing is now durable** (cross-seat carry + Boss ratification); **3.6d is OPEN** (`HostProductionAuthorityEvaluator` pair); 3.6c (`index.ts` wiring) and Waves 4/5/6 still ahead. Production Host **OFF**.

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery |
| **Wave 2E-2B** (Deferred allow + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split @ `aceb0993a`; `HostDeferredAllowPipeline` @ `9d4a2a104`; micro-fix @ `167f6916b` |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` | `joinFor` cleanup @ `5a0761793`; Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | 🔄 **OPEN** — tail only | `@SolBoss` | 3.1–3.5, Scope-4 (S4a/S4b/S4c), 3.6a, 3.6b, 4.1, W36-S2, W5-S1 all **committed** (see chronology). Remaining: **3.6d** (`HostProductionAuthorityEvaluator` — now OPEN, gated by durable R5), **3.6c** (`index.ts` tiny wiring — blocked on 3.6d handoff) |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | NOT STARTED | `@SolBoss` | Blocked by remaining Wave 3 items |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–5 |

---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits (UI/perf/ensemble work unrelated to this arc). This table lists **arc-owned commits only** — run `git log --oneline -1` for current HEAD.

```text
ab972998d  test(host): prove deferred challenges die explicit across Host restart         (@SolWork; @GrokCapt adopted; W5-S1)
e5366dbd2  fix(host): emit real workspacePath in HostProductionSuppliers, never empty path (@DSeekWork; @GrokCapt adopted; 3.6b)
5cc09d681  test(host): prove deferred ask→allow round trip through composed Authority     (@SolWork; @GrokCapt adopted; W36-S2)
5b0ad322d  docs(host): refresh HOST_ARC_STATUS for Wave 3.5/Scope-4 landings              (@SparkDocs; @GrokCapt adopted)
9c31bd54f  feat(host): add HostProjectionClient authenticated v2 wire client              (@CursorWork; @GrokCapt adopted; 4.1)
ab7c2609b  feat(host): add pipelineFactory seam to HostMainComposition                    (@GrokWork; @GrokCapt adopted; 3.6a)
eab4d302f  feat(host): wire S4c required deferred pipeline and challenge-card donor wrap   (@GrokCapt; Scope-4 S4c)
5810c3804  feat(host): add HostDeferredResolutionAdapter over AllowPipeline                (@GrokCapt; Scope-4 S4a)
264426d15  feat(host): E-first deferred decision pre-route on Authority                    (@GrokCapt; Scope-4 S4b)
3376b6c7b  feat(host): add HostSupervisor in-main Host lifecycle owner                     (@GrokCapt; 3.5 adopted)
516ec6a77  feat(host): add HostMainComposition production in-main Host composition         (@GrokCapt; 3.4 adopted)
6a6b2cc4c  docs(host): refresh Host Arc status through Gate-2 closure                      (@DSeekWork)
5a0761793  chore(host): remove unused joinFor helper from host paths                       (@DSeekWork)
24d2c876f  feat(host): add HostLocalServer authenticated v2 local listener                 (@SolBoss; 3.3)
08fba66a9  feat(host): bind Authority allowed branch to observe/complete pipeline          (@CursorWork)
167f6916b  test(host): repair HostDeferredAllowPipeline test-only diagnostics              (@GrokCapt)
756e909b6  feat(host): add v2 host paths and discovery module                              (@GrokCapt)
85127999e  feat(host): add Host v2 local transport envelope                                (@GrokCapt)
85dcbfb2e  feat(host): bind typed deferred authority path                                  (@GrokCapt)
ddaa786c0  feat(host): construct deferred envelope store in HostRuntimeBootstrap           (@GrokCapt)
9d4a2a104  feat(host): compose verifyCommand -> mutation pipeline                           (@GrokCapt)
aceb0993a  refactor(host): split zero-H verifyCommand from resolver execute                 (@GrokCapt)
4cbc5cfe1  style(host): format HostCommandIdentity and HostDomainDeltaPublisher
d612e1e7   docs(host): refresh Host Arc status snapshots                                   (@SparkDocs)
8e5c75677  feat(host): add command mutation pipeline                                       (@DSeekWork)
```

**Concurrent-session foreign commits** are present above, below, and interleaved with the arc commits.

---

## Gate-2 / Gate-3 Closure Evidence

### Gate-2 (host-core formal closure) — PASS

- `167f6916b`, `08fba66a9`, `24d2c876f` exact-path scope checks completed; no forbidden paths in scope.
- Quorum signatures: adversarial + final validation + static + Boss live-item (f).
- Ruling A: `658/658` under `src/main/host/` and `704/31` under the broad Host glob.

### Gate-3 (post-adoption 3.4 + Ruling-C static closure) — PASS

- `host-arc-gate3-k3review` posted as final validation static pass.
- `516ec6a77` adoption evidence: exact-pair commit only.
- `5a0761793` and `6a6b2cc4c` complete Ruling-C and clear arc-owned typecheck debt.

---

## Wave 3 — Live Detail

### What's done (committed)

- ✅ Host v2 protocol transport, session, authority, deferred stack, projection substrate, local server, and production composition are in production.
- ✅ 3.4 (`HostMainComposition`) and 3.5 (`HostSupervisor`) landed and adopted.
- ✅ Scope-4 **S4a** (deferred-resolution adapter), **S4b** (E-first pre-route on Authority), **S4c** (required pipeline + challenge-card donor wrap) all landed.
- ✅ **3.6a** `pipelineFactory` seam (`ab7c2609b`) and **4.1** `HostProjectionClient` wire client (`9c31bd54f`) both adopted.
- ✅ **3.6b** `HostProductionSuppliers` fix (`e5366dbd2`) — P0 `path: ''` defect **fixed** (see below).
- ✅ **W36-S2** `HostDeferredRoundTrip.test.ts` (`5cc09d681`) — first end-to-end ask→allow→execution test.
- ✅ **W5-S1** `HostDeferredRestartRecovery.test.ts` (`ab972998d`) — restart-ask honesty requirements exercised.
- ✅ Ruling-C micro-lane complete (typecheck debt + docs refresh).

### 3.6b — ADOPTED (`e5366dbd2`)

Previously **HOLD** due to a P0 defect: `HostProductionSuppliers.ts` emitted `path: ''` for every workspace row, which both `HostSnapshotProjector.projectWorkspace` (L542-543) and `decodeHostWorkspaceProjection` (L1778-1781) reject — any chat with a non-null `workspaceId` would make `authority.snapshot()` return `host_unavailable`. The unit suite stayed green because it asserted the donor's own output shape and never drove through the real projector/decoder.

**Fix applied:** `workspacePath?: string | null` added to `HostProductionChatListEntry` (L60); workspace loop skips rows when `workspacePath` is absent or empty (L168-169); emission uses real `workspacePath` (L174), never `''`. Test file now carries **32** `it(` — bug-encoding assertion deleted, three consumer-proof tests added (donor→`projectHostSnapshot` with real paths, skip on absent paths, red-proof that `path: ''` still fails the projector). Review quorum: **PASS** ×3 (MistralReview adversarial re-review, GrokReview type/suite, K3Review final gate). Cap adopted as **exact-pair only** at `e5366dbd2`.

**Residual advisories (P3, non-blocking):**
- Truthiness vs `!= null` asymmetry on `searchPreview` (L116-117): empty-string `searchPreview` yields `previewTruncated: false` while a missing field skips it — cosmetic, does not affect path correctness.
- Whitespace-only paths: `wsPath.length === 0` is the skip guard; a `"   "` string would emit. Real chat-list paths won't hit this; optional Wave-6 harden.

### W36-S2 — ADOPTED (`5cc09d681`)

`HostDeferredRoundTrip.test.ts` (`@SolWork`, test-only, **7** `it(`) — first test to drive `ask → approval.decide → allow → execution` through `composition.authority` end-to-end, with a positive control proving the "H never fires" assertions aren't vacuous. Quorum PASS from all three reviewers. Cap adopted as exact-file only at `5cc09d681`.

### W5-S1 — ADOPTED (`ab972998d`)

`HostDeferredRestartRecovery.test.ts` (`@SolWork`, test-only, **5** `it(`) — exercises the `host-arc-restart-ask-semantics` ruling's four mandatory honesty requirements with a **real** shutdown + rebuild over the same durable dir (not a mock "restart"). Requirements proven: (R1) post-restart accept → outcome pinned `indeterminate` (not weak `!== succeeded`), (R2) recovery summary surfaces interrupted command, (R3) new `commandId` re-issue → fresh pending, (R4) post-restart accept → **zero** H / deferred execution. Quorum PASS ×3 (first-pass). Cap adopted as exact-file only at `ab972998d`.

### What remains

| Item | Owner | Status |
|---|---|---|
| **3.6d** `HostProductionAuthorityEvaluator{,.test}.ts` | `@GemProWork` | **OPEN** — gated by the **now-durable** R5 contract (see below). New pair only, Electron-free by import, ports injected (adapt existing authority, never invent policy). Validated handoff, NO self-commit. |
| **3.6c** `index.ts` wiring | `@SolBoss` dispatch | **Blocked** until 3.6d lands. Recon complete (`host-arc-36c-wiring-recon-dseekscout`); a tiny wiring-only hunk per Boss pre-approval. |
| **Wave 4/5/6** | `@SolBoss` sequencing | Desktop/TUI/iOS projection cutovers + `.twmission` flight recorder + adversarial final gates |

### R5 — Evaluator Sourcing (NOW DURABLE)

**Five Boss posting attempts failed** — capacity theory refuted (failed at 58/60 with free slots), size-alone theory refuted (@SolWork's 5,561-char handoff landed first try). The failure mode is Boss-seat-specific turn-output truncation during `blackboard_post`, root cause still undiagnosed.

**The fix that worked:** DSeekScout carried the full C1-C7 text (preserved from Boss's transcript) on a **different seat** as `host-arc-r5-evaluator-preserved` — `blackboard_read`-verified durable at 59/60. SolBoss then ratified it verbatim as the binding 3.6d contract (`host-arc-r5-ratified`, in transcript).

**The contract (durable — 3.6d lane must follow):**
- **C1:** Allow-all `() => ({decision:'allowed'})` is **forbidden** in production (fixture-only in `HostMainComposition.test.ts` L150)
- **C2:** Translate existing authority (PermissionService, NativeApprovalPolicy), never invent new policy
- **C3:** No existing authority ⇒ `deferred` with typed `challengeKind`, never `allowed`
- **C4:** Enumerate the real 10-name catalogue; reads ~ `allowed`, mutations follow C2/C3; no name-string blanket rules
- **C5:** `clientClass` is load-bearing — `ios` never more permissive than `desktop` for the same command
- **C6:** Untypeable deferral fails closed → `markDeferredUnavailable` → zero H
- **C7:** Report gaps honestly, don't fill them with invented rules
- **Test pins:** (1) exhaustive table over 10 command names, (2) clientClass ordering, (3) unknown → deferred/denied red-proof, (4) import isolation

**Line-defs for @GemProWork** (courtesy `@K2.7Scout`, disk-verified):
- Evaluator return shape: `AppStoreHostAuthority.ts` L90-96
- Evaluator type: L98-101
- Composition input: `HostMainComposition.ts` L122 (wired L247/L352)
- Kind union (Bridge-canonical): `HostDeferredCommandBridge.ts` L80
- Store→wire map: `HostAuthorityDecisionMap.ts` L37-41
- `clientClass`: `hostProtocol.ts` L43 / actor L80
- Ports to inject: `PermissionService.ts` L71, `NativeApprovalPolicy.ts` L52/L129
- The 10 command names: `snapshot.get`, `deltas.since`, `receipt.lookup`, `ping`, `approval.decide`, `question.answer`, `composer.send`, `run.cancel`, `ensemble.seat.toggle`, `thread.select` (hostProtocol L536-546 / set L677-688)

**Lesson pinned (standing rule):** if a Boss post fails twice, a scout carries the full text on a different seat and Boss ratifies in one short post. Five failures across two rounds is five too many.

---

## Acceptance Criteria (current status)

| AC | Status | Note |
|---|---|---|
| AC1–AC6 | ❌ FAIL | No dedicated Host process or client projections yet |
| AC7–AC8 | ⚠️ PARTIAL | Host core is authoritative; no projection cutovers live |
| AC9 | ❌ FAIL | `.twmission` / mission evidence not started |
| AC10–AC11 | ❌ NOT STARTED | No desktop/TUI/iOS projection cutovers |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | `typecheck:node` remaining errors are forbidden diagnostics only (`RemoteTranscriptMessageDeletionHost.test.ts`) + foreign transient diagnostics from concurrent sessions |
| AC15 | ✅ PASS | No forbidden path drift in scoped arc handoffs |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain) · `@K3Review` (final validation gate)

**Aliases:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Commits are exact-path only; markers with honest live pid and adopter-window expiry; drop on adopt.

---

## Forbidden Paths (zero diff)

- `src/main/workLocks/**`, `WorkspaceLock*`, `WorkspaceMutationClaims*`
- `src/main/workProvenance/**`, workspace-lock marker/provenance behavior
- `scripts/work-guard*`, `.githooks/**`
- Provider admission / retirement / live membership / security ceilings
- Unrelated history-deletion machinery

---

## Foreign Dirt (do not touch)

This list reflects `git status --porcelain=v1` at time of writing (HEAD `7265e1956`). Re-check before staging — concurrent sessions churn continuously. **Zero arc markers at root** (all dropped on adopt); remaining `.WORK-IN-PROGRESS-*` files are all foreign.

Modified (M):
- `AGENTS.md`, `CLAUDE.md` — agent config, concurrent session
- `docs/HOST_ARC_STATUS.md` — **this file** (SparkDocs refresh, not yet committed)
- `src/main/index.ts` — foreign session (zero Host refs; track this)
- `src/main/services/EnsembleOrchestrator.ts` — **forbidden composition root**, dirty under foreign marker `.WORK-IN-PROGRESS-ensemble-per-chat-flush.md`
- `src/main/store/ChatListIndexStore.ts`, `src/main/store/index.ts` — foreign
- `src/renderer/src/assets/css/02-transcript-messages-fx.css` — foreign
- `src/renderer/src/components/AppChromeSymbols.tsx`, `src/renderer/src/components/TranscriptPanel.tsx` — foreign
- `src/renderer/src/lib/ensembleFanoutViewportGroups.test.ts`, `src/renderer/src/lib/providerLabels.ts` — foreign

Untracked (??):
- `src/main/services/EnsembleOrchestrator.flushScheduler.test.ts`, `src/main/services/ensembleChatFlushScheduler.ts`
- `src/main/store/ChatListIndexProjection.test.ts`, `src/main/store/ChatListIndexStore.test.ts`, `src/main/store/chatListIndexPerf.bench.test.ts`
- `src/renderer/src/lib/fanoutLaneJumpTargets.{ts,test.ts}`
- `src/shared/agentQuestionTranscript.{ts,test.ts}`, `src/shared/providerLabels.ts`

**Exact-path staging only** — never `git add -A` / `git add .` / `commit -a`. `App.tsx` and `EnsembleOrchestrator.ts` are forbidden composition roots; a bulk-add would blow AC12/AC13 in one commit.

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits.
- QA remains with user.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-gate2-closed`, `host-arc-gate3-k3review`, `host-arc-scope4-pins`, `host-arc-scope4-lane-contract`, `host-arc-wave35-contract`, `host-arc-status-checkpoint`, `host-arc-36c-wiring-recon-dseekscout`, `host-arc-36b-path-fix-recon-dseekscout`, `host-arc-r5-evaluator-preserved`, `host-arc-truncation-not-actually-fixed-sparkdocs`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures byte-verified against committed `git log` + live `git status` + `blackboard_read` at time of writing.
