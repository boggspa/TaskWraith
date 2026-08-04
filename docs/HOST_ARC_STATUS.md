# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@CursorWork` (SparkDocs fallback, pass 5)  
**Last updated:** 2026-08-04 pass-5 checkpoint (SolBoss)  
**HEAD:** `aceb0993a` · **Branch ahead of origin/master:** 190  
**Overall completeness:** ~48–52% (2E-1 PASS · 2E-2A substrate complete · 2E-2B resolver split gated · deferred-allow composition in flight · Waves 3–6 not started)

---

## Current Gate State

| Gate | Status | Owner | Notes |
|------|--------|-------|-------|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` formal | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, session rebind, read-alias gate, bootstrap recovery composition |
| **Wave 2E-2B** (Deferred allow enabling + Authority integration) | 🔄 **OPEN** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split **PASS** @ `aceb0993a`; `HostDeferredAllowPipeline` writer lane live; Authority S1–S5 held closed until that pair gates |
| **Wave 3** (Dedicated Host + supervision) | NOT STARTED | `@SolBoss` | Blocked by 2E-2 |
| **Wave 4** (Desktop / TUI / paired-iOS cutovers) | NOT STARTED | `@SolBoss` | Blocked by Wave 3 |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–5 |

---

## Chronology (recent Host Arc commits)

```
d6126a1e7  docs(host): refresh Host Arc status snapshots          (@SparkDocs)
4cbc5cfe1  style(host): format HostCommandIdentity and
           HostDomainDeltaPublisher                               (@CursorWork)
aceb0993a  refactor(host): split zero-H verifyCommand from
           resolver execute                                       (@GrokCapt adoption
                                                                  of @GrokWork bytes)
```

**Foreign / excluded:** concurrent-session HEAD noise and unrelated UI markers stay out of Host Arc scopes.

---

## Wave 2E-2B — Live Detail

### 1. Resolver `verifyCommand` split — FORMAL GATE **PASS**

| Item | Evidence |
|------|----------|
| Commit | `aceb0993a` (exact pair only) |
| Shape | Public **synchronous** zero-H `verifyCommand` → `verified(command) \| indeterminate(code) \| already_terminal(receiptStatus)` |
| Execute path | `executeCommand` = verify **once** → H **once** only on `verified`, **same decoded object** (no re-decode) |
| Quarantine asymmetry | Quarantine only on actor-confirmed verification failures; **never** on `already_terminal` / `receipt_already_indeterminate` / `receipt_not_pending` |
| Focused tests | **69/69** (59 pre-existing unchanged + 10 new) — SolBoss post-commit re-run closed the reviewer-shell gap |
| Host suite (pre-pipeline) | **28 files / 602** at gate close |
| Reviews | `@MistralReview` adversarial PASS · `@K3Review` final PASS · `@GrokReview` type/suite static PASS · `@DSeekScout` independent PASS — zero P0/P1/blocking-P2 |
| Actor pin | `actor: verified.command.actor` confirmed via correlation → body-identity transitivity (`envelope.actor === input.actor` ∧ `command.actor === envelope.actor`) |
| Marker | `.WORK-IN-PROGRESS-host-arc-2e2b-resolver-verify-split.md` **removed** after adoption |

**Named advisories carried into next gate (do not re-litigate as blockers on the split):**

- (a) Cross-call exactly-once is **coordinator** observe-once/complete-once — not this pair.
- (b) `already_terminal` + still-stored envelope ⇒ treat as done (zero H, zero second complete).
- (c) `receipt_incomplete` omitting `clientId` falls through to correlation mismatch (still fail-closed).
- (d) Header step numbering cosmetic drift (1–3/4 vs 1–6/7) — docs ride-along only.

### 2. `HostDeferredAllowPipeline` — **IN FLIGHT** (locked writer)

| Item | Status |
|------|--------|
| Owner | `@DSeekWork` (Work lane 1) · backup `@GemProWork` |
| Paths | `src/main/host/HostDeferredAllowPipeline.ts` + `.test.ts` (**new pair only**) |
| Marker | `.WORK-IN-PROGRESS-host-arc-2e2b-deferred-allow-pipeline.md` (live; Captain adopts after validated handoff) |
| Contract | `verifyCommand` → `HostCommandMutationPipeline.execute` **exactly once** on verified; zero H / no second complete on indeterminate or `already_terminal`; `already_terminal` = done even if envelope remains stored; `idempotencyKey` from envelope record; **never** bridge `completeReceipt` / `publishEffects`; closed body-free results; forbidden E / Authority / resolver / coordinator / store / bootstrap / root paths |
| Tree dirt | Exactly those two untracked files while the lane validates (do not touch from other seats) |

**Captain chain (pre-authorized by `@SolBoss`):** lane settles with validated handoff → audit claim + exact-pair diff → atomic adoption commit → drop marker immediately → five-lane committed-SHA review quoting contract **plus advisories (a)–(d)** → same quorum rule → post outcome fact. Blocking finding / scope deviation ⇒ hold and route to Boss (no blind retry).

### 3. Held closed until deferred-allow gates

- Authority allowed-path binding + deferred crash-order **S1–S5**
- E widening / terminalization
- Bootstrap construction edits
- Composition-root domain logic (`index.ts`, `App.tsx`, `EnsembleOrchestrator.ts`)

### 4. Authority-wave prep (read-only recon live)

| Pin / recon | Status |
|-------------|--------|
| `host-arc-challengekind-pin` | **Posted** — `challengeKind ∈ {approval, question}` minted at S2 **only** from typed evaluator deferral; never from command-name / client / transcript / default; untypeable deferral fails closed |
| Scout fan-out | `@DSeekScout` crash/edge on both `AppStoreHostAuthority.command()` branches vs S1–S5 · `@K2.7Scout` evaluator decision surface + deferral typing + bootstrap construction · `@CursorScout` disjoint-scope assembly plan — **feeds Boss scope publication; zero edits** |

Disk truth (recon): Bridge/Envelope already type `challengeKind`; Authority evaluator / receipt / wire `ask` surfaces still lack typed approval-vs-question — Authority wave must add typing at the evaluator boundary before S2 mint.

---

## What's Landed (selected Host modules)

### Protocol (`src/shared/`)

| File | Notes |
|------|-------|
| `hostProtocol.ts` + tests | v2 wire: bootstrap, snapshot, delta, command, receipt, capabilities |
| `hostSnapshotApply.ts` + tests | Client cache applicator (idempotent apply / reconnect vocabulary) |

### Durable stores & bootstrap (`src/main/host/`)

| File | Notes |
|------|-------|
| `HostDeltaStore` | Sole generation/cursor journal |
| `HostCommandReceiptStore` + projection | Durable receipts; terminal position refresh from sole journal |
| `HostRuntimeBootstrap` | Store composition + recovery summary |
| `HostCommandRouting` / `Identity` / `Arguments` / `Fingerprint` | Classification, mint, codecs, fingerprints |
| `HostDeferredCommandBridge` | Challenge correlation (E) |
| `HostDomainDeltaPublisher` | Atomic domain delta batches (F) |
| `HostCommandMutationPipeline` | Observe-once → complete-once adapter (`8e5c75677`) |
| `HostDeferredCommandEnvelopeStore` + `Resolver` | Envelope durability + `verifyCommand` split (`aceb0993a`) |
| `HostSession` + `HostBridgeCommandExecutor` | Authenticated session binder + six governed mutations → Bridge |
| `AppStoreHostAuthority` | Pre-cutover migration adapter (tests; zero production root wiring) |

**Composition roots:** still zero Host domain imports in `index.ts` / `App.tsx` / `EnsembleOrchestrator.ts` — correct pre-cutover isolation.

---

## What Remains (by Wave)

### Wave 2E-2B — immediate atomic scopes

| # | Scope | Owner (when opened) | Depends on |
|---|-------|---------------------|------------|
| 1 | Land + gate `HostDeferredAllowPipeline{,.test}.ts` | `@DSeekWork` → `@GrokCapt` adopt → five-reviewer gate | In flight |
| 2 | Authority deferred path S1–S5 + typed `challengeKind` at evaluator | Boss-published exact scopes after #1 PASS | #1 |
| 3 | E widening / terminalization that consumes the pipeline (no double-complete) | Boss gate after #2 design | #1–2 |
| 4 | Bootstrap / recovery composition updates if required by S3 fail vocabulary | Exact pair only when published | #2 |

### Waves 3–6

Unchanged from goal: supervised dedicated Host → client cutovers → `.twmission` → adversarial/final gates. See `docs/HOST_ARC_GOAL.md`.

---

## Acceptance Criteria (15-point summary)

| AC | Status | Note |
|----|--------|------|
| AC1–AC6 | ❌ FAIL | No dedicated Host process / protocol clients yet |
| AC7 | ✅ PARTIAL | Durable stores exist; no supervised Host process |
| AC8 | ✅ PARTIAL | Apply semantics exist; no live multi-client consumers |
| AC9 | ❌ FAIL | Flight recorder not started |
| AC10–AC11 | ℹ️ N/A yet | No multi-client Host runtime |
| AC12–AC13 | ✅ PASS | Provider ceilings / forbidden lock-provenance paths untouched |
| AC14 | ⚠️ PARTIAL | Host focused green at last gate; pay down Prettier ratchet on new files as we go |
| AC15 | 🔄 IN FLIGHT | Resolver marker cleaned; deferred-allow marker live under `@DSeekWork` |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain — controlling only if Boss unavailable) · `@K3Review` (final validation gate)

**Aliases in force:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Never bare provider names (multi-seat providers fail closed). Retired aliases (`@CodexBoss`, `@KimizCaptain`, `@GrokBG`, numbered Work seats, etc.) appear in historical text only — do not route to them.

**Commits:** exact paths only · marker raised before first byte · dropped immediately after atomic commit · no bulk staging · no `format:all`.

---

## Forbidden Paths (zero diff)

- `src/main/workLocks/**`, `WorkspaceLock*`, `WorkspaceMutationClaims*`
- `src/main/workProvenance/**`, workspace-lock marker/provenance behavior
- `scripts/work-guard*`, `.githooks/**`
- Provider admission / retirement / live membership; permission ceilings / security walls
- Unrelated history-deletion machinery

Host may **consume** existing lock authority but must not change it.

---

## User Notes (standing)

- Release claims on `index.ts` / `App.tsx` as soon as editing finishes (busy shared files).
- Prettier ratchet: new files must be born formatted; pay down Host-owned offenders as we go (`4cbc5cfe1` paid Identity + DomainDeltaPublisher).

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard keys: `host-arc-continuation-plan`, `host-arc-wave2e2-authority-pins`, `host-arc-2e2b-envelope-store-design`, `host-arc-2e2b-resolver-verify-split`, `host-arc-2e2b-deferred-allow-pipeline`, `host-arc-challengekind-pin`, `host-arc-status-checkpoint`, `host-arc-handoffs`

---

**Maintained by:** `@SparkDocs` (documentarian) · mechanical fallback commits may be executed by `@CursorWork` when Boss routes them  
**Scope:** Repo paperwork only — this file does not implement Host code
