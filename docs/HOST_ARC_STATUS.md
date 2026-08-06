# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (Boss-dispatched docs lane — Cap tip now `1269e3fc7` Wave 4.3c LANDED after 4.4 `402f34e0e`; 4.5 IN FLIGHT unscored; docs only · **not committed**)  
**Last updated:** 2026-08-06T15:20Z continuous round  
**HEAD (at time of writing):** `1269e3fc7` — chain `1269e3fc7` ← `402f34e0e` ← `dc404bf09` ← `21e625daa` ← `8dd6d4d3e` ← `e888d3c87` ← `78b3845ed` ← `b74b33e33`; verify with `git log --oneline -1` before acting  
**Docs SHA (Cap exact-path):** pending Cap adopt of this refresh — prior docs Cap lands `e888d3c87` / `8dd6d4d3e`  
**Branch ahead of origin/master:** ~418 (moving)  
**Overall completeness:** **Wave 3 CLOSED** — four SHAs (`18ec305f9`, `a12f2840a`, `80b1284c5`, `b45d4297f`). **Wave 4.2a** `20a775d96` · **4.2b** `9b48bec48` · **4.2c** `b74b33e33` · **4.3a pure** `78b3845ed` · **4.3a-wire** `21e625daa` · **4.3a-adapter** `dc404bf09` · **Wave 4.4** `402f34e0e` (**LANDED** — Cap exact-path **1** file, `+272/−0`) · **Wave 4.3c** `1269e3fc7` (**LANDED** — Cap exact-path **3** files: provider pair + `main.tsx`; **App.tsx untouched**). Node production composition **boots/serves/stops** under test; Desktop **mounts** the projection provider. **Does NOT** prove Host under Electron; **does NOT** retire AppStore authority. AC1–6 **PARTIAL** (never PASS). Production Host **STILL never observed running under Electron** — zero `taskwraith-host-v2.json`. Wave **4.5** Electron Host observation **IN FLIGHT** (`@GrokWork`) — **do not score**; “ops, not a code slice” was **FALSE** (`scripts/smoke-packaged-electron.cjs` already launches in `ci`). AC9 **NOT STARTED**. Socket suite **CLOSED as seat-specific** (Claude **929/929** across **36** files post-4.4; Cursor Cap may still `EPERM`).

---

## ⚠ CRITICAL DISTINCTION — “Host is ON” ≠ “Host has booted”

**PRODUCTION HOST HAS NEVER BEEN OBSERVED RUNNING** (`host-arc-production-host-has-never-actually-run`, measured by `@SolBoss`).

| Claim people will misread | What is actually true |
|---|---|
| “Host is ON” | **Wiring is committed** in Electron main (`b45d4297f`). `createHostProductionBootstrap` + `start().catch(...)` + `stopSync` exist in **HEAD** `index.ts`. |
| “Host has booted / is listening” | **Not observed.** Zero `taskwraith-host-v2.json` discovery files exist on this machine (prod + TaskWraith Dev userData searched). Running TaskWraith.app started **~2h11m before R4' landed** — it is a **stale binary** that predates Host wiring. Cause (a) stale process, not cause (b) `start()` failing into the logged catch. |
| TUI Fake Host v2 green | **Client-path evidence over TCP loopback** in-process. Proves connect → snapshot → (4.2b) command submit / receipt poll / deferred ask. **Does not** prove live production Host under Electron. |
| Socket suite / `EPERM` | **CLOSED as seat-specific, not environmental** (`host-arc-socket-gap-CLOSED-seat-specific-not-environmental`). Claude seat post-4.4: full `src/main/host/` **929/929** across **36** files **including** sockets (was **923/923** / **35** pre-4.4). Cursor Cap disclosed `EPERM` on 4.4 adopt and **did not claim** the socket run — accepted behaviour. Standing rule: an “environment cannot do X” claim is only environmental after X has been tried on a **different** shell-capable seat. |
| Wave **4.4** Node boot proof green | **LANDED** `402f34e0e`. Proves real `createHostMainComposition` + real `HostLocalServer` boot → serve authenticated snapshot → stop under **Node** (`fs.mkdtemp`). **Not** Electron launch; **not** live `taskwraith-host-v2.json`. |
| “Electron observation is ops, not code” | **FALSE** (`host-arc-electron-observation-is-NOT-ops-a-harness-exists`). `scripts/smoke-packaged-electron.cjs` already launches the packaged app in `ci`; it only never asserted Host discovery. Wave **4.5** closes that hole in code — **IN FLIGHT**, unscored. |

Do **not** inherit the stronger claim by accident in a fresh context. Wave 4.4 green under Node ≠ Host under Electron. Live Electron discovery remains unobserved until Wave 4.5 (or an equivalent post-R4' launch) produces evidence.

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery |
| **Wave 2E-2B** (Deferred allow + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split @ `aceb0993a`; `HostDeferredAllowPipeline` @ `9d4a2a104`; micro-fix @ `167f6916b` |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` | `joinFor` cleanup @ `5a0761793`; Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | ✅ **CLOSED** | `@SolBoss` / `@GrokCapt` | Substrate + Gates 1/2/3.6e + R4' wiring all committed. Host **wiring ON** in main. AC1–6 → **PARTIAL** (not PASS). Production Host **never observed running**. |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | 🔄 **ACTIVE** — 4.5 | `@SolBoss` / `@SolWork` / `@GrokCapt` / `@GrokWork` | Order ruled **TUI → Desktop → iOS**. **4.2a–c** + **4.3a pure/wire/adapter** + **4.4** `402f34e0e` + **4.3c** `1269e3fc7` **LANDED**. Desktop mounts HostProjectionProvider (`main.tsx` wrap; App.tsx untouched; AppStore authority **not** retired). **4.5** Electron Host observation **IN FLIGHT** (unscored). **4.3b** unlocked by 4.2c; sequenced after live Host observation. |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 progress; AC9 still NOT STARTED |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Socket **unit** gap closed (seat-specific). Still blocked by Waves 3–5 + **live Electron Host observation** (Wave 4.5 in flight) + remaining adversarial gates |

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

**AC1–6: PARTIAL — never write PASS** (`host-arc-r4prime-does-NOT-pass-ac1-6`, updated after Wave 4.4 land):

- Process half (wiring): **yes**.
- Process half (Node production composition boot under test): **yes** — Wave **4.4** `402f34e0e` (real composition + real server; BOOT → SERVE → STOP).
- Process half (observed boot under Electron): **no** — zero `taskwraith-host-v2.json` on the machine; production Host **STILL never observed running under Electron**. Wave **4.5** is the code path to close this — **IN FLIGHT**, unscored.
- Client projections: **TUI read** (`20a775d96`) + **TUI commands** (`9b48bec48`); Desktop **transport chain complete** (`21e625daa` + `dc404bf09`); UI consumer (**4.3c**) ✅ **LANDED** `1269e3fc7` — provider mounted in `main.tsx`; **no** AppStore view cutover; paired-iOS **still zero**.
- Approval correlation on the wire: ✅ **LANDED** `b74b33e33` (one-field `commandId`).
- Desktop read-only pure layer: ✅ **LANDED** `78b3845ed`. Live Desktop IPC bridge: ✅ **LANDED** `21e625daa`. Renderer IPC transport: ✅ **LANDED** `dc404bf09`. Production boot proof (Node): ✅ **LANDED** `402f34e0e`. Desktop UI mount: ✅ **LANDED** `1269e3fc7`.

### Typecheck evidence convention (corrected — binding)

**Do not quote “131 TS6307”, “134 total”, or any total-count typecheck figure.** Real `npm run typecheck:node` emits **ZERO** `TS6307` and a small, churning set of **foreign** errors. Required form: path-scoped — **zero error lines matching the owned path**, via the package.json script only (`host-arc-typecheck-131-ts6307-was-an-artefact`).

**Wave 4 / TUI — use `npm run typecheck:tui`.** `typecheck:node` **cannot see** `src/tui/**` (`tsconfig.node.json` include is main/preload/vite only). Zero `typecheck:node` errors naming `src/tui/` is **vacuous** for every possible TUI file (`host-arc-tui-needs-typecheck-tui-not-node`). Every Wave 4 handoff and adopt **must name which typecheck project it ran**.

### Do not score a live lane (binding)

Authority on a lane’s readiness is the **owner’s handoff only**. Scouts reading a moving target report *in flight, with a timestamp*, not a green/red verdict (`host-arc-do-not-score-a-live-lane`). Cap adopts only on owner handoff + Cap’s own live re-run.

### WAVE 6 — HostLocalServer socket-suite — **CLOSED as seat-specific** (not environmental)

**Supersedes** `host-arc-socket-epern-validation-gap`. Measured by `@SolBoss` (`host-arc-socket-gap-CLOSED-seat-specific-not-environmental`):

| Seat | Result |
|---|---|
| **Claude** (Boss / GrokWork-class) | HostLocalServer **35/35** PASSED · full `npx vitest run src/main/host/` **923/923** across **35** files **INCLUDING** sockets (pre-4.4). Post-4.4 handoff evidence: **929/929** across **36** files (923+6) |
| **Cursor** (Cap / SparkDocs-class) | May still get unix-socket listen `EPERM` — disclose, do not claim that path. Cap on 4.4 adopt: probe + suite **6/6 FAIL** `listen EPERM` — **disclosed, not claimed**; accepted GrokWork Claude-seat **6/6** + **929/929** |

**Standing rule (binding):** an “environment cannot do X” claim is only environmental after X has been tried on a **different** shell-capable seat. Cap was right to disclose Cursor `EPERM` on every substrate adopt; that was seat-true, not machine-true.

**4.2a/4.2b nuance unchanged:** Fake Host v2 over **TCP loopback** remains client-path evidence only — it is still **not** a substitute for the real unix-socket suite (now proven on a Claude seat) or for live Electron Host boot.

Any adopt that cites a host-suite count **must** still state whether socket tests ran, skipped, or failed **on that seat**.

### WAVE 4 sequencing (binding) — `host-arc-wave4-sequencing-ruling` + `host-arc-42c-slice-and-refined-43-gate` + `host-arc-44-production-boot-proof-is-now-possible`

**Order: TUI → Desktop → iOS.**

| Slice | Status | Owner | Scope |
|---|---|---|---|
| **4.1** `HostProjectionClient` | ✅ LANDED `9c31bd54f` | `@CursorWork` | Authenticated v2 wire client |
| **4.2a** TUI read-only projection | ✅ **LANDED** `20a775d96` | `@CursorWork` / `@GrokCapt` | Connect via `HostProjectionClient`, one `HostSnapshot`, map to TUI render model. Commands blocked. v1 retained unused on live path. `src/tui/**` only. |
| **4.2b** TUI command cutover | ✅ **LANDED** `9b48bec48` | `@CursorWork` / `@GrokCapt` | Same client + `commands`/`receipts`. Deferred-receipt poll; pending ≠ succeeded; y/n → `approval.decide`. No parallel v1 mutation socket. Evidence: `typecheck:tui` + 38/38 owned non-socket. |
| **4.2c** Approval correlation (protocol) | ✅ **LANDED** `b74b33e33` | `@GrokWork` / `@GrokCapt` | **ONE field only** (`host-arc-42c-one-field-grokwork-contest-upheld`): required `commandId` on `HostApprovalProjection`; **NO** `approvalId` on `HostCommandReceipt`. Cap evidence: `typecheck:node` + `typecheck:tui` exit 0 (owned clean); owned non-socket **103/103** across protocol/host/TUI files; dual same-`actionKind` RED-proof + decode reject pin + composition publish pin. Exact-path **10 files**. |
| **4.3a** Desktop read-only **pure** layer | ✅ **LANDED** `78b3845ed` | `@SolWork` / `@GrokCapt` | Injected `HostProjectionTransport { fetchSnapshot() }` — mapper/store/hook + honesty pins (cached ≠ live, unavailable ≠ zero, no empty fabricate). **No** live Host / preload / `index.ts` in this SHA. Cap evidence: `typecheck:web` owned clean; **24/24**. Exact-path **5 files**. |
| **4.3a-wire** Desktop IPC bridge | ✅ **LANDED** `21e625daa` | `@SolWork` / `@GrokCapt` | Exact-path **4** files · `+403/−0` · `index.ts` **+10/0** · preload **+7/0**. Protocol client (not store shortcut); read-only `bootstrap/snapshot/health`; `{ok:false}` never empty snapshot. Cap: `typecheck:node` + `typecheck:web` owned clean; handler **11/11**. |
| **4.3a-adapter** renderer IPC transport | ✅ **LANDED** `dc404bf09` | `@SolWork` / `@GrokCapt` | Exact-path **5** files · `+336/−2`. `hostProjectionIpcTransport{,.test}.ts` + `index.d.ts` + prose (`commandId`). Honesty hinge: `{ok:false}` → **reject**, never empty snapshot. Cap: `typecheck:web` + `typecheck:node` owned clean; **36/36** across 3 files. Transport chain complete in code. |
| **4.3b** Desktop command cutover | NOT STARTED | TBD | **Unblocked** by Cap-landed 4.2c (`b74b33e33`); sequenced after **4.3c consumer** + live Host observation (Boss). |
| **4.3c** Desktop UI consumer | ✅ **LANDED** `1269e3fc7` | `@SolWork` / `@GrokCapt` | Exact-path **3** files: `HostProjectionProvider{,.test}.tsx` + `main.tsx`. Provider wraps App + PopoutApp **inside** ErrorBoundary; **App.tsx untouched**; **ZERO forbidden roots**. First UI call site for store+IPC transport. Does **not** retire AppStore authority. Cap land during this docs pass (Boss brief still said IN FLIGHT — Cap tip supersedes). |
| **4.4** Production boot proof (Node) | ✅ **LANDED** `402f34e0e` | `@GrokWork` / `@GrokCapt` | Exact-path **1** file · `+272/−0` · `HostProductionBootstrap.boot.test.ts` only. Omits both seams (`createComposition` / `createServer`); real composition + real server. BOOT → SERVE → STOP against `fs.mkdtemp`. Identity on **`welcome.hostId`**, not snapshot. Cap: Prettier clean · `typecheck:node` zero owned · Cursor sockets **EPERM disclosed not claimed** · accept GrokWork Claude **6/6** + host **929/929**. CursorScout fake-`createComposition` claim adjudicated **FALSE**. **Proves Node boot; does NOT prove Electron Host.** |
| **4.5** Observe Host under Electron | 🔄 **IN FLIGHT** | `@GrokWork` → `@GrokCapt` | Closes the last AC1–6 hole in **code**, not ops (`host-arc-electron-observation-is-NOT-ops-a-harness-exists`). Sibling script `scripts/smoke-host-boot-electron.cjs` (additive; do **not** edit `smoke-packaged-electron.cjs` / `package.json` this pass). Must fail loudly on missing/undecodable `taskwraith-host-v2.json`. Recon-first: isolated instance must not disturb user’s running app. **Do not score**; do **not** pre-write a result. |
| **4.4+** Retire AppStore-as-authority / paired iOS | NOT STARTED | TBD | Separate slices after live Electron Host observation |

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
12. **4.4 evidence ownership is seat-split** — Cap’s Cursor seat may `EPERM` on unix sockets; Cap owns staging / typecheck / commit and must disclose EPERM rather than claim sockets; Claude-seat (GrokWork / Boss) owns the socket re-run evidence. Nobody is asked for evidence their sandbox forbids.
13. **4.3c wrap is `main.tsx`, not App.tsx** — App mounts from `main.tsx` (32 lines); goal forbids `App.tsx`, not `main.tsx`. Earlier “one-line App.tsx wrap” ruling is **corrected** (`host-arc-43c-maints-wrap-corrects-my-own-ruling`). STOP asking Boss (a) vs (b) — ruled (`host-arc-43c-already-ruled-stop-asking`).
14. **“Electron observation is ops” was FALSE** — `scripts/smoke-packaged-electron.cjs` already launches the packaged app in `ci`; Wave **4.5** adds Host discovery assertions in a sibling script. Node 4.4 green ≠ Electron Host observed.

---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits. This table lists **arc-owned commits only** — run `git log --oneline -1` for current HEAD.

```text
1269e3fc7  feat(renderer): mount Desktop Host projection provider (Wave 4.3c)            (@SolWork authored; @GrokCapt adopted)
402f34e0e  feat(host): prove production Host composition boots over real sockets (Wave 4.4) (@GrokWork authored; @GrokCapt adopted)
dc404bf09  feat(renderer): add Desktop Host projection IPC transport (Wave 4.3a-adapter) (@SolWork authored; @GrokCapt adopted)
21e625daa  feat(host): wire Desktop Host projection IPC bridge (Wave 4.3a-wire)         (@SolWork authored; @GrokCapt adopted)
8dd6d4d3e  docs(host): point next actions at 4.3a-wire after Cap lands                 (@SparkDocs; @GrokCapt adopted)
e888d3c87  docs(host): record Wave 4.2c and 4.3a Cap lands                             (@SparkDocs; @GrokCapt adopted)
78b3845ed  feat(renderer): add pure Desktop Host projection layer (Wave 4.3a)           (@SolWork authored; @GrokCapt adopted)
b74b33e33  feat(host): bind approvals to commands by commandId (Wave 4.2c)              (@GrokWork authored; @GrokCapt adopted)
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
- ✅ **4.2c — approval correlation (one-field)** @ `b74b33e33`
- ✅ **4.3a — Desktop pure projection layer** @ `78b3845ed`
- ✅ **Docs catch-up (4.2c / 4.3a Cap lands)** @ `e888d3c87`
- ✅ **Docs next-actions → wire** @ `8dd6d4d3e`
- ✅ **4.3a-wire — Desktop IPC bridge** @ `21e625daa` — 4 files · `+403/−0` · `index.ts` exactly `+10/0`
- ✅ **4.3a-adapter — renderer IPC transport** @ `dc404bf09` — 5 files · `+336/−2` · honesty hinge `{ok:false}` → reject
- ✅ **4.4 — production boot proof (Node)** @ `402f34e0e` — 1 file · `+272/−0` · real composition + real server boots/serves/stops under test · **not** Electron observation
- ✅ **4.3c — Desktop UI consumer** @ `1269e3fc7` — 3 files · provider + `main.tsx` wrap · App.tsx untouched · mounts projection; **does not** retire AppStore

### What remains (post–Wave 4.3c)
| Item | Owner | Status |
|---|---|---|
| **Wave 4.2c — approval correlation (protocol)** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `b74b33e33` — one-field `commandId` on approval. |
| **Wave 4.3a — Desktop read-only pure layer** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `78b3845ed` — injected transport; no live Host in this SHA. |
| **Wave 4.3a-wire — IPC + one `index.ts` line** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `21e625daa` — Cap exact-path 4 files; Host-only hunk. |
| **Wave 4.3a-adapter — renderer IPC transport** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `dc404bf09` — Cap exact-path 5 files; transport complete in code. |
| **Wave 4.4 — production boot proof (Node)** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `402f34e0e` — Cap exact-path 1 file; Claude-seat sockets accepted; Cap Cursor EPERM disclosed. **Not** Electron observation. |
| **Wave 4.3c — Desktop UI consumer** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `1269e3fc7` — Cap exact-path 3 files; provider mounted; AppStore authority **not** retired. |
| **Wave 4.5 — observe Host under Electron** | `@GrokWork` → `@GrokCapt` | 🔄 **IN FLIGHT** — sibling smoke script; fail-closed on missing discovery. **Do not score**; do not pre-write result. |
| **Wave 4.3b — Desktop commands** | `@SolBoss` sequencing | **Unblocked** by 4.2c; after live Host observation (4.3c mount now Cap-landed). |
| **Live Electron `taskwraith-host-v2.json`** | Wave 4.5 | **STILL never observed** — Node 4.4 ≠ Electron Host |
| **Wave 5 — `.twmission` / AC9** | `@SolBoss` | **NOT STARTED** |
| **Wave 6 — adversarial + closeout** | `@SolBoss` | Socket **unit** gap **CLOSED** (seat-specific). Live Electron Host observation still required for AC1–6. |

### Marker hygiene (this paperwork measurement)

| Marker | Parse | Effective claim |
|---|---|---|
| `.WORK-IN-PROGRESS-host-arc-wave36d-evaluator.md` | **Absent** | n/a (Gate 1 landed) |
| `.WORK-IN-PROGRESS-host-arc-wave36c-bootstrap.md` | **Absent** | n/a (Gate 2 landed) |
| `.WORK-IN-PROGRESS-host-arc-install-identity.md` | **Absent** | n/a (3.6e landed) |
| `.WORK-IN-PROGRESS-host-arc-r4prime-index-wiring.md` | **Absent** | n/a (R4' landed) |
| `.WORK-IN-PROGRESS-host-arc-wave42a-tui-projection.md` | **Absent** | n/a (4.2a landed) |
| `.WORK-IN-PROGRESS-host-arc-wave42b-tui-commands.md` | **Absent** | n/a (4.2b landed) |
| `.WORK-IN-PROGRESS-host-arc-wave42c-approval-correlation.md` | **Absent** | n/a (4.2c Cap-landed) |
| `.WORK-IN-PROGRESS-host-arc-wave43a-desktop-projection.md` | **Absent** | n/a (4.3a pure Cap-landed) |
| `.WORK-IN-PROGRESS-host-arc-wave43a-wire.md` | **Absent** | n/a (4.3a-wire Cap-landed `21e625daa`) |
| `.WORK-IN-PROGRESS-host-arc-wave43a-adapter.md` | **Absent** | n/a (4.3a-adapter Cap-landed `dc404bf09`) |
| `.WORK-IN-PROGRESS-host-arc-wave44-boot-proof.md` | **Absent** | n/a (4.4 Cap-landed `402f34e0e`; Cap + GrokWork markers dropped on land) |
| `.WORK-IN-PROGRESS-host-arc-wave43c-desktop-consumer.md` | **Absent** | n/a (4.3c Cap-landed `1269e3fc7`; authored without marker — `host-arc-lane-scope-omits-granted-marker-paths`) |
| `.WORK-IN-PROGRESS-host-arc-wave45-electron-observe.md` | **Absent / unknown** | 4.5 **IN FLIGHT** under `@GrokWork` — recon-first; re-measure before quoting |

Foreign markers present (not Host Arc): `.WORK-IN-PROGRESS-observatory-gpu-calm.md`, `.WORK-IN-PROGRESS-seat-strip-desktop.md`, `.WORK-IN-PROGRESS-tool-event-dual-lane-dedupe.md`.

`@SparkDocs` note: this Cursor seat has **`TASKWRAITH_LOCK_OWNER_ID` absent** and no stable long-lived seat pid; **no docs marker raised** (a no-identity marker would claim nothing). Accepting Cap tip: wire **`21e625daa`** + adapter **`dc404bf09`** + Wave 4.4 **`402f34e0e`** + Wave 4.3c **`1269e3fc7` LANDED**; 4.5 **IN FLIGHT unscored**; production Host **STILL never observed running under Electron**. **Not committed** this pass.

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
| AC1–AC6 | ⚠️ **PARTIAL** | Host **wiring** ON in main (`b45d4297f`). Wave **4.4** proves Node production composition boots/serves/stops (`402f34e0e`). Wave **4.3c** mounts Desktop provider (`1269e3fc7`) without retiring AppStore. Production Host **STILL never observed running under Electron** (zero `taskwraith-host-v2.json`). TUI read+commands in HEAD; iOS still zero. Socket **unit** suite **CLOSED** seat-specific (Claude **929/929** post-4.4). Fake Host / Node boot-test ≠ Electron boot. Wave **4.5** in flight to close the Electron hole. **Never PASS.** |
| AC7–AC8 | ⚠️ PARTIAL | Host core authoritative; TUI is first full (read+command) projection client; Desktop mounts Host projection (AppStore still authority for most views); iOS still legacy |
| AC9 | ❌ **NOT STARTED** | `.twmission` / mission evidence not started (Wave 5) |
| AC10–AC11 | ⚠️ PARTIAL | TUI read+command paths live in HEAD; Desktop pure + wire + adapter + mount landed; Desktop commands / iOS not started |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | Path-scoped evidence only; Wave 4 TUI uses `typecheck:tui`; Desktop pure/adapter/consumer uses `typecheck:web`; wire/preload needs **node+web**; protocol slice needs **node+tui**; 4.4 uses `typecheck:node` |
| AC15 | ✅ PASS | No forbidden path drift in scoped arc Cap lands (4.3c exact-path 3 files; 4.4 exact-path 1; adapter 5; wire 4; prior exact-path lands stand) |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain) · `@K3Review` (final validation gate)

**Aliases:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Commits are exact-path only; markers with honest live pid **or** `lockOwnerId` and adopter-window expiry; drop on adopt. Workers leave validated handoffs; Cap commits post-review. **One owner per gate.** Live suite at adopt = shell-capable seat. **Nobody commits from work seats on the current 4.5 fan-out** — validated handoff to `@GrokCapt`. Scouts do not score live lanes. **4.4 socket evidence** = GrokWork Claude-seat (Cap disclosed Cursor `EPERM`).

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
- ` M docs/HOST_ARC_STATUS.md` (this paperwork lane)
- Wave **4.5** sibling smoke script (when authored) — Cap exact-path after handoff; exclude from docs land

**Foreign / other-session (illustrative — re-measure before acting):**
- `electron.vite.config.ts`, `src/main/store/{index,PersistenceWriteWorker*,persistenceDurability*,persistenceWriteBaseline*}`, `src/main/workers/persistenceWriteWorker.ts` — **not Host Arc scope**

Exact-path staging only — never `git add -A` / `git add .` / `commit -a`.

---

## Next actions (paperwork view)

1. `@GrokCapt` — exact-path adopt **Wave 4.5** only after GrokWork formal handoff; disclose Cursor limits rather than claim a launch you cannot run. Exact-path this docs refresh alone or with that adopt (exclude foreign dirt).
2. `@GrokWork` — finish **Wave 4.5** recon-first Electron observation handoff; Cap adopts only after formal handoff. **Do not score** while live. A RED is a real P0 result, not a lane failure.
3. `@K3Review` / `@GrokReview` / `@MistralReview` — delta-only on Cap lands `402f34e0e` (4.4) and `1269e3fc7` (4.3c); HOLD 4.5 until Cap SHA; no Wave 3 / 4.2 / 4.3a / 4.4 reopen.
4. `@SolBoss` — Cap-clear 4.5 adopt when handed off; sequence **4.3b** only after live Electron Host observation; keep AC1–6 **PARTIAL**.
5. **PROMINENT:** Production Host **STILL never observed running under Electron** — zero `taskwraith-host-v2.json`. Wave 4.4 green under Node ≠ Electron observation. Wave 4.5 is the code path; do **not** pre-write its result.
6. `@SparkDocs` — optional polish after Cap lands 4.5 SHA; do not invent Electron boot evidence.

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits.
- QA remains with user.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-wave3-closed-four-shas`, `host-arc-wave4-sequencing-ruling`, `host-arc-r4prime-adopt-authorized`, `host-arc-r4prime-does-NOT-pass-ac1-6`, `host-arc-production-host-has-never-actually-run`, `host-arc-socket-gap-CLOSED-seat-specific-not-environmental`, `host-arc-socket-epern-validation-gap` (superseded), `host-arc-43a-wire-and-adapter-verified-by-boss`, `host-arc-43a-adapter-chain-complete-appts-next`, `host-arc-43c-maints-wrap-corrects-my-own-ruling`, `host-arc-43c-already-ruled-stop-asking`, `host-arc-44-production-boot-proof-is-now-possible`, `host-arc-44-fake-composition-claim-is-FALSE-adjudicated`, `host-arc-44-boot-proof-REAL-COMPOSITION-BOOTS`, `host-arc-electron-observation-is-NOT-ops-a-harness-exists`, `host-arc-lane-scope-omits-granted-marker-paths`, `host-arc-42c-one-field-grokwork-contest-upheld`, `host-arc-43a-cleared-and-wire-carveout-granted`, `host-arc-do-not-score-a-live-lane`, `host-arc-review-seats-have-no-shell`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures byte-verified against live git + markers at time of writing · **not committed** this pass.
