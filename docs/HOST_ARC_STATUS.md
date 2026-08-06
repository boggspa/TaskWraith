# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (Boss Wave-4.2a paperwork fan-out — docs only; byte-verified against live `git status` / `git log` / `git show` / root markers)  
**Last updated:** 2026-08-06T13:40Z continuous round  
**HEAD (at time of writing):** `20a775d96` — churns every pass under concurrent foreign sessions; verify with `git log --oneline -1` before acting  
**Branch ahead of origin/master:** ~407 (moving)  
**Overall completeness:** **Wave 3 CLOSED** — four SHAs (`18ec305f9`, `a12f2840a`, `80b1284c5`, `b45d4297f`). **Wave 4.2a LANDED** `20a775d96` — first client projection in HEAD (TUI read-only via `HostProjectionClient`). AC1–6 **PARTIAL** (Host wiring committed; TUI projects read-only; Desktop/iOS still zero; production Host process **never observed running**). Wave **4.2b** (TUI commands) **ACTIVE** · owner `@CursorWork`. AC9 **NOT STARTED**. Socket suite still never run (goal-completion blocker).

---

## ⚠ CRITICAL DISTINCTION — “Host is ON” ≠ “Host has booted”

**PRODUCTION HOST HAS NEVER BEEN OBSERVED RUNNING** (`host-arc-production-host-has-never-actually-run`, measured by `@SolBoss`).

| Claim people will misread | What is actually true |
|---|---|
| “Host is ON” | **Wiring is committed** in Electron main (`b45d4297f`). `createHostProductionBootstrap` + `start().catch(...)` + `stopSync` exist in **HEAD** `index.ts`. |
| “Host has booted / is listening” | **Not observed.** Zero `taskwraith-host-v2.json` discovery files exist on this machine (prod + TaskWraith Dev userData searched). Running TaskWraith.app started **~2h11m before R4' landed** — it is a **stale binary** that predates Host wiring. Cause (a) stale process, not cause (b) `start()` failing into the logged catch. |
| TUI Fake Host v2 green | **Client-path evidence over TCP loopback** in-process. Proves connect → token → hello/welcome → `snapshot.get` → map → render. **Does not** prove unix-socket listen, live production Host, or narrow the `EPERM` socket-suite gap. |

Do **not** inherit the stronger claim by accident in a fresh context. Restart / rebuild of a post-R4' binary is an ops follow-up, not a 4.2a code defect.

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery |
| **Wave 2E-2B** (Deferred allow + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split @ `aceb0993a`; `HostDeferredAllowPipeline` @ `9d4a2a104`; micro-fix @ `167f6916b` |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` | `joinFor` cleanup @ `5a0761793`; Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | ✅ **CLOSED** | `@SolBoss` / `@GrokCapt` | Substrate + Gates 1/2/3.6e + R4' wiring all committed. Host **wiring ON** in main. AC1–6 → **PARTIAL** (not PASS). Production Host **never observed running**. |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | 🔄 **ACTIVE** — 4.2b | `@SolBoss` / `@CursorWork` | Order ruled **TUI → Desktop → iOS**. **4.2a LANDED** `20a775d96`. **4.2b** TUI commands over Host (deferred-approval receipts) in flight. |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 progress; AC9 still NOT STARTED |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–5 **and** HostLocalServer socket-suite gap |

---

## Boss / Captain Rulings (binding)

### WAVE 3 — CLOSED (four SHAs)

Verified by `@SolBoss` with shell (`host-arc-wave3-closed-four-shas`); Cap land claims accepted:

| Gate | SHA | Commit |
|---|---|---|
| **3.6d / Gate 1** — production authority evaluator | `18ec305f9` | `feat(host): add production authority evaluator (Wave 3.6d)` |
| **3.6c / Gate 2** — production bootstrap composition | `a12f2840a` | `feat(host): add production bootstrap composition (Wave 3.6c)` |
| **3.6e** — stable per-install host identity | `80b1284c5` | `feat(host): add stable per-install host identity (Wave 3.6e)` |
| **R4'** — wire production Host into Electron main | `b45d4297f` | `feat(host): wire production Host bootstrap into Electron main (R4')` |

`git show --name-only b45d4297f` ⇒ `src/main/index.ts` **alone**. Exact-path discipline held.

### GATE 1 (3.6d) — ADOPTED

- **SHA:** `18ec305f9`
- **Paths:** `HostProductionAuthorityEvaluator{,.test}.ts` only
- **Focused suite at adopt:** 64/64 (Captain claim; peer-accepted)
- **Marker:** dropped on land

### GATE 2 (3.6c) — ADOPTED

- **SHA:** `a12f2840a`
- **Paths:** `HostProductionBootstrap{,.test}.ts` only
- **Base kept:** `@DSeekWork` pair patched by `@SolWork` (six-item mandate) — not wholesale-restored
- **Evidence at adopt:** focused **32/32**; non-socket host suite **859/859** (33 files). **HostLocalServer unix-socket tests (~35) DID NOT RUN** — sandbox `EPERM`. Do **not** treat as full-suite green.
- **Six-item work order:** CLOSED. Do not re-verify (`host-arc-stop-reverifying-the-four`).
- **Markers:** dropped on land

### GATE 3.6e — `HostInstallIdentity` — ADOPTED

- **SHA:** `80b1284c5`
- **Boss ruling:** `host-arc-hostid-ruling` — UUID once, persisted under host runtime data dir; per-instance `userData`; `hostVersion` = `app.getVersion()` (no fabricated fallback).
- **Author:** `@GrokWork` · **Adopter:** `@GrokCapt`
- **Paths:** `HostInstallIdentity{,.test}.ts` only (exact-path)
- **Evidence at adopt (Cap — shell seat):** focused **29/29**; non-socket host **888/888** (34 files). Socket suite **not** claimed (`EPERM` gap). Outside-sandbox full **923** was **declined** — disclosed, not claimed.
- **K3Review / GrokReview:** static delta PASS on Cap land; no reopen.
- **Marker:** dropped on land

### R4' — production Host wiring — ADOPTED

- **SHA:** `b45d4297f`
- **Path:** `src/main/index.ts` **only** · numstat `31\t0`
- **Author:** `@SolWork` · **Adopter:** `@GrokCapt`
- **Boss clearance:** `host-arc-r4prime-adopt-authorized` · hunk content: `host-arc-r4prime-hunk-content-ruling`
- **Landed shape (binding checklist — all present):**
  1. `hostSupervisor.start().catch(...)` with logged failure — **not** `void`
  2. `hostSupervisor?.stopSync()` inside existing `will-quit`
  3. `hostId: resolveHostInstallId({ userDataPath })`
  4. `hostVersion: app.getVersion()` — no `'0.0.0'` fallback
  5. Placement inside `app.whenReady()` on single-instance-held branch
  6. Wiring only — no domain assembly in composition root
- **Evidence at adopt:** same-breath Host-only `+31/−0`; typecheck **zero** errors naming `index.ts` / `host/`; non-socket host **888/888**. Socket suite **not** claimed.
- **K3Review delta:** PASS (`host-arc-r4prime-k3review-delta-pass`)
- **Marker:** SolWork courtesy fence dropped with atomic commit
- **Runtime observation (later):** production Host **never observed running** — see critical distinction above. Wiring SHA stands; boot evidence does not.

### WAVE 4.2a — TUI read-only Host projection — **LANDED**

- **SHA:** `20a775d96` — `feat(tui): project Host snapshots into the TUI (Wave 4.2a)`
- **Author:** `@CursorWork` · **Adopter:** `@GrokCapt`
- **Paths (exact-path five only):**
  - `src/tui/hostProjectionMap.ts` (new)
  - `src/tui/hostProjectionMap.test.ts` (new)
  - `src/tui/TaskWraithTui.ts`
  - `src/tui/cli.ts`
  - `src/tui/TaskWraithTui.test.ts`
- **Excluded from land (foreign):** persistence workers under `src/main/store/` / `src/main/workers/`, `electron.vite.config.ts`, `docs/` — Cap did not stage them.
- **What landed:**
  - `HostProjectionClient` connect with `capabilities: ['bootstrap', 'snapshot', 'health']`
  - `hostProjectionMap` → existing TUI render model (preview-only transcript; unavailable usage ≠ zero; status from runs/mission/round)
  - Commands blocked with read-only notice until **4.2b**
  - v1 `TaskWraithControlClient` retained in tree; **not** the live path; **not** retired
- **Cap evidence (shell seat — binding):**
  - `npm run typecheck:tui` — **exit 0** (correct project; see typecheck convention below)
  - Focused **14/14** (`hostProjectionMap` + `TaskWraithTui`)
  - Owned non-socket TUI set **33/33** (4 files)
  - Socket / v1 `TaskWraithControlClient` suite **NOT claimed** (`EPERM` gap unchanged)
- **Reviewer deltas:** `@MistralReview` / `@GrokReview` / `@K3Review` — static delta **PASS**; no Wave 3 reopen.
- **Live Host v2 discovery:** **not observed** (see critical distinction). In-process Fake Host v2 happy path only.
- **Marker:** CursorWork courtesy fence dropped with Cap commit.
- **AC1–6 after land:** still **PARTIAL** — TUI now projects read-only over Host; Desktop/iOS still **zero**. Never PASS.

### Host process / AC1–6 expectation (binding)

**Host process wiring in main: ON** (`b45d4297f`).  
**Host process observed running: NO** (zero `taskwraith-host-v2.json`; stale pre-R4' app).

**AC1–6: PARTIAL — never write PASS** (`host-arc-r4prime-does-NOT-pass-ac1-6`, updated after 4.2a):

- Process half (wiring): **yes**.
- Process half (observed boot): **no**.
- Client projections: **TUI read-only yes** (`20a775d96`); Desktop / paired-iOS **still zero**.
- TUI commands over Host: **not yet** (4.2b).

### Typecheck evidence convention (corrected — binding)

**Do not quote “131 TS6307”, “134 total”, or any total-count typecheck figure.** Real `npm run typecheck:node` emits **ZERO** `TS6307` and a small, churning set of **foreign** errors. Required form: path-scoped — **zero error lines matching the owned path**, via the package.json script only (`host-arc-typecheck-131-ts6307-was-an-artefact`).

**Wave 4 / TUI — use `npm run typecheck:tui`.** `typecheck:node` **cannot see** `src/tui/**` (`tsconfig.node.json` include is main/preload/vite only). Zero `typecheck:node` errors naming `src/tui/` is **vacuous** for every possible TUI file (`host-arc-tui-needs-typecheck-tui-not-node`). Every Wave 4 handoff and adopt **must name which typecheck project it ran**.

### Do not score a live lane (binding)

Authority on a lane’s readiness is the **owner’s handoff only**. Scouts reading a moving target report *in flight, with a timestamp*, not a green/red verdict (`host-arc-do-not-score-a-live-lane`). Cap adopts only on owner handoff + Cap’s own live re-run.

### WAVE 6 — HostLocalServer socket-suite GOAL-COMPLETION BLOCKER

**Still open.** `HostLocalServer` unix-socket listen tests have **never** run green in an environment that permits listen. Cap correctly disclosed `EPERM` on every substrate adopt and on 4.2a. That does **not** scale to goal completion (`host-arc-socket-epern-validation-gap`).

**4.2a nuance:** Fake Host v2 over **TCP loopback** exercises client logic only. It is **not** unix-socket proof and **does not** narrow this gap. A future successful live connection to a post-R4' Host may produce **happy-path** evidence only — say *"happy path proven live, error paths still unrun"* — **never** *"socket gap closed"*.

Any adopt that cites a host-suite count **must** state whether socket tests ran, skipped, or failed.

### WAVE 4 sequencing (binding) — `host-arc-wave4-sequencing-ruling`

**Order: TUI → Desktop → iOS.**

| Slice | Status | Owner | Scope |
|---|---|---|---|
| **4.1** `HostProjectionClient` | ✅ LANDED `9c31bd54f` | `@CursorWork` | Authenticated v2 wire client |
| **4.2a** TUI read-only projection | ✅ **LANDED** `20a775d96` | `@CursorWork` / `@GrokCapt` | Connect via `HostProjectionClient`, one `HostSnapshot`, map to TUI render model. Commands blocked. v1 retained unused on live path. `src/tui/**` only. |
| **4.2b** TUI command cutover | 🔄 **ACTIVE** | `@CursorWork` | Same `HostProjectionClient` — expand capabilities (`commands`/`receipts`). **Deferred-approval model is load-bearing:** mutations return PENDING/deferred + challenge, not `succeeded`. Surface Host asks; resolve via receipt poll/lookup. **Never** present deferred as completed. Do **not** reintroduce parallel v1 mutation socket. Evidence: `typecheck:tui` + focused + owned non-socket TUI. |
| **4.3–4.4** Desktop projection | NOT STARTED | TBD | Hard problem; App.tsx forbidden for domain logic |
| **4.5+** paired iOS | NOT STARTED | TBD | Separate E2EE / relay stack |

### `index.ts` staging RULE (not a window status)

**Do not treat any prior clean/dirty reading as current** (`host-arc-window-is-instantaneous`).

**Operative form after R4'** (`host-arc-r4prime-staging-rule-restated`): when staging an `index.ts` hunk, the same-breath `git diff --stat -- src/main/index.ts` must show **ONLY OUR HUNK** — not empty-while-our-hunk-exists. Empty was correct only before the hunk existed. Ordinary exact-path staging when the diff is Host-only. Private-index (`GIT_INDEX_FILE`) is last resort and **must** be followed by shared-index resync. `git add -p` remains invalid.

**This paperwork pass:** `git diff --stat -- src/main/index.ts` ⇒ **EMPTY** (measured earlier this lane; re-check before any stage). Host wiring lives in **HEAD** (`b45d4297f`). That is a measurement, not a durable window claim.

### Live-suite routing (binding)

Review seats `@GrokReview` / `@K3Review` are read-clamped and have **no shell**. Live `vitest` / `typecheck:tui` / `typecheck:node` at adopt = shell-capable seat (typically `@GrokCapt`). Static delta only on shell-less seats (`host-arc-review-seats-have-no-shell`).

---

## Lessons (short — for the next fresh context)

1. **One owner per gate**, declared exclusive at dispatch — after the Gate 2 dual-author collision.
2. **The clean `index.ts` window is instantaneous**, never a durable fact — re-measure in the same breath as stage.
3. **Check a seat can perform an action before routing it there** — live-suite runs were routed at shell-less seats for two passes.
4. **R4' does not PASS AC1–6** — process wiring only; client projections are Wave 4; observed boot is separate.
5. **Staging rule: ONLY OUR HUNK**, not empty — empty-while-hunk-exists is a self-block.
6. **`typecheck:node` cannot see `src/tui`** — Wave 4 uses `typecheck:tui`; name the project.
7. **Do not score a live lane** — only the owner’s handoff is adopt authority.
8. **“Host ON” ≠ Host booted** — zero `taskwraith-host-v2.json` until a post-R4' binary actually runs.

---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits. This table lists **arc-owned commits only** — run `git log --oneline -1` for current HEAD.

```text
20a775d96  feat(tui): project Host snapshots into the TUI (Wave 4.2a)                   (@CursorWork authored; @GrokCapt adopted; FIRST CLIENT PROJECTION)
b45d4297f  feat(host): wire production Host bootstrap into Electron main (R4')          (@SolWork authored; @GrokCapt adopted; WAVE 3 CLOSE)
80b1284c5  feat(host): add stable per-install host identity (Wave 3.6e)                 (@GrokWork authored; @GrokCapt adopted)
a12f2840a  feat(host): add production bootstrap composition (Wave 3.6c)                  (@GrokCapt adopted; GATE 2)
18ec305f9  feat(host): add production authority evaluator (Wave 3.6d)                    (@GrokCapt adopted; GATE 1)
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

**Concurrent-session foreign commits** are present above, below, and interleaved with the arc commits. Re-`git log` before citing HEAD.

---

## Gate-2 / Gate-3 Closure Evidence (historical Wave-2E / 3.4 closures)

### Gate-2 (host-core formal closure) — PASS

- `167f6916b`, `08fba66a9`, `24d2c876f` exact-path scope checks completed; no forbidden paths in scope.
- Quorum signatures: adversarial + final validation + static + Boss live-item (f).

### Gate-3 (post-adoption 3.4 + Ruling-C static closure) — PASS

- `host-arc-gate3-k3review` posted as final validation static pass.
- `516ec6a77` adoption evidence: exact-pair commit only.
- `5a0761793` and `6a6b2cc4c` complete Ruling-C and clear arc-owned typecheck debt.

---

## Wave 3 — Closed Detail

### What's done (committed)

- ✅ Host v2 protocol transport, session, authority, deferred stack, projection substrate, local server, and production composition.
- ✅ 3.4 (`HostMainComposition`) and 3.5 (`HostSupervisor`) landed and adopted.
- ✅ Scope-4 **S4a** / **S4b** / **S4c** all landed.
- ✅ **3.6a** `pipelineFactory` seam (`ab7c2609b`) and **4.1** `HostProjectionClient` (`9c31bd54f`) adopted.
- ✅ **3.6b** `HostProductionSuppliers` fix (`e5366dbd2`).
- ✅ **W36-S2** / **W5-S1** deferred round-trip and restart-recovery tests.
- ✅ **GATE 1 — 3.6d** @ `18ec305f9`
- ✅ **GATE 2 — 3.6c** @ `a12f2840a` (socket suite **did not run** at adopt)
- ✅ **GATE 3.6e — `HostInstallIdentity`** @ `80b1284c5`
- ✅ **R4' — `index.ts` wiring** @ `b45d4297f` — Host process **wiring ON** in main (boot **not** observed)

### Wave 4 progress (committed)

- ✅ **4.2a — TUI read-only projection** @ `20a775d96` — first client projection in HEAD

### What remains (post–4.2a)

| Item | Owner | Status |
|---|---|---|
| **Wave 4.2b — TUI commands over Host** | `@CursorWork` | **ACTIVE** (Boss locked-writer fan-out). Deferred-approval receipt UX is the load-bearing problem. Validated handoff to Cap; **nobody commits from work seats.** |
| **Wave 4.3+** Desktop / iOS cutovers | `@SolBoss` sequencing | After 4.2b / Boss assignment |
| **Ops — restart post-R4' app** | user / Cap | Needed before any live `taskwraith-host-v2.json` evidence |
| **Wave 5 — `.twmission` / AC9** | `@SolBoss` | **NOT STARTED** |
| **Wave 6 — adversarial + socket suite** | `@SolBoss` | **NOT STARTED**; socket suite remains goal-completion blocker |

### Marker hygiene (this paperwork measurement)

| Marker | Parse | Effective claim |
|---|---|---|
| `.WORK-IN-PROGRESS-host-arc-wave36d-evaluator.md` | **Absent** | n/a (Gate 1 landed) |
| `.WORK-IN-PROGRESS-host-arc-wave36c-bootstrap.md` | **Absent** | n/a (Gate 2 landed) |
| `.WORK-IN-PROGRESS-host-arc-install-identity.md` | **Absent** | n/a (3.6e landed) |
| `.WORK-IN-PROGRESS-host-arc-r4prime-index-wiring.md` | **Absent** | n/a (R4' landed) |
| `.WORK-IN-PROGRESS-host-arc-wave42a-tui-projection.md` | **Absent** | n/a (4.2a landed; Cap dropped fence) |

Foreign markers present (not Host Arc): `.WORK-IN-PROGRESS-observatory-gpu-calm.md`, `.WORK-IN-PROGRESS-seat-strip-desktop.md`, `.WORK-IN-PROGRESS-tool-event-dual-lane-dedupe.md`.

`@SparkDocs` note: this Cursor seat has **`TASKWRAITH_LOCK_OWNER_ID` absent** and no stable long-lived host pid; **no docs marker raised** (a no-identity marker would claim nothing). `docs/HOST_ARC_STATUS.md` was already dirty from this seat’s prior refresh; this pass builds on that dirt only. **Could not measure** live userData discovery files from this seat this pass — accepting Boss blackboard `host-arc-production-host-has-never-actually-run` as the authority for the zero-`taskwraith-host-v2.json` claim.

### R5 — Evaluator Sourcing (DURABLE — unchanged; Gate 1 landed)

- **C1:** Allow-all forbidden in production (fixture-only in composition tests)
- **C2:** Translate existing authority; never invent policy
- **C3:** No existing authority ⇒ `deferred` + typed `challengeKind`, never `allowed`
- **C4:** Enumerate the real **10** `HostCommandName` values (no `health.get`)
- **C5:** `clientClass` ordering — `ios` never more permissive than `desktop`
- **C6:** Untypeable deferral fails closed
- **C7:** Report gaps honestly; do not invent rules

Ten names: `snapshot.get`, `deltas.since`, `receipt.lookup`, `ping`, `approval.decide`, `question.answer`, `composer.send`, `run.cancel`, `ensemble.seat.toggle`, `thread.select`.

---

## Acceptance Criteria (current status)

| AC | Status | Note |
|---|---|---|
| AC1–AC6 | ⚠️ **PARTIAL** | Host **wiring** ON in main (`b45d4297f`). Production Host **never observed running** (zero `taskwraith-host-v2.json`). TUI projects read-only (`20a775d96`); Desktop/iOS still zero; TUI commands still 4.2b. Socket-path unit suite still never run — goal-closeout blocker. Fake Host v2 ≠ socket gap closed. **Never PASS.** |
| AC7–AC8 | ⚠️ PARTIAL | Host core authoritative; TUI is first projection client (read-only); Desktop/iOS still legacy |
| AC9 | ❌ **NOT STARTED** | `.twmission` / mission evidence not started (Wave 5) |
| AC10–AC11 | ⚠️ PARTIAL | TUI read projection live in HEAD; Desktop/iOS cutovers not started; TUI commands not cut over |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | Path-scoped evidence only; Wave 4 must use `typecheck:tui` for `src/tui/**` |
| AC15 | ✅ PASS | No forbidden path drift in scoped arc handoffs (4.2a exact-path five files) |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain) · `@K3Review` (final validation gate)

**Aliases:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Commits are exact-path only; markers with honest live pid **or** `lockOwnerId` and adopter-window expiry; drop on adopt. Workers leave validated handoffs; Cap commits post-review. **One owner per gate.** Live suite at adopt = shell-capable seat. **Nobody commits from work seats on the current 4.2b fan-out** — validated handoff to `@GrokCapt`. Scouts do not score live lanes.

---

## Forbidden Paths (zero diff)

- `src/main/workLocks/**`, `WorkspaceLock*`, `WorkspaceMutationClaims*`
- `src/main/workProvenance/**`, workspace-lock marker/provenance behavior
- `scripts/work-guard*`, `.githooks/**`
- Provider admission / retirement / live membership / security ceilings
- Unrelated history-deletion machinery
- Composition roots (`index.ts`, `App.tsx`, `EnsembleOrchestrator.ts`) — tiny wiring hunks only, with Boss/Cap clearance (R4' already landed under that rule)

---

## Foreign Dirt (do not touch)

Snapshot at this paperwork pass (`git status --porcelain`). Re-check before staging. **Not an `index.ts` window claim.**

**Arc-owned (uncommitted):**
- ` M docs/HOST_ARC_STATUS.md` (this paperwork lane)

**Foreign / other-session (illustrative — re-measure before acting):**
- `electron.vite.config.ts`, `src/main/store/{index,PersistenceWriteWorker*,persistenceDurability*,persistenceWriteBaseline*}`, `src/main/workers/persistenceWriteWorker.ts` — **not Host Arc scope**

`src/main/index.ts`, `src/main/host/`, and `src/tui/**` measured **clean** at Cap’s 4.2a land (committed). Exact-path staging only — never `git add -A` / `git add .` / `commit -a`.

---

## Next actions (paperwork view)

1. `@CursorWork` — Wave **4.2b** TUI commands over Host (`src/tui/**` only); deferred-approval receipt UX; same client (no parallel v1 socket); `typecheck:tui` + focused + owned non-socket; TCP Fake Host ≠ unix-socket proof; validated handoff to Cap; **no commit**.
2. `@GrokCapt` — adopt 4.2b when owner hands off green; exact-path; disclose socket vs non-socket; drop worker marker with commit. Docs land with or after that adopt is fine.
3. `@K3Review` / `@GrokReview` / `@MistralReview` — delta-only on Cap land of 4.2b; no Wave 3 / 4.2a reopen.
4. Ops / user — restart a **post-R4'** TaskWraith binary before treating live Host discovery as expected.
5. Wave 6 / goal closeout — HostLocalServer socket suite in an environment that permits unix-socket listen; Fake Host / future happy-path live evidence is additive, not a substitute.
6. `@SparkDocs` — refresh again after 4.2b SHA lands (or Cap adopts docs with that land).

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits.
- QA remains with user.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-wave3-closed-four-shas`, `host-arc-wave4-sequencing-ruling`, `host-arc-r4prime-adopt-authorized`, `host-arc-r4prime-does-NOT-pass-ac1-6`, `host-arc-r4prime-k3review-delta-pass`, `host-arc-r4prime-staging-rule-restated`, `host-arc-r4prime-hunk-content-ruling`, `host-arc-three-shas-confirmed-by-boss`, `host-arc-hostid-ruling`, `host-arc-typecheck-131-ts6307-was-an-artefact`, `host-arc-tui-needs-typecheck-tui-not-node`, `host-arc-do-not-score-a-live-lane`, `host-arc-production-host-has-never-actually-run`, `host-arc-socket-epern-validation-gap`, `host-arc-window-is-instantaneous`, `host-arc-review-seats-have-no-shell`, `host-arc-stop-reverifying-the-four`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures byte-verified against live git + markers at time of writing · **not committed** this pass.
