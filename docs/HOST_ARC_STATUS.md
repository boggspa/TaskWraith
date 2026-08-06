# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@GrokCapt` (Cap post-adopt stamp — records Cap SHAs `b74b33e33` / `78b3845ed` + SparkDocs one-field ruling text; docs only)  
**Last updated:** 2026-08-06T14:30Z continuous round  
**HEAD (at time of writing):** `78b3845ed` — churns under concurrent foreign sessions; verify with `git log --oneline -1` before acting  
**Docs SHA (Cap exact-path):** pending this commit — prior docs `afc48289a`  
**Branch ahead of origin/master:** ~412 (moving)  
**Overall completeness:** **Wave 3 CLOSED** — four SHAs (`18ec305f9`, `a12f2840a`, `80b1284c5`, `b45d4297f`). **Wave 4.2a LANDED** `20a775d96`. **Wave 4.2b LANDED** `9b48bec48`. **Wave 4.2c LANDED** `b74b33e33` (one-field `commandId` on approval). **Wave 4.3a pure LANDED** `78b3845ed` (injected transport; no live IPC). AC1–6 **PARTIAL** (TUI read+command + Desktop pure in HEAD; live Desktop needs **4.3a-wire**; iOS still zero; production Host **STILL never observed running**). Wave **4.3a-wire** — **AUTHORISED / in flight** (`@SolWork`). AC9 **NOT STARTED**. Socket suite still never run (goal-completion blocker).

---

## ⚠ CRITICAL DISTINCTION — “Host is ON” ≠ “Host has booted”

**PRODUCTION HOST HAS NEVER BEEN OBSERVED RUNNING** (`host-arc-production-host-has-never-actually-run`, measured by `@SolBoss`).

| Claim people will misread | What is actually true |
|---|---|
| “Host is ON” | **Wiring is committed** in Electron main (`b45d4297f`). `createHostProductionBootstrap` + `start().catch(...)` + `stopSync` exist in **HEAD** `index.ts`. |
| “Host has booted / is listening” | **Not observed.** Zero `taskwraith-host-v2.json` discovery files exist on this machine (prod + TaskWraith Dev userData searched). Running TaskWraith.app started **~2h11m before R4' landed** — it is a **stale binary** that predates Host wiring. Cause (a) stale process, not cause (b) `start()` failing into the logged catch. |
| TUI Fake Host v2 green | **Client-path evidence over TCP loopback** in-process. Proves connect → snapshot → (4.2b) command submit / receipt poll / deferred ask. **Does not** prove unix-socket listen, live production Host, or narrow the `EPERM` socket-suite gap. |

Do **not** inherit the stronger claim by accident in a fresh context. Restart / rebuild of a post-R4' binary is an ops follow-up, not a 4.2a/4.2b code defect.

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery |
| **Wave 2E-2B** (Deferred allow + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split @ `aceb0993a`; `HostDeferredAllowPipeline` @ `9d4a2a104`; micro-fix @ `167f6916b` |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` | `joinFor` cleanup @ `5a0761793`; Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | ✅ **CLOSED** | `@SolBoss` / `@GrokCapt` | Substrate + Gates 1/2/3.6e + R4' wiring all committed. Host **wiring ON** in main. AC1–6 → **PARTIAL** (not PASS). Production Host **never observed running**. |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | 🔄 **ACTIVE** — 4.3a-wire | `@SolBoss` / `@SolWork` / `@GrokCapt` | Order ruled **TUI → Desktop → iOS**. **4.2a** `20a775d96` + **4.2b** `9b48bec48` + **4.2c** `b74b33e33` + **4.3a pure** `78b3845ed` **LANDED**. **4.3a-wire** **AUTHORISED / in flight** (IPC + one `index.ts` registration). **4.3b** unlocked by 4.2c Cap land (sequencing still Boss-owned). |
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
  - Commands blocked with read-only notice until **4.2b** (now **LANDED** `9b48bec48`)
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

### WAVE 4.2b — TUI commands + deferred receipts — **LANDED**

- **SHA:** `9b48bec48` — `feat(tui): route TUI mutations through Host with deferred receipts (Wave 4.2b)`
- **Author:** `@CursorWork` · **Adopter:** `@GrokCapt`
- **Boss clearance:** `host-arc-42b-adopt-authorized-plus-approvalid-ruling` · B1/B2/B3 adjudicated resolved (`host-arc-42b-b1b2b3-resolved-adjudicated`)
- **Paths (exact-path seven only):**
  - `src/tui/hostCommandFlow.ts` (new)
  - `src/tui/hostCommandFlow.test.ts` (new)
  - `src/tui/TaskWraithTui.ts`
  - `src/tui/TaskWraithTui.test.ts`
  - `src/tui/state.ts`
  - `src/tui/render.ts`
  - `src/tui/cli.ts`
- **Excluded from land (foreign):** persistence workers under `src/main/store/` / `src/main/workers/`, `electron.vite.config.ts` — Cap did not stage them.
- **What landed:**
  - Same `HostProjectionClient` with `capabilities: ['bootstrap', 'snapshot', 'health', 'commands', 'receipts']` — **no** parallel v1 mutation socket
  - Mutations: `thread.select` / `composer.send` / `run.cancel` / `ensemble.seat.toggle` → `submitCommand` + receipt poll
  - **Receipt mechanism:** poll `lookupReceipt({ commandId })` with bounded backoff (200ms → 1.5s, 60s cap); after first pending/`authority.ask`, refresh snapshot once to bind the Host approval card; **y/n** → `approval.decide`
  - Pending / `authority.ask` **never** painted as succeeded (`describeHostReceipt` + TUI test pin)
  - v1 `TaskWraithControlClient` retained in tree; **not** the live interactive path; **not** retired
- **Cap evidence (shell seat — binding):**
  - `npm run typecheck:tui` — **exit 0** (correct project)
  - Owned non-socket TUI set **38/38** (5 files: `hostCommandFlow`, `TaskWraithTui`, `hostProjectionMap`, `render`, `theme`)
  - Socket / v1 suite **NOT claimed** (`EPERM` gap unchanged)
- **Reviewer deltas:** `@MistralReview` / `@GrokReview` / `@K3Review` — static delta **PASS**; no Wave 3 / 4.2a reopen.
- **Live Host v2 discovery:** **not observed** (see critical distinction). TCP Fake Host v2 allow+defer = client-path only.
- **Markers:** CursorWork courtesy fence + Cap adopt fence **dropped** with land.
- **AC1–6 after land:** still **PARTIAL** — TUI read **and** command paths in HEAD; Desktop/iOS still **zero**. Never PASS.
- **Carried into 4.2c / 4.3 (not 4.2b blockers — status at this refresh):**
  - At 4.2b land the wire had **no** correlation field either direction (`host-arc-approval-correlation-is-a-protocol-gap`) — TUI used `actionKind` scan
  - **4.2c binding ruling (supersedes two-field preference):** **ONE field only** — required `commandId` on `HostApprovalProjection`; explicitly **NO** `approvalId` on `HostCommandReceipt` (`host-arc-42c-one-field-grokwork-contest-upheld`). Reason: `commandId` is a **join key** (client already knows its own command id); receipt store has **no** challenge link, so direction B would cost a durable schema migration for a saved refresh, not a correctness property
  - Exact correlation is **Wave 4.2c** (protocol) and a **hard prerequisite of 4.3b**; **not** of 4.3a read-only / 4.3a-wire

### Host process / AC1–6 expectation (binding)

**Host process wiring in main: ON** (`b45d4297f`).  
**Host process observed running: NO** (zero `taskwraith-host-v2.json`; stale pre-R4' app).

**AC1–6: PARTIAL — never write PASS** (`host-arc-r4prime-does-NOT-pass-ac1-6`, updated after 4.2b):

- Process half (wiring): **yes**.
- Process half (observed boot): **no**.
- Client projections: **TUI read** (`20a775d96`) + **TUI commands** (`9b48bec48`); Desktop / paired-iOS **still zero**.
- Approval correlation on the wire: **authored + handed off** (4.2c — Cap adopt pending; suite must include Boss-cleared shared fixture one-liners).
- Desktop read-only pure layer: **authored + handed off** (4.3a — Cap adopt pending). Live Desktop snapshot still needs **4.3a-wire**.

### Typecheck evidence convention (corrected — binding)

**Do not quote “131 TS6307”, “134 total”, or any total-count typecheck figure.** Real `npm run typecheck:node` emits **ZERO** `TS6307` and a small, churning set of **foreign** errors. Required form: path-scoped — **zero error lines matching the owned path**, via the package.json script only (`host-arc-typecheck-131-ts6307-was-an-artefact`).

**Wave 4 / TUI — use `npm run typecheck:tui`.** `typecheck:node` **cannot see** `src/tui/**` (`tsconfig.node.json` include is main/preload/vite only). Zero `typecheck:node` errors naming `src/tui/` is **vacuous** for every possible TUI file (`host-arc-tui-needs-typecheck-tui-not-node`). Every Wave 4 handoff and adopt **must name which typecheck project it ran**.

### Do not score a live lane (binding)

Authority on a lane’s readiness is the **owner’s handoff only**. Scouts reading a moving target report *in flight, with a timestamp*, not a green/red verdict (`host-arc-do-not-score-a-live-lane`). Cap adopts only on owner handoff + Cap’s own live re-run.

### WAVE 6 — HostLocalServer socket-suite GOAL-COMPLETION BLOCKER

**Still open.** `HostLocalServer` unix-socket listen tests have **never** run green in an environment that permits listen. Cap correctly disclosed `EPERM` on every substrate adopt and on 4.2a/4.2b. That does **not** scale to goal completion (`host-arc-socket-epern-validation-gap`).

**4.2a/4.2b nuance:** Fake Host v2 over **TCP loopback** exercises client logic only (including deferred command/receipt paths after 4.2b). It is **not** unix-socket proof and **does not** narrow this gap. A future successful live connection to a post-R4' Host may produce **happy-path** evidence only — say *"happy path proven live, error paths still unrun"* — **never** *"socket gap closed"*.

Any adopt that cites a host-suite count **must** state whether socket tests ran, skipped, or failed.

### WAVE 4 sequencing (binding) — `host-arc-wave4-sequencing-ruling` + `host-arc-42c-slice-and-refined-43-gate`

**Order: TUI → Desktop → iOS.**

| Slice | Status | Owner | Scope |
|---|---|---|---|
| **4.1** `HostProjectionClient` | ✅ LANDED `9c31bd54f` | `@CursorWork` | Authenticated v2 wire client |
| **4.2a** TUI read-only projection | ✅ **LANDED** `20a775d96` | `@CursorWork` / `@GrokCapt` | Connect via `HostProjectionClient`, one `HostSnapshot`, map to TUI render model. Commands blocked. v1 retained unused on live path. `src/tui/**` only. |
| **4.2b** TUI command cutover | ✅ **LANDED** `9b48bec48` | `@CursorWork` / `@GrokCapt` | Same client + `commands`/`receipts`. Deferred-receipt poll; pending ≠ succeeded; y/n → `approval.decide`. No parallel v1 mutation socket. Evidence: `typecheck:tui` + 38/38 owned non-socket. |
| **4.2c** Approval correlation (protocol) | ✅ **LANDED** `b74b33e33` | `@GrokWork` / `@GrokCapt` | **ONE field only** (`host-arc-42c-one-field-grokwork-contest-upheld`): required `commandId` on `HostApprovalProjection`; **NO** `approvalId` on `HostCommandReceipt`. Cap evidence: `typecheck:node` + `typecheck:tui` exit 0 (owned clean); owned non-socket **103/103** across protocol/host/TUI files; dual same-`actionKind` RED-proof + decode reject pin + composition publish pin. Exact-path **10 files**. |
| **4.3a** Desktop read-only **pure** layer | ✅ **LANDED** `78b3845ed` | `@SolWork` / `@GrokCapt` | Injected `HostProjectionTransport { fetchSnapshot() }` — mapper/store/hook + honesty pins (cached ≠ live, unavailable ≠ zero, no empty fabricate). **No** live Host / preload / `index.ts` in this SHA. Cap evidence: `typecheck:web` owned clean; **24/24**. Exact-path **5 files**. |
| **4.3a-wire** Desktop IPC bridge | 🔄 **AUTHORISED / in flight** | `@SolWork` | Boss carve-out (`host-arc-43a-cleared-and-wire-carveout-granted`): `src/main/ipc/hostProjectionHandlers.ts` (+ test) + thin `src/preload/index.ts` + **exactly one** `src/main/index.ts` registration under R4' discipline. Still **read-only**. Evidence must name **both** `typecheck:node` **and** `typecheck:web`. |
| **4.3b** Desktop command cutover | NOT STARTED | TBD | **Unblocked** by Cap-landed 4.2c (`b74b33e33`); sequencing still Boss-owned. |
| **4.4+** Retire AppStore-as-authority / paired iOS | NOT STARTED | TBD | Separate slices |

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
9. **`typecheck:web` for renderer** — Desktop slices must name the web project; node/tui cannot see `src/renderer/**` meaningfully for this gate.
10. **Approval correlation is ONE field** — required `commandId` on approval projection; no `approvalId` on receipt (join key suffices; receipt has no challenge link). 4.3a read-only / 4.3a-wire ungated; 4.3b mutations hard-gated on Cap-landed 4.2c.
11. **`typecheck:web` vs preload** — `tsconfig.web.json` includes only `src/preload/*.d.ts`; preload `.ts` is covered by `typecheck:node`. Wire slices spanning preload need **both** projects.

---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits. This table lists **arc-owned commits only** — run `git log --oneline -1` for current HEAD.

```text
afc48289a  docs(host): record Wave 4.2b land and active 4.2c/4.3a lanes                 (@SparkDocs; @GrokCapt adopted)
9b48bec48  feat(tui): route TUI mutations through Host with deferred receipts (Wave 4.2b) (@CursorWork authored; @GrokCapt adopted)
4cb932c31  docs(host): record Wave 4.2a land and Host-never-run ops gap                  (@SparkDocs; @GrokCapt adopted)
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
- ✅ **4.2b — TUI commands + deferred receipts** @ `9b48bec48` — same client; pending ≠ succeeded; y/n → `approval.decide`
- ✅ **Docs catch-up (4.2a / Host-never-run)** @ `4cb932c31`
- ✅ **Docs catch-up (4.2b / active 4.2c·4.3a)** @ `afc48289a`

### What remains (post–4.2b / post–docs `afc48289a`)

| Item | Owner | Status |
|---|---|---|
| **Wave 4.2c — approval correlation (protocol)** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `b74b33e33` — one-field `commandId` on approval; Cap live evidence named. |
| **Wave 4.3a — Desktop read-only pure layer** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `78b3845ed` — injected transport; no live Host in this SHA. |
| **Wave 4.3a-wire — IPC + one `index.ts` line** | `@SolWork` | 🔄 **AUTHORISED / in flight** under composition-root carve-out. R4' discipline. Still read-only. Cap adopt later, separate SHA. |
| **Wave 4.3b — Desktop commands** | `@SolBoss` sequencing | **Unblocked** by 4.2c Cap land; not started. |
| **Ops — restart post-R4' app** | user / Cap | Needed before any live `taskwraith-host-v2.json` evidence — **Host STILL never observed running** |
| **Wave 5 — `.twmission` / AC9** | `@SolBoss` | **NOT STARTED** |
| **Wave 6 — adversarial + socket suite** | `@SolBoss` | **NOT STARTED**; socket suite remains goal-completion blocker |

### Marker hygiene (this paperwork measurement)

| Marker | Parse | Effective claim |
|---|---|---|
| `.WORK-IN-PROGRESS-host-arc-wave36d-evaluator.md` | **Absent** | n/a (Gate 1 landed) |
| `.WORK-IN-PROGRESS-host-arc-wave36c-bootstrap.md` | **Absent** | n/a (Gate 2 landed) |
| `.WORK-IN-PROGRESS-host-arc-install-identity.md` | **Absent** | n/a (3.6e landed) |
| `.WORK-IN-PROGRESS-host-arc-r4prime-index-wiring.md` | **Absent** | n/a (R4' landed) |
| `.WORK-IN-PROGRESS-host-arc-wave42a-tui-projection.md` | **Absent** | n/a (4.2a landed) |
| `.WORK-IN-PROGRESS-host-arc-wave42b-tui-commands.md` | **Absent** | n/a (4.2b landed; Cap dropped fence) |
| `.WORK-IN-PROGRESS-host-arc-wave42c-approval-correlation.md` | **Present** (GrokWork) | Courtesy fence — `pid: 4902` shared host; **`TASKWRAITH_LOCK_OWNER_ID` absent**; expires may have lapsed — owners must re-stamp; Cap does not treat as enforceable adopt claim |
| `.WORK-IN-PROGRESS-host-arc-wave43a-desktop-projection.md` | **Present** (SolWork) | Same class — courtesy fence / decayed shared pid; re-stamp before further edits |

Foreign markers present (not Host Arc): `.WORK-IN-PROGRESS-observatory-gpu-calm.md`, `.WORK-IN-PROGRESS-seat-strip-desktop.md`, `.WORK-IN-PROGRESS-tool-event-dual-lane-dedupe.md`.

`@SparkDocs` note: this Cursor seat has **`TASKWRAITH_LOCK_OWNER_ID` absent** and no stable long-lived seat pid; **no docs marker raised** (a no-identity marker would claim nothing). **Could not re-measure** live userData discovery this pass — accepting Boss blackboard `host-arc-production-host-has-never-actually-run` as authority that production Host is **STILL never observed running**. Cap live suite for 4.2c/4.3a **not** claimed here.

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
| AC1–AC6 | ⚠️ **PARTIAL** | Host **wiring** ON in main (`b45d4297f`). Production Host **STILL never observed running** (zero `taskwraith-host-v2.json`). TUI read (`20a775d96`) + TUI commands (`9b48bec48`); Desktop pure layer handed off (Cap adopt pending); live Desktop needs 4.3a-wire; iOS still zero. Socket-path unit suite still never run — goal-closeout blocker. Fake Host v2 ≠ socket gap closed. **Never PASS.** |
| AC7–AC8 | ⚠️ PARTIAL | Host core authoritative; TUI is first full (read+command) projection client; Desktop/iOS still legacy |
| AC9 | ❌ **NOT STARTED** | `.twmission` / mission evidence not started (Wave 5) |
| AC10–AC11 | ⚠️ PARTIAL | TUI read+command paths live in HEAD; Desktop pure (4.3a) handed off; 4.3a-wire authorised; Desktop commands / iOS not started |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | Path-scoped evidence only; Wave 4 TUI uses `typecheck:tui`; Desktop pure uses `typecheck:web`; wire/preload needs **node+web**; protocol slice needs **node+tui** |
| AC15 | ✅ PASS | No forbidden path drift in scoped arc handoffs (4.2b exact-path seven files; docs `afc48289a` exact-path) |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain) · `@K3Review` (final validation gate)

**Aliases:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Commits are exact-path only; markers with honest live pid **or** `lockOwnerId` and adopter-window expiry; drop on adopt. Workers leave validated handoffs; Cap commits post-review. **One owner per gate.** Live suite at adopt = shell-capable seat. **Nobody commits from work seats on the current 4.2c / 4.3a fan-out** — validated handoff to `@GrokCapt`. Scouts do not score live lanes.

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

**Arc-owned (uncommitted — Cap adopts separately):**
- ` M docs/HOST_ARC_STATUS.md` (this paperwork lane — one-field correction)
- 4.2c / 4.3a code paths dirty under worker markers — **Cap exact-path only**; exclude foreign persistence dirt

**Foreign / other-session (illustrative — re-measure before acting):**
- `electron.vite.config.ts`, `src/main/store/{index,PersistenceWriteWorker*,persistenceDurability*,persistenceWriteBaseline*}`, `src/main/workers/persistenceWriteWorker.ts` — **not Host Arc scope**

Exact-path staging only — never `git add -A` / `git add .` / `commit -a`.

---

## Next actions (paperwork view)

1. `@GrokWork` — finish Boss-cleared 4.2c fixture one-liners + K3 pins if still open; re-stamp marker; hand Cap with named `typecheck:node` **and** `typecheck:tui`; **no commit**.
2. `@SolWork` — Cap will adopt **4.3a pure** as its own SHA when ready; meanwhile execute **4.3a-wire** under the granted carve-out (handler first, `index.ts` last, R4' discipline); **no commit**.
3. `@GrokCapt` — adopt **4.2c** and **4.3a pure** as **SEPARATE SHAs** on handoff + Cap live re-run; exact-path; disclose socket vs non-socket; drop worker markers with each land. Docs one-field refresh may land alone or with those adopts.
4. `@K3Review` / `@GrokReview` / `@MistralReview` — delta-only on Cap lands of 4.2c / 4.3a / 4.3a-wire; no Wave 3 / 4.2a / 4.2b reopen.
5. Ops / user — restart a **post-R4'** TaskWraith binary before treating live Host discovery as expected. **Production Host STILL never observed running.**
6. Wave 6 / goal closeout — HostLocalServer socket suite in an environment that permits unix-socket listen; Fake Host / future happy-path live evidence is additive, not a substitute.
7. `@SparkDocs` — refresh again after Cap SHAs for 4.2c / 4.3a / 4.3a-wire land.

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits.
- QA remains with user.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-wave3-closed-four-shas`, `host-arc-wave4-sequencing-ruling`, `host-arc-r4prime-adopt-authorized`, `host-arc-r4prime-does-NOT-pass-ac1-6`, `host-arc-r4prime-k3review-delta-pass`, `host-arc-r4prime-staging-rule-restated`, `host-arc-r4prime-hunk-content-ruling`, `host-arc-three-shas-confirmed-by-boss`, `host-arc-hostid-ruling`, `host-arc-typecheck-131-ts6307-was-an-artefact`, `host-arc-tui-needs-typecheck-tui-not-node`, `host-arc-do-not-score-a-live-lane`, `host-arc-production-host-has-never-actually-run`, `host-arc-socket-epern-validation-gap`, `host-arc-window-is-instantaneous`, `host-arc-review-seats-have-no-shell`, `host-arc-stop-reverifying-the-four`, `host-arc-42b-adopt-authorized-plus-approvalid-ruling`, `host-arc-42b-b1b2b3-resolved-adjudicated`, `host-arc-approval-correlation-is-a-protocol-gap`, `host-arc-42c-slice-and-refined-43-gate`, `host-arc-42c-one-field-grokwork-contest-upheld`, `host-arc-42c-correlation-handoff`, `host-arc-42c-cleared-and-boss-scoping-error`, `host-arc-43a-split-pure-then-wire`, `host-arc-43a-desktop-seam-needs-main-ipc`, `host-arc-43a-cleared-and-wire-carveout-granted`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures byte-verified against live git + markers at time of writing · **not committed** this pass.
