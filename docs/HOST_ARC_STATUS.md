# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (Boss rule `host-arc-docs-must-record-DONE-never-IN-FLIGHT` — record closed waves only; never in-flight Cap/adopt status)  
**Last updated:** 2026-08-06T16:15Z continuous round  
**Branch ahead of origin/master:** ~425 (moving; `git log --oneline -1` is authoritative for HEAD)  
**Overall completeness:** **Wave 3 CLOSED** — four SHAs (`18ec305f9`, `a12f2840a`, `80b1284c5`, `b45d4297f`). **Wave 4.2a–c** + **4.3a pure/wire/adapter** + **Wave 4.4** `402f34e0e` + **Wave 4.3c** `1269e3fc7` + **Wave 4.3d** `e63add3c7` + **Wave 4.6** `d7b44f23c` + **Wave 4.5** `f1f950207` + **Wave 4.3e** `f370800da` + **Wave 4.6a** `3d3d766cc` all **LANDED**. Node production composition boots/serves/stops under test; TUI proves first **real** client round trip against real Host sockets with a hardened connection-evidence pin (three regex layers closed); Desktop mounts provider **and** reads Host via ungated `HostStatusRow` (Approvals). **Does NOT** prove Host under Electron; **does NOT** retire AppStore authority. AC1–6 **PARTIAL** (never PASS). Production Host **STILL never observed running under Electron** — zero `taskwraith-host-v2.json`. Socket suite **CLOSED as seat-specific** — durable seat matrix: **Claude = LISTEN OK · Pi = LISTEN OK · Cursor = EPERM**. **AppStore cutover** / **iOS** remain recon-only (Boss: no implementation until Electron Host observed). **iOS Kit reachable:** Swift **6.2.4**; `test:swift:ios-kit` = **868/115 green ~6s** (warm cache).

---

## ⚠ CRITICAL DISTINCTION — “Host is ON” ≠ “Host has booted”

**PRODUCTION HOST HAS NEVER BEEN OBSERVED RUNNING UNDER ELECTRON** (`host-arc-production-host-has-never-actually-run`, measured by `@SolBoss`).

| Claim people will misread | What is actually true |
|---|---|
| “Host is ON” | **Wiring is committed** in Electron main (`b45d4297f`). `createHostProductionBootstrap` + `start().catch(...)` + `stopSync` exist in **HEAD** `index.ts`. |
| “Host has booted / is listening” | **Not observed under Electron.** Zero `taskwraith-host-v2.json` discovery files exist on this machine (prod + TaskWraith Dev userData searched). Running TaskWraith.app started **~2h11m before R4' landed** — it is a **stale binary** that predates Host wiring. Cause (a) stale process, not cause (b) `start()` failing into the logged catch. |
| TUI Fake Host v2 green | **Client-path evidence over TCP loopback** in-process. Proves connect → snapshot → (4.2b) command submit / receipt poll / deferred ask. **Does not** prove live production Host under Electron. |
| Wave **4.6** TUI live integration green | **FIRST REAL CLIENT ROUND TRIP** in the arc (`host-arc-46-first-real-client-round-trip-and-two-overclaims-corrected`). **LANDED** `d7b44f23c`. Real `createHostProductionBootstrap` defaults + real unix socket + real `TaskWraithTui`; kill-the-Host RED-proof (unreachable ≠ empty world). Evidence at land: focused **2/2** · full `src/tui/` **58/58** across **7** files · `typecheck:tui` exit 0 (correct project **named**). Cap Cursor seat **EPERM** disclosed; Pi/Claude suite accepted. |
| Socket suite / `EPERM` | **CLOSED as seat-specific, not environmental.** **Seat matrix (durable routing):** Claude = **LISTEN OK** · Pi = **LISTEN OK** · Cursor = **EPERM**. Cap discloses Cursor `EPERM` rather than claiming sockets. Standing rule: an “environment cannot do X” claim is only environmental after X has been tried on a **different** shell-capable seat. |
| Wave **4.4** Node boot proof green | **LANDED** `402f34e0e`. Proves real `createHostMainComposition` + real `HostLocalServer` boot → serve authenticated snapshot → stop under **Node** (`fs.mkdtemp`). **Not** Electron launch; **not** live `taskwraith-host-v2.json`. |
| “Electron observation is ops, not code” | **FALSE** (`host-arc-electron-observation-is-NOT-ops-a-harness-exists`). `scripts/smoke-packaged-electron.cjs` already launches the packaged app in `ci`; it only never asserted Host discovery. Wave **4.5** closes that hole in code — harness **LANDED** `f1f950207`. |
| “AC1–6 will PASS when 4.5 lands” | **FALSE.** 4.5 commits a **script**. A script that has never run observes nothing. AC1–6 stay **PARTIAL** until a **rebuilt** post-R4' bundle is actually launched and a discovery record is actually seen. |
| “Invalid package-smoke profile degrades to production” | **FALSE — SUPERSEDED** (`host-arc-45-SUPERSEDED-app-fails-closed-not-open`). The app **FAILS CLOSED**: `devAppName.ts` L159 throws (`TaskWraith refused an invalid private launch posture.`). It does **not** silently degrade to production posture. Four seats (incl. Boss) had this backwards; do not re-inherit the open claim. |

Do **not** inherit the stronger claim by accident in a fresh context. Wave 4.4 green under Node ≠ Host under Electron. Wave 4.6 green under Node+TUI ≠ Electron observation. Live Electron discovery remains unobserved until Wave 4.5 (or an equivalent post-R4' launch) **runs** and produces evidence. **Landing the 4.5 script alone flips nothing on AC1–6.**

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery |
| **Wave 2E-2B** (Deferred allow + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split @ `aceb0993a`; `HostDeferredAllowPipeline` @ `9d4a2a104`; micro-fix @ `167f6916b` |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` | `joinFor` cleanup @ `5a0761793`; Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | ✅ **CLOSED** | `@SolBoss` / `@GrokCapt` | Substrate + Gates 1/2/3.6e + R4' wiring all committed. Host **wiring ON** in main. AC1–6 → **PARTIAL** (not PASS). Production Host **never observed running under Electron**. |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | 🔄 **ACTIVE** — user-gated Electron launch next | `@SolBoss` / `@SolWork` / `@GrokCapt` / `@GrokWork` / `@DSeekWork` | Order ruled **TUI → Desktop → iOS**. **4.2a–c** + **4.3a pure/wire/adapter** + **4.4** + **4.3c** + **4.3d** + **4.6** + **4.5** + **4.3e** + **4.6a** all **LANDED**. Desktop Host consumer **ungated** (`f370800da`). Connection pin hardened (`3d3d766cc`). **4.3b** gated on live Electron Host observation. AppStore/iOS = **recon only** (Boss). |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 progress; AC9 still NOT STARTED |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Socket **unit** gap closed (seat-specific). Still blocked by Waves 3–5 + **live Electron Host observation** + remaining adversarial gates |

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
- **Runtime observation (later):** production Host **never observed running under Electron** — see critical distinction above. Wiring SHA stands; Electron boot evidence does not.

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
**Host process observed running under Electron: NO** (zero `taskwraith-host-v2.json`; stale pre-R4' app).

**AC1–6: PARTIAL — never write PASS** (`host-arc-r4prime-does-NOT-pass-ac1-6`, updated after Wave 4.3e land):

- Process half (wiring): **yes**.
- Process half (Node production composition boot under test): **yes** — Wave **4.4** `402f34e0e` (real composition + real server; BOOT → SERVE → STOP).
- Process half (observed boot under Electron): **no** — zero `taskwraith-host-v2.json` on the machine; production Host **STILL never observed running under Electron**. Wave **4.5** harness is **LANDED** `f1f950207` — **landing the script does not flip AC1–6**. Observation still requires a rebuilt post-R4' bundle **launched** and discovery **seen**.
- Client projections: **TUI read** (`20a775d96`) + **TUI commands** (`9b48bec48`) + **TUI real Host round trip** (`d7b44f23c`); Desktop **transport + mount + leaf consumer + ungated placement** (`21e625daa` + `dc404bf09` + `1269e3fc7` + `e63add3c7` + `f370800da`); paired-iOS already e2ee-v1 projection client (**zero** Host v2 types in `ios/` — Mac still derives remote snapshots from AppStore); **no** AppStore→Host view cutover.
- Approval correlation on the wire: ✅ **LANDED** `b74b33e33` (one-field `commandId`).
- Desktop read-only pure layer: ✅ **LANDED** `78b3845ed`. Live Desktop IPC bridge: ✅ **LANDED** `21e625daa`. Renderer IPC transport: ✅ **LANDED** `dc404bf09`. Production boot proof (Node): ✅ **LANDED** `402f34e0e`. Desktop UI mount: ✅ **LANDED** `1269e3fc7`. Desktop leaf consumer: ✅ **LANDED** `e63add3c7`. Ungated Host surface: ✅ **LANDED** `f370800da`. Electron harness: ✅ **LANDED** `f1f950207` (script only — **not** observation).

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
| **Pi** (DSeekWork-class) | **LISTEN OK** — Wave **4.6** probe + live TUI integration (first real client round trip) |
| **Cursor** (Cap / SparkDocs-class) | May still get unix-socket listen `EPERM` — disclose, do not claim that path. Cap on 4.4 adopt: probe + suite **6/6 FAIL** `listen EPERM` — **disclosed, not claimed**; accepted GrokWork Claude-seat **6/6** + **929/929** |

**Standing rule (binding):** an “environment cannot do X” claim is only environmental after X has been tried on a **different** shell-capable seat. Cap was right to disclose Cursor `EPERM` on every substrate adopt; that was seat-true, not machine-true.

**4.2a/4.2b nuance unchanged:** Fake Host v2 over **TCP loopback** remains client-path evidence only — it is still **not** a substitute for the real unix-socket suite (now proven on Claude + Pi seats) or for live Electron Host boot.

Any adopt that cites a host-suite count **must** still state whether socket tests ran, skipped, or failed **on that seat**.

### WAVE 4 sequencing (binding) — `host-arc-wave4-sequencing-ruling` + `host-arc-42c-slice-and-refined-43-gate` + `host-arc-44-production-boot-proof-is-now-possible` + `host-arc-43e-host-consumer-must-not-live-behind-the-ios-flag`

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
| **4.3b** Desktop command cutover | NOT STARTED | TBD | **Unblocked** by Cap-landed 4.2c (`b74b33e33`); sequenced after **consuming view** (4.3d + ungated 4.3e) + **live Electron Host observation** (Boss). |
| **4.3c** Desktop UI mount | ✅ **LANDED** `1269e3fc7` | `@SolWork` / `@GrokCapt` | Exact-path **3** files: `HostProjectionProvider{,.test}.tsx` + `main.tsx`. Provider wraps App + PopoutApp **inside** ErrorBoundary; **App.tsx untouched**; **ZERO forbidden roots**. Mount ≠ consumption. Does **not** retire AppStore authority. |
| **4.3d** Desktop leaf consumer | ✅ **LANDED** `e63add3c7` | `@SolWork` / `@GrokCapt` | Exact-path **3** files · `+294` · `HostStatusRow{,.test}.tsx` + `Sidebar.tsx` **+6/0**. First production UI call site for `useHostProjection`. unavailable ≠ cached wording; LED only on `live`. Cap live: vitest **53/53** (5 files) · `typecheck:web` zero owned on HostStatusRow. **Do NOT** `prettier --write` `Sidebar.tsx` (pre-dirty at HEAD; would rewrite ~3433 lines). App.tsx untouched. *(Original mount was Devices popover; relocated by 4.3e.)* |
| **4.3e** Host consumer out of iOS-flag chrome | ✅ **LANDED** `f370800da` | `@SolWork` / `@GrokCapt` | Exact-path **2** files · `+53/−7` · `Sidebar.tsx` + `HostStatusRow.test.tsx`. Boss ruling `host-arc-43e-host-consumer-must-not-live-behind-the-ios-flag` / `@K3Review` F1 closed. `HostStatusRow` **only** in ungated `ApprovalsFooterPopover`; **removed** from Devices; two-sided red-first placement pins (`IOS_REMOTE_ENABLED: false` mock). Cap live: focused **12/12** · **55/55** across 5 Host files · `typecheck:web` zero owned. **Do NOT** `prettier --write` `Sidebar.tsx`. `HostStatusRow.tsx` unchanged. |
| **4.4** Production boot proof (Node) | ✅ **LANDED** `402f34e0e` | `@GrokWork` / `@GrokCapt` | Exact-path **1** file · `+272/−0` · `HostProductionBootstrap.boot.test.ts` only. Omits both seams (`createComposition` / `createServer`); real composition + real server. BOOT → SERVE → STOP against `fs.mkdtemp`. Identity on **`welcome.hostId`**, not snapshot. Cap: Prettier clean · `typecheck:node` zero owned · Cursor sockets **EPERM disclosed not claimed** · accept GrokWork Claude **6/6** + host **929/929**. CursorScout fake-`createComposition` claim adjudicated **FALSE**. **Proves Node boot; does NOT prove Electron Host.** |
| **4.5** Electron Host boot smoke harness | ✅ **LANDED** `f1f950207` | `@GrokWork` / `@GrokCapt` | Exact-path **1** file · `+400` · `scripts/smoke-host-boot-electron.cjs` only (`package.json` / `smoke-packaged-electron.cjs` untouched). Stale-bundle gate (exit **20** ≠ Host-did-not-boot / **21** unsafe). Cap realpath defect **closed**: raw `os.tmpdir()` join (no `realpathSync`); matches TUI smoke + app posture. Fail-closed prose corrected: invalid posture → **throw**, not production degrade (`host-arc-45-SUPERSEDED-app-fails-closed-not-open`). **Nothing launched by land.** **AC1–6 do not flip PASS when this script lands.** |
| **4.6** TUI vs real Host (first client round trip) | ✅ **LANDED** `d7b44f23c` | `@DSeekWork` / `@GrokCapt` | Exact-path **1** file · `+267` · `src/tui/hostLiveIntegration.test.ts`. Real composition + real unix socket + real TUI; kill-Host RED-proof. Evidence: **2/2** focused · **58/58** across 7 TUI files · `typecheck:tui` exit 0. Seat probe: Pi **LISTEN OK**. Cap Cursor **EPERM** disclosed; Pi/Claude suite accepted. |
| **4.6a** Durable connection pin (timing flake) | ✅ **LANDED** `3d3d766cc` | `@DSeekWork` / `@GrokCapt` | Exact-path **1** file · `+62/−13` · `src/tui/hostLiveIntegration.test.ts` only. Three regex layers closed + pinned: (1) case/timing — notice + durable HUD `CONNECTED`; (2) `/CONNECTED/i` ⊇ `DISCONNECTED` → word boundary; (3) product notice `TaskWraith Host is not connected.` → `/(?<!not\s+)\bCONNECTED\b/i` (`host-arc-46a-NOT-CONNECTED-is-reachable-from-product-code`). Negative pin covers all three. Cap: negative pin **1/1**; accept Pi **3/3** · **59/59** · `typecheck:tui` exit 0 (Cursor EPERM disclosed). Test-only — TUI product code untouched. |
| **4.4+** AppStore authority / paired iOS | 🔍 **RECON ONLY** (Boss: no implementation until Electron Host observed) | `@SolWork` (AppStore map) · `@GrokWork` (iOS) | **AppStore:** `HostSnapshot` is **metadata-only by design** — transcripts excluded twice in `hostProtocol.ts`; Desktop `ChatRecord.messages` **can never** come from HostSnapshot (`host-arc-appstore-cutover-gap-map-measured`). Cutover = two problems (metadata families vs body-bearing domains). Recommend **providers** first (blast radius). **iOS:** already a projection client over `taskwraith-e2ee-v1` (`RemoteProjectionSnapshot`); **zero** Host types in `ios/`; Swift **6.2.4** present; Kit baseline **868/115 green ~6s** (`host-arc-ios-kit-baseline-868-green-and-my-mirror-claim-was-too-broad`); work is **downstream of Desktop/Mac cutover**. Do **not** port `HostSnapshot` to Swift — reason is **churn** (HostSnapshot moved this round), not technique: e2ee mirror is machine-verified by golden vectors (`InteropVectorsTests.swift` ↔ `crossImplVectors.test.ts`). |

### Renderer-restart / per-window store (binding)

`host-arc-renderer-restart-per-window-store-is-CORRECT-not-a-defect` — MistralScout’s “shared singleton” flag was a **goal misreading**. Mission lives in **Host** (main), not the renderer store. Per-window `useState` store is correct: reload must re-fetch from Host, not retain competing authority. Do **not** turn into a work order.

### Markers in fan-out lanes (binding)

`host-arc-markers-not-required-in-fanout-lanes-my-fix-failed` — Boss ruled markers **not required** in fan-out lanes after the write-scope / one-shot retry path failed 0-for-N this round. This docs lane raises **no** marker (`TASKWRAITH_LOCK_OWNER_ID` absent).

### `index.ts` staging RULE (not a window status)

**Do not treat any prior clean/dirty reading as current** (`host-arc-window-is-instantaneous`).

**Operative form after R4'** (`host-arc-r4prime-staging-rule-restated`): when staging an `index.ts` hunk, the same-breath `git diff --stat -- src/main/index.ts` must show **ONLY OUR HUNK** — not empty-while-our-hunk-exists. Empty was correct only before the hunk existed. Ordinary exact-path staging when the diff is Host-only. Private-index (`GIT_INDEX_FILE`) is last resort and **must** be followed by shared-index resync. `git add -p` remains invalid.

**This paperwork pass:** `git diff --stat -- src/main/index.ts` ⇒ **EMPTY** (measured earlier this lane; re-check before any stage). Host wiring lives in **HEAD** (`b45d4297f`). That is a measurement, not a durable window claim.

### Live-suite routing (binding)

Review seats `@GrokReview` / `@K3Review` are read-clamped and have **no shell**. Live `vitest` / `typecheck:tui` / `typecheck:node` / `typecheck:web` at adopt = shell-capable seat (typically `@GrokCapt`). Static delta only on shell-less seats (`host-arc-review-seats-have-no-shell`).

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
15. **Stale-bundle RED trap** — any 4.5 script must assert Host symbols in the bundle **before** asserting discovery, or a RED is uninterpretable (`host-arc-45-my-red-preauthorisation-was-a-trap-grokwork-caught-it`).
16. **4.5 landing a script ≠ AC1–6 PASS** — observation requires a rebuilt bundle **run**; Cap-landing the harness alone flips nothing.
17. **Do not `prettier --write` Sidebar.tsx** — pre-dirty at HEAD; formatting rewrites ~3433 lines for a handful of Host insertions (`host-arc-43d-sidebar-is-prettier-dirty-do-not-write`).
18. **Host consumer must not live behind the iOS-remote flag** — `@K3Review` F1 upheld as Wave **4.3e** (`host-arc-43e-host-consumer-must-not-live-behind-the-ios-flag`) — **LANDED** `f370800da`.
19. **Per-window renderer store is correct** — mission lives in Host; reload re-fetches (`host-arc-renderer-restart-per-window-store-is-CORRECT-not-a-defect`).
20. **Seat matrix is durable** — Claude / Pi listen OK; Cursor may EPERM. Route socket evidence accordingly.
21. **App fails CLOSED on invalid package-smoke posture** — throws; does **not** degrade to production (`host-arc-45-SUPERSEDED-app-fails-closed-not-open`).
22. **`/CONNECTED/i` matches `DISCONNECTED`** — do not adopt a connection pin that makes the kill RED-proof vacuous (`host-arc-46a-BLOCKED-regex-matches-DISCONNECTED`). Closed by **4.6a** `3d3d766cc`: `/(?<!not\s+)\bCONNECTED\b/i` + negative pin.
23. **Docs must never state whether they are committed** — `git log` answers that and cannot go stale. Self-referential "not committed" / "pending Cap adopt" lines are structural defects (`host-arc-ios-toolchain-PRESENT-and-docs-header-lies-about-itself`).
24. **HostSnapshot ≠ AppStore replacement** — transcripts excluded by design; iOS already projects over e2ee-v1 and inherits Mac-derived snapshots (`host-arc-appstore-cutover-gap-map-measured`, `host-arc-ios-recon-already-a-projection-client-downstream-of-lane-A`).
25. **`\bCONNECTED\b` still matches `not connected`** — product notice at `TaskWraithTui.ts` L966 is reachable (`host-arc-46a-NOT-CONNECTED-is-reachable-from-product-code`). Closed by the same **4.6a** lookbehind + pin at `3d3d766cc`.
26. **Docs record DONE, never IN-FLIGHT** — continuous rounds race Cap adopts against docs lanes by design; a refresh that says "awaiting Cap" can assert an already-landed wave is unlanded (`host-arc-docs-must-record-DONE-never-IN-FLIGHT`). In-flight status lives in transcript/blackboard. Drop the code-tip line — it duplicates `git log` and goes stale. Keep LANDED SHAs only.
27. **iOS Kit is reachable and cheap** — Swift **6.2.4**; `npm run test:swift:ios-kit` = **868/115 green ~6s** warm (`host-arc-ios-kit-baseline-868-green-and-my-mirror-claim-was-too-broad`). Not user-gated.
28. **Do not port HostSnapshot to Swift for "mirror safety"** — e2ee TS↔Swift is already golden-vector pinned both sides; the real reason is **churn** (HostSnapshot moved this round with 4.2c `commandId`), not technique.
29. **Sections that duplicate a live source — `git status`, transcript routing — must be deleted, not reconciled.** Four staleness cycles (passes 21/23/25/27) all lived in 'Foreign Dirt' and 'Next actions'. Reconciliation recurs forever; deletion is terminal (`host-arc-delete-the-two-sections-not-the-lines-plus-conditional-owners`).
---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits. This table lists **arc-owned commits only** — run `git log --oneline -1` for current HEAD.

```text
83432f398  docs(host): record Wave 4.6a land under DONE-only Host Arc status              (@SparkDocs; @GrokCapt adopted)
3d3d766cc  test(tui): harden Host live connection evidence pin (Wave 4.6a)              (@DSeekWork authored; @GrokCapt adopted; THREE REGEX LAYERS PINNED)
976c06c3a  docs(host): tip Host Arc status at Wave 4.3e Cap land                          (@SparkDocs; @GrokCapt adopted)
f370800da  feat(renderer): move Host status row out of iOS-gated Devices chrome (Wave 4.3e) (@SolWork authored; @GrokCapt adopted; UNGATED HOST SURFACE)
f1f950207  feat(scripts): add isolated Electron Host boot smoke harness (Wave 4.5)          (@GrokWork authored; @GrokCapt adopted; SCRIPT ONLY — NOT OBSERVATION)
d7b44f23c  test(tui): prove TUI round-trip against real Host sockets (Wave 4.6)             (@DSeekWork authored; @GrokCapt adopted; FIRST REAL CLIENT ROUND TRIP)
e63add3c7  feat(renderer): add Host status row leaf consumer (Wave 4.3d)              (@SolWork authored; @GrokCapt adopted; FIRST DESKTOP CONSUMER)
803f921eb  docs(host): record Wave 4.4 and 4.3c Cap lands                             (@SparkDocs; @GrokCapt adopted)
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
- ✅ **R4' — `index.ts` wiring** @ `b45d4297f` — Host process **wiring ON** in main (Electron boot **not** observed)

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
- ✅ **4.3c — Desktop UI mount** @ `1269e3fc7` — 3 files · provider + `main.tsx` wrap · App.tsx untouched · mounts projection; **does not** retire AppStore
- ✅ **Docs catch-up (4.4 / 4.3c Cap tip)** @ `803f921eb`
- ✅ **4.3d — Desktop leaf consumer** @ `e63add3c7` — 3 files · `+294` · first production UI read of Host · App.tsx untouched
- ✅ **4.6 — TUI vs real Host** @ `d7b44f23c` — 1 file · `+267` · **first real client round trip** in HEAD
- ✅ **4.5 — Electron Host boot smoke harness** @ `f1f950207` — 1 file · `+400` · script landed; **not** Electron observation; AC1–6 unchanged
- ✅ **4.3e — Host out of iOS-flag chrome** @ `f370800da` — 2 files · `+53/−7` · ungated Approvals mount; Devices cleared
- ✅ **4.6a — durable connection pin** @ `3d3d766cc` — 1 file · `+62/−13` · three regex layers closed + negative pin · test-only

### What remains (post–Wave 4.6a)
| Item | Owner | Status |
|---|---|---|
| **Wave 4.2c — approval correlation (protocol)** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `b74b33e33` — one-field `commandId` on approval. |
| **Wave 4.3a — Desktop read-only pure layer** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `78b3845ed` — injected transport; no live Host in this SHA. |
| **Wave 4.3a-wire — IPC + one `index.ts` line** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `21e625daa` — Cap exact-path 4 files; Host-only hunk. |
| **Wave 4.3a-adapter — renderer IPC transport** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `dc404bf09` — Cap exact-path 5 files; transport complete in code. |
| **Wave 4.4 — production boot proof (Node)** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `402f34e0e` — Cap exact-path 1 file; Claude-seat sockets accepted; Cap Cursor EPERM disclosed. **Not** Electron observation. |
| **Wave 4.3c — Desktop UI mount** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `1269e3fc7` — Cap exact-path 3 files; provider mounted; AppStore authority **not** retired. |
| **Wave 4.3d — Desktop leaf consumer** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `e63add3c7` — Cap exact-path 3 files; first production Host UI read. |
| **Wave 4.6 — TUI vs real Host** | `@DSeekWork` / `@GrokCapt` | ✅ **LANDED** `d7b44f23c` — Cap exact-path 1 file; first real client round trip. |
| **Wave 4.5 — Electron Host boot smoke harness** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `f1f950207` — Cap exact-path 1 file; script only. **Landing ≠ observation. AC1–6 stay PARTIAL.** |
| **Wave 4.3e — Host out of iOS-flag chrome** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `f370800da` — Cap exact-path 2 files; ungated Approvals surface. |
| **Wave 4.6a — durable connection pin** | `@DSeekWork` / `@GrokCapt` | ✅ **LANDED** `3d3d766cc` — Cap exact-path 1 file; three regex layers pinned. |
| **AppStore → Host metadata cutover** | `@SolBoss` sequencing (recon `@SolWork`) | 🔍 **RECON ONLY** — HostSnapshot metadata-only; transcripts excluded by design; recommend providers-first (`host-arc-appstore-cutover-gap-map-measured`). |
| **iOS paired projection** | Downstream of Mac/Desktop cutover (recon `@GrokWork`) | 🔍 **RECON ONLY** — already e2ee-v1 projection client; zero Host types in `ios/`; Swift 6.2.4 + Kit **868/115** green; do **not** port HostSnapshot to Swift (churn, not technique — e2ee already vector-pinned). |
| **Wave 4.3b — Desktop commands** | `@SolBoss` sequencing | **Unblocked** by 4.2c + consuming view (4.3d/4.3e); after live Electron Host observation. |
| **Live Electron `taskwraith-host-v2.json`** | Wave 4.5 harness + rebuild/launch | **STILL never observed** — Node 4.4 / 4.6 ≠ Electron Host; 4.5 script land ≠ observation |
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
| `.WORK-IN-PROGRESS-host-arc-wave44-boot-proof.md` | **Absent** | n/a (4.4 Cap-landed `402f34e0e`) |
| `.WORK-IN-PROGRESS-host-arc-wave43c-desktop-consumer.md` | **Absent** | n/a (4.3c Cap-landed `1269e3fc7`) |
| `.WORK-IN-PROGRESS-host-arc-wave43d-leaf-consumer.md` | **Absent** | n/a (4.3d Cap-landed `e63add3c7`; authored without marker) |
| `.WORK-IN-PROGRESS-host-arc-wave45-electron-observe.md` | **Absent** | n/a (4.5 Cap-landed `f1f950207`; authored without marker) |
| `.WORK-IN-PROGRESS-host-arc-wave46-tui-live.md` | **Absent** | n/a (4.6 Cap-landed `d7b44f23c`; authored without marker) |
| `.WORK-IN-PROGRESS-host-arc-wave43e-*.md` | **Absent** | n/a (4.3e Cap-landed `f370800da`; markers not required) |
| `.WORK-IN-PROGRESS-host-arc-wave46a-*.md` | **Absent** | n/a (4.6a Cap-landed `3d3d766cc`; markers not required) |

Foreign markers present (not Host Arc): `.WORK-IN-PROGRESS-observatory-gpu-calm.md`, `.WORK-IN-PROGRESS-seat-strip-desktop.md`, `.WORK-IN-PROGRESS-tool-event-dual-lane-dedupe.md`.

`@SparkDocs` note: this Cursor seat has **`TASKWRAITH_LOCK_OWNER_ID` absent**; **no docs marker raised** (Boss ruling). Waves through **4.6a** `3d3d766cc` **LANDED**; production Host **STILL never observed running under Electron**. This file records **DONE** waves only (`host-arc-docs-must-record-DONE-never-IN-FLIGHT`); commit status is `git log`, not this file.

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
| AC1–AC6 | ⚠️ **PARTIAL** | Host **wiring** ON in main (`b45d4297f`). Wave **4.4** proves Node production composition boots/serves/stops (`402f34e0e`). Wave **4.6** proves first real client round trip (`d7b44f23c`); Wave **4.6a** hardens the connection pin (`3d3d766cc`). Wave **4.3d/4.3e** Desktop **consumes** Host in ungated UI (`e63add3c7` / `f370800da`). Wave **4.5** harness **LANDED** (`f1f950207`) — **landing a script does not flip PASS.** Production Host **STILL never observed running under Electron** (zero `taskwraith-host-v2.json`). Packaged app in `dist/` predates R4'; `npx electron-vite build` rewrites `out/` only — the 4.5 harness opens a packaged `.app`, so unpackaged rebuild alone does **not** enable observation. TUI read+commands+live round trip in HEAD; iOS is e2ee-v1 projection client (Mac still AppStore-derived — no Host v2 on phone; Kit **868/115** green). Socket **unit** suite **CLOSED** seat-specific (Claude + Pi LISTEN OK; Cursor may EPERM). Fake Host / Node boot-test / harness land ≠ Electron boot. **Never PASS.** |
| AC7–AC8 | ⚠️ PARTIAL | Host core authoritative; TUI is first full (read+command+live) projection client; Desktop mounts **and** consumes Host projection ungated (AppStore still authority for most views); iOS already e2ee-v1 projection client (not Host v2) — Mac still derives remote snapshots from AppStore |
| AC9 | ❌ **NOT STARTED** | `.twmission` / mission evidence not started (Wave 5) |
| AC10–AC11 | ⚠️ PARTIAL | TUI read+command+live paths live in HEAD; Desktop pure + wire + adapter + mount + leaf + ungated placement landed; Desktop commands not started; iOS Host-shaped work is Mac-side (downstream of AppStore cutover), not a Swift Host port |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | Path-scoped evidence only; Wave 4 TUI uses `typecheck:tui`; Desktop pure/adapter/consumer uses `typecheck:web`; wire/preload needs **node+web**; protocol slice needs **node+tui**; 4.4 uses `typecheck:node` |
| AC15 | ✅ PASS | No forbidden path drift in scoped arc Cap lands (4.6a exact-path 1; 4.3e exact-path 2; 4.5 exact-path 1; 4.6 exact-path 1; 4.3d exact-path 3; prior exact-path lands stand) |

---

## Handoff Conventions (current roster)

**Authority:** `@SolBoss` (Boss) · `@GrokCapt` (Captain) · `@K3Review` (final validation gate)

**Aliases:** `@SparkDocs` `@MistralScout` `@DSeekScout` `@K2.7Scout` `@CursorScout` `@DSeekWork` `@GemProWork` `@GrokWork` `@SolWork` `@CursorWork` `@MistralReview` `@GrokReview` `@K3Review` `@GrokCapt` `@SolBoss`

Commits are exact-path only; markers with honest live pid **or** `lockOwnerId` and adopter-window expiry; drop on adopt. Workers leave validated handoffs; Cap commits post-review. **One owner per gate.** Live suite at adopt = shell-capable seat. **Nobody commits from work seats on the current fan-out** — validated handoff to `@GrokCapt`. Scouts do not score live lanes. **Socket evidence** = Claude / Pi seats (Cap discloses Cursor `EPERM`). Fan-out lanes: markers **not required** this round.

---

## Forbidden Paths (zero diff)

- `src/main/workLocks/**`, `WorkspaceLock*`, `WorkspaceMutationClaims*`
- `src/main/workProvenance/**`, workspace-lock marker/provenance behavior
- `scripts/work-guard*`, `.githooks/**`
- Provider admission / retirement / live membership / security ceilings
- Unrelated history-deletion machinery
- Composition roots (`index.ts`, `App.tsx`, `EnsembleOrchestrator.ts`) — tiny wiring hunks only, with Boss/Cap clearance (R4' already landed under that rule)

---

## User Notes (standing)

- Release claim on `index.ts` / `App.tsx` as soon as editing on those shared files finishes.
- New files must be born formatted; continue ratchet-friendly doc edits.
- QA remains with user.
- Rebuild / isolated Electron launch for 4.5 evidence remains a **user** decision — not a lane default.

---

## References

- Goal: [`HOST_ARC_GOAL.md`](./HOST_ARC_GOAL.md)
- Baseline: [`HOST_ARC_WAVE0_BASELINE.md`](./HOST_ARC_WAVE0_BASELINE.md)
- Blackboard: `host-arc-wave3-closed-four-shas`, `host-arc-wave4-sequencing-ruling`, `host-arc-r4prime-adopt-authorized`, `host-arc-r4prime-does-NOT-pass-ac1-6`, `host-arc-production-host-has-never-actually-run`, `host-arc-socket-gap-CLOSED-seat-specific-not-environmental`, `host-arc-socket-epern-validation-gap` (superseded), `host-arc-43a-wire-and-adapter-verified-by-boss`, `host-arc-43a-adapter-chain-complete-appts-next`, `host-arc-43c-maints-wrap-corrects-my-own-ruling`, `host-arc-43c-already-ruled-stop-asking`, `host-arc-44-production-boot-proof-is-now-possible`, `host-arc-44-fake-composition-claim-is-FALSE-adjudicated`, `host-arc-44-boot-proof-REAL-COMPOSITION-BOOTS`, `host-arc-electron-observation-is-NOT-ops-a-harness-exists`, `host-arc-45-my-red-preauthorisation-was-a-trap-grokwork-caught-it`, `host-arc-45-harness-authored-plus-pgrep-guard-defect`, `host-arc-45-SUPERSEDED-app-fails-closed-not-open`, `host-arc-45-path-fixed-and-the-app-FAILS-CLOSED-not-open`, `host-arc-46-first-real-client-round-trip-and-two-overclaims-corrected`, `host-arc-46a-connection-pin-is-timing-dependent-and-worse-than-flagged`, `host-arc-46a-BLOCKED-regex-matches-DISCONNECTED`, `host-arc-46a-NOT-CONNECTED-is-reachable-from-product-code`, `host-arc-appstore-cutover-gap-map-measured`, `host-arc-ios-recon-already-a-projection-client-downstream-of-lane-A`, `host-arc-ios-toolchain-PRESENT-and-docs-header-lies-about-itself`, `host-arc-ios-kit-baseline-868-green-and-my-mirror-claim-was-too-broad`, `host-arc-docs-must-record-DONE-never-IN-FLIGHT`, `host-arc-cutover-and-ios-recon-only-not-implementation`, `host-arc-43e-host-consumer-must-not-live-behind-the-ios-flag`, `host-arc-43e-placement-pin-is-two-sided-and-red-proved`, `host-arc-43d-sidebar-is-prettier-dirty-do-not-write`, `host-arc-renderer-restart-per-window-store-is-CORRECT-not-a-defect`, `host-arc-markers-not-required-in-fanout-lanes-my-fix-failed`, `host-arc-lane-scope-omits-granted-marker-paths`, `host-arc-42c-one-field-grokwork-contest-upheld`, `host-arc-43a-cleared-and-wire-carveout-granted`, `host-arc-do-not-score-a-live-lane`, `host-arc-review-seats-have-no-shell`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures byte-verified against live git + markers at time of writing · records DONE only · commit status is `git log`, not this file.
