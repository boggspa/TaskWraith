# Host Arc — Status & Progress Tracker

**Documentarian:** `@SparkDocs` (paperwork owner) · **This refresh:** `@SparkDocs` (Boss rule `host-arc-docs-must-record-DONE-never-IN-FLIGHT` — record closed Cap lands only; never in-flight wire/adopt prose)  
**Last updated:** 2026-08-06T21:00Z continuous round  
**Branch ahead of origin/master:** moving (`git log --oneline -1` is authoritative for HEAD)  
**Overall completeness:** **Wave 3 CLOSED** — four SHAs (`18ec305f9`, `a12f2840a`, `80b1284c5`, `b45d4297f`). **Wave 4.2a–c** + **4.3a pure/wire/adapter** + **Wave 4.4** `402f34e0e` + **Wave 4.3c** `1269e3fc7` + **Wave 4.3d** `e63add3c7` + **Wave 4.6** `d7b44f23c` + **Wave 4.5** `f1f950207` + **Wave 4.3e** `f370800da` + **Wave 4.6a** `3d3d766cc` + **Wave 4.8** docs `998dde2cd` + **R4'-patch** `7abaf33be` + **Step 3 (a')** `9ef9e0361` + **Wave 4.3b** `d2c79bd57` + docs tip `7096defbe` + **Step 5a** `266f20435` + harness timeout `3f521753e` + **Step 5b-port** `6c9658d6d` + **Step 5b-admission** `5bce10bac` + **Step 5b-wire** `cf3b03eb7` + docs `95bd8587a` + **Wave 5d** `215c03849` all **LANDED**. Node production composition boots/serves/stops under test; TUI proves first **real** client round trip against real Host sockets; Desktop mounts provider **and** reads Host via ungated `HostStatusRow` (Approvals) **and** has Desktop command/receipt IPC plumbing (`d2c79bd57` — capability, **not** AppStore authority cutover) **and** projects the `providers` family leaf (`266f20435`). **Does NOT** retire AppStore authority. AC1–6 **PARTIAL** (never PASS). **Host publishes under Electron** (`host-arc-58-…`): discovery **0600** + token **0600** + real socket (`srw-------`) + listener **ACCEPTS** + clean teardown — proven on **three** independent profiles (`workspaces=8` / `threads=45` on the third prove the chatList port serves real data). Socket suite **CLOSED as seat-specific** — durable seat matrix: **Claude = LISTEN OK · Pi = LISTEN OK · Cursor = EPERM**. **5b-wire** `cf3b03eb7` injects the admission port at the composition root via a late-bound thunk (`() => getConfiguredProviderSnapshot()`) — **not** a hoist; zero domain logic in root. **Providers** is the **5th real family**. **Wave 5d** `215c03849` stops fabricating telemetry when the provider source is not ready: readiness travels as typed warning code `provider_source_not_ready` (no protocol version bump); Desktop paints **Unknown**, not a confident zero; genuine measured zero after ready still paints **None reported**. **Source population remainder** (`host-arc-61-…`): **five** real (health, workspaces, threads, usage, providers) and **nine** still hardcoded empty (runs, missions, rounds, participants, questions, approvals, schedules, artifacts, warnings) — the goal names all fourteen. Empty `providers` on early **and** late Electron probes remains **permanently inconclusive** from outside for *population* — `ready` is not a snapshot field; no further launches/probes for that question. **AppStore metadata cutover** / **iOS** remain open sequencing (recon maps exist). **iOS Kit reachable:** Swift **6.2.4**; `test:swift:ios-kit` = **868/115 green ~6s** (warm cache).

---

## ⚠ CRITICAL DISTINCTION — “Host is ON” ≠ “clients retired AppStore”

**HOST PUBLISHES UNDER ELECTRON** (`host-arc-58-HOST-PUBLISHES-UNDER-ELECTRON-start-serve-stop-PROVEN`). Wave **4.8**’s “constructs but never publishes” finding is **historical** (pre–Step 3 guard fix). Do **not** restate it as current.

| Claim people will misread | What is actually true |
|---|---|
| “Host is ON” | **Wiring is committed** in Electron main (`b45d4297f`). **R4'-patch** `7abaf33be` wraps construction in `try/catch`. **Step 3** `9ef9e0361` makes the production `AppStore` class pass the chatList guard. |
| “Host has booted / is listening” | **Observed under Electron** (`host-arc-58-…`): `taskwraith-host-v2.json` mode **0600**, token **0600**, socket `srw-------`, `net.connect` **ACCEPTS**, clean teardown removes all three. Identity alone was never enough; discovery+listener is. |
| “Desktop commands cut over” | **FALSE.** Wave **4.3b** `d2c79bd57` lands **capability** (IPC + `HostCommandClient` / `hostCommandFlow`). **No** App.tsx / composer consumer; AppStore remains primary Desktop authority. |
| TUI Fake Host v2 green | **Client-path evidence over TCP loopback** in-process. Proves connect → snapshot → (4.2b) command submit / receipt poll / deferred ask. **Does not** prove live production Host under Electron. |
| Wave **4.6** TUI live integration green | **FIRST REAL CLIENT ROUND TRIP** in the arc (`host-arc-46-first-real-client-round-trip-and-two-overclaims-corrected`). **LANDED** `d7b44f23c`. Real composition + real unix socket + real `TaskWraithTui`; kill-the-Host RED-proof. Cap Cursor seat **EPERM** disclosed; Pi/Claude suite accepted. |
| Socket suite / `EPERM` | **CLOSED as seat-specific, not environmental.** **Seat matrix:** Claude = **LISTEN OK** · Pi = **LISTEN OK** · Cursor = **EPERM**. Cap discloses Cursor `EPERM` rather than claiming sockets. |
| Wave **4.4** Node boot proof green | **LANDED** `402f34e0e`. Proves real composition + real server under **Node**. **Not** Electron launch by itself. |
| “Electron observation is ops, not code” | **FALSE** (`host-arc-electron-observation-is-NOT-ops-a-harness-exists`). Wave **4.5** harness **LANDED** `f1f950207`. Live publish proof is `@GrokWork` hostobs (`host-arc-58-…`), not the script land alone. |
| “AC1–6 will PASS when Host publishes” | **FALSE.** Process half closed; **two remainders** stay: (1) **client projections** (AppStore authority cutover, iOS Host-shaped path) and (2) **source population** — ten of fourteen HostSnapshot families still hardcoded empty at the donor (`host-arc-61-…`). AC1–6 stay **PARTIAL**. |
| “Providers leaf means Host is populated” | **FALSE — SUPERSEDED by 5b-wire `cf3b03eb7`.** Step **5a** `266f20435` paints `providers` on Desktop. Step **5b-port/admission** land the conduit + mapper. **5b-wire** `cf3b03eb7` **does** inject the admission port — providers is the **5th real family**. Any prose saying “without an injected admission port… live Electron still paints None reported” is **FALSE** since that SHA. |
| “Live + empty `providers` = measured none / None reported” | **FALSE after Wave 5d `215c03849` when source is not ready.** Pre-5d, `ready:false` → `providers:[]` with no warning → Desktop painted **None reported** (fabricated telemetry — goal invariant). **5d** emits warning code `provider_source_not_ready`; leaf paints **Unknown**. Genuine measured zero after `sourceReady` still paints **None reported** (regression guard). |
| “Empty `providers` on live Electron proves the wire failed / succeeded” | **FALSE — permanently inconclusive from outside for population.** Early **and** late probes returned `providers: []`; `ready` is **not** a snapshot field, so external observation cannot settle population. **No further launches or probes.** Honesty of not-ready vs measured-zero is settled in code by **5d**, not by another hostobs. |
| “Welcome-modal green Cursor = Host `confirmedConfigured`” | **FALSE.** Modal cards take props from App.tsx (`agentStatusByProvider` / auth objects). Host admission reads `statusSnapshot().configuredProviders`. `configuredProviderProbes` has **six** entries (codex/claude/kimi/ollama/pi/antigravity) — **Cursor is not probed**. A green Cursor dot cannot validate the Host family. |
| “Pristine userData profile = unconfigured app” | **FALSE.** CLI logins, PATH binaries, and local daemons are **machine-scoped** and survive a fresh profile. Detector inputs are not `settings.configuredProviders` (often undefined). |
| “N of N available = runtime health” | **FALSE.** Admission sets `available: true` for every configured row — meaning **admitted in the configured snapshot**, not process health. Named honesty debt; do not invent a health signal in the wire. |
| “Invalid package-smoke profile degrades to production” | **FALSE — SUPERSEDED** (`host-arc-45-SUPERSEDED-app-fails-closed-not-open`). The app **FAILS CLOSED**. |

Do **not** inherit “never publishes” from Wave **4.8** prose after Step 3 + hostobs. Wave 4.4 Node ≠ Electron publish. Wave 4.6 Node+TUI ≠ Desktop AppStore cutover. **4.3b plumbing ≠ authority cutover.** **5a leaf ≠ source population.** **5b-port/admission ≠ composition-root wire** (that is `cf3b03eb7`). **Empty wire `providers` ≠ proof either way for population.** **5d honesty ≠ AppStore cutover** and does **not** populate the nine empty families.

---

## Current Gate State

| Gate | Status | Owner | Notes |
|---|---|---|---|
| **Wave 2E-1** (HostSession + HostBridgeCommandExecutor) | ✅ **PASS** | `@SolBoss` | Landed earlier this arc |
| **Wave 2E-2A** (Primitives A–E) | ✅ **PASS** | `@SolBoss` | Receipt position, actionId binding, read-alias gate, bootstrap recovery |
| **Wave 2E-2B** (Deferred allow + Authority integration) | ✅ **PASS** | `@SolBoss` / `@GrokCapt` | Resolver `verifyCommand` split @ `aceb0993a`; `HostDeferredAllowPipeline` @ `9d4a2a104`; micro-fix @ `167f6916b` |
| **Wave 2E-2C** (typecheck debt) | ✅ **PASS** | `@DSeekWork` | `joinFor` cleanup @ `5a0761793`; Ruling-C complete |
| **Wave 3** (Dedicated Host + supervision) | ✅ **CLOSED** | `@SolBoss` / `@GrokCapt` | Substrate + Gates 1/2/3.6e + R4' wiring + **R4'-patch** + **Step 3 (a')** all committed. Host **wiring ON** in main. AC1–6 → **PARTIAL** (not PASS). Host **publishes** under Electron (`host-arc-58-…`). |
| **Wave 4** (Desktop / TUI / paired iOS cutovers) | 🔄 **ACTIVE** | `@SolBoss` / `@SolWork` / `@GrokCapt` / `@GrokWork` / `@DSeekWork` / `@GemProWork` / `@CursorWork` | Order ruled **TUI → Desktop → iOS**. Prior Wave 4 Cap lands + **Step 5a** `266f20435` + harness `3f521753e` + **5b-port** `6c9658d6d` + **5b-admission** `5bce10bac` + **5b-wire** `cf3b03eb7` + **Wave 5d** `215c03849` **LANDED**. Desktop Host consumer **ungated** (`f370800da`). Host **publishes** under Electron. **4.3b** = command **capability** (not AppStore cutover). **5a** = providers **projection leaf** (not cutover). **5b-wire** injects admission port — providers **5th real family**. **5d** = provider-readiness honesty (warning code; no protocol bump). Source: **5 real / 9 still empty** families. AppStore metadata cutover / iOS = open sequencing. |
| **Wave 5** (`.twmission` flight recorder) | NOT STARTED | `@SolBoss` | Blocked by Waves 3–4 progress; AC9 still NOT STARTED |
| **Wave 6** (Adversarial review + final gates) | NOT STARTED | `@SolBoss` | Socket **unit** gap closed (seat-specific). Process publish proven; still blocked by remaining client cutover + adversarial gates |

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
- **Runtime observation (later):** Wave **4.8** recorded constructs-without-publish (historical). **Current:** Host **publishes** under Electron after Step 3 (`host-arc-58-…`).

### R4'-patch — catch construction throws before `start()` attaches — ADOPTED

- **SHA:** `7abaf33be`
- **Path:** `src/main/index.ts` **only** · numstat `20\t10`
- **Author:** `@SolWork` · **Adopter:** `@GrokCapt`
- **Landed shape:**
  1. `let hostSupervisor: ReturnType<typeof createHostProductionBootstrap> | undefined`
  2. `try { hostSupervisor = createHostProductionBootstrap(...) } catch` logs `[host] production Host failed to construct` with the **error object** (no hand-format)
  3. `hostSupervisor?.start().catch(...)` outside the try — start failures stay distinct
  4. `will-quit` `hostSupervisor?.stopSync()` **untouched**
- **Why:** Wave **4.8** proved identity can be written while construction throws **before** `.start().catch()` ever attaches — silent healthy app, no `[host]` line, no socket dir.
- **What this SHA proves / does not:** Proves construct failures are **observable**. Does **not** prove Host publishes. Does **not** fix the named `chatList` throw.

### Named throw (post–R4'-patch hostobs) — DONE observation

Measured by `@GrokWork` after rebuild (stale-bundle trap avoided — chunk `BtW5Ij__` → `IVOcX63k`; wrap string present in bundle before launch):

```text
[host] production Host failed to construct Error: HostProductionBootstrap requires an injected chatList
```

| Fact | Location |
|---|---|
| Guard (pre-fix) | `HostProductionBootstrap.ts` — `typeof options.chatList !== 'object'` |
| Production inject | `index.ts` — `chatList: AppStore` |
| Runtime | `typeof AppStore === 'function'` (export **class** with `static getChatList`) |
| Why tests missed it | Suite injects object-literal mocks; production passes the class |

**Boss ruling (binding, `host-arc-57-STEP3-RULED-A-PRIME-check-the-METHOD-not-the-container`):** Step 3 is **(a')** — validate the **method** (`typeof getChatList === 'function'`), not the container's `typeof === 'object'`. Module contract already says the root may pass the class with statics directly. Re-entrancy registry **returns**, never throws (`host-arc-55-…`). Bridge twin: multi-method port — do **not** invent a 9-method checker in the same breath; report and leave.

### Step 3 (a') — chatList method guard — **LANDED**

- **SHA:** `9ef9e0361` — `fix(host): validate chatList method not container typeof (Wave Step 3)`
- **Author:** `@GemProWork` · **Adopter:** `@GrokCapt`
- **Paths:** `HostProductionBootstrap{,.test}.ts` only · **zero** forbidden roots
- **Landed shape:** guard checks `typeof options.chatList.getChatList !== 'function'` (method, not container); comment says class/method; RED-first pins — class-with-statics **accepts**, `{}` **rejects**
- **Cap evidence:** focused **34/34**; Cursor host-glob sockets **EPERM** disclosed; production-validated by `@GrokWork` hostobs (no construct throw after rebuild)
- **Bridge twin:** deferred by measurement — `HostBridgeActionPort` has **9** methods; not a mechanical copy of the chatList fix
- **What this does NOT prove alone:** Electron publish (that is `host-arc-58-…`); AppStore cutover; Desktop UI command consumer

### Host publishes under Electron — DONE observation (`host-arc-58-…`)

Measured by `@GrokWork` after Step 3 bytes were in the **rebuilt** bundle (working-tree build; Cap adopt orthogonal). Rebuild proven by symbol **flip** (old `chatList!=="object"` → **0**; new `getChatList!="function"` → **1**; chunk `IVOcX63k` → `C_PdemB3`):

| Fact | Evidence |
|---|---|
| Discovery | `taskwraith-host-v2.json` · **316** bytes · mode **0600** under `TaskWraith Dev hostobs` |
| Token | mode **0600** |
| Socket | `srw-------` (leading `s` = real socket); dir hash **`783023263b28f438`** |
| Listener | `net.connect(socketPath)` → **CONNECT OK** (stays silent until authenticated hello — correct) |
| Teardown | kill → discovery **removed** · token **removed** · socket **removed** |
| Log | **zero** `[host] failed to construct` / `failed to start` lines |

**Does NOT prove:** authenticated client round trip under Electron (4.6 was Node+TUI); packaged `.app` Host; AppStore authority retirement. Poll window lesson: discovery absent at **40s**, present by **70s** — use **≥120s**; timeout = **inconclusive**, never “Host failed”.

### WAVE 4.3b — Desktop command/receipt IPC — **LANDED**

- **SHA:** `d2c79bd57` — `feat(host): add Desktop Host command/receipt IPC path (Wave 4.3b)`
- **Author:** `@CursorWork` · **Adopter:** `@GrokCapt`
- **Paths (exact-path):** `hostProjectionHandlers{,.test}.ts`, preload conduits, `hostCommandFlow{,.test}.ts`, `HostCommandClient{,.test}.ts`, transport types — **no** `index.ts` / `App.tsx` / `EnsembleOrchestrator.ts`
- **What landed:** caps include `commands`/`receipts`; `command-submit` + `receipt-lookup`; `approval.decide` as command **name** via submit; pending/`authority.ask` **never** success; poll 200ms→1.5s / 60s
- **Cap evidence:** focused **28/28**; `typecheck:node` + `typecheck:web` owned **0** errors (foreign AC14 + `Sidebar.test.tsx` residual)
- **Honest limit:** plumbing + tests only — **zero** production UI call sites outside `lib/host/**`. **Capability, not authority cutover.**

### Step 5a — Desktop `providers` projection leaf — **LANDED**

- **SHA:** `266f20435` — `feat(host): project Host providers into Desktop status row (Step 5a)`
- **Author:** Cap-landed Desktop projection + `HostStatusRow` · **Adopter:** `@GrokCapt`
- **Paths (exact-path four):** `hostSnapshotProjection{,.test}.ts`, `HostStatusRow{,.test}.tsx`
- **What landed:** allowlisted `projectProvider` (no credential spread); `describeHostProviders` honesty — not-live/cached → **Unknown** (never fabricated `0`); live+empty → **None reported**; live+rows → `N of M available`; second footer row “Host providers”
- **What this does NOT prove:** AppStore cutover; production supplier population of the other nine empty families; that live Electron ever returns a non-empty `providers` array (empty wire reads remain permanently inconclusive — `ready` is not on the wire)

### 4.5 harness — discovery timeout = inconclusive — **LANDED**

- **SHA:** `3f521753e` — `fix(host): treat Electron Host smoke discovery timeout as inconclusive`
- **Author:** `@GrokWork` · **Adopter:** `@GrokCapt`
- **Path:** `scripts/smoke-host-boot-electron.cjs` **only** · `+75/−18`
- **Landed shape:** `DEFAULT_DISCOVERY_TIMEOUT_MS = 120_000` (was **30_000**); new `EXIT_INCONCLUSIVE = 22` ≠ `EXIT_HOST_DID_NOT_BOOT = 1`; timeout message says **INCONCLUSIVE — NOT A PROVEN HOST DEFECT** (still non-zero exit so CI cannot green on silence)
- **Honest limit:** script has **ZERO** in-repo test coverage. Earlier “20/20 assertions” test file was write-scope refused and never landed (`@GrokWork` corrected that claim). Landing ≠ Electron observation.

### Step 5b-port — provider list conduit — **LANDED**

- **SHA:** `6c9658d6d` — `feat(host): inject provider list port into production suppliers (Step 5b-port)`
- **Author:** `@GemProWork` · **Adopter:** `@GrokCapt`
- **Paths:** `HostProductionSuppliers{,.test}.ts`, `HostProductionBootstrap.ts` · **zero** forbidden roots
- **Landed shape:** `HostProductionProviderListPort.getProviders()`; optional on bootstrap options; method-level guard; supplier try/catch → `[]` on throw/omit (**unavailable ≠ crash**); RED pins mutation-proved
- **What this does NOT prove (at this SHA alone):** live Electron providers rows — without composition-root injection the conduit still yields **`[]`**. Injection lands later at `cf3b03eb7`.

### Step 5b-admission — configured snapshot → Host rows — **LANDED**

- **SHA:** `5bce10bac` — `feat(host): map configured providers into Host admission rows (Step 5b-admission)`
- **Author:** `@CursorWork` · **Adopter:** `@GrokCapt`
- **Paths:** `HostProductionProviderAdmission{,.test}.ts`, `HostProductionBootstrap.test.ts` (providers guard pins)
- **Landed shape:** thin `getConfiguredSnapshot()` deps port; `ready !== true` → `[]`; allowlisted wire fields only; notes ∈ `{configured, conditional-offer}`; credential/`baseUrl`/header/free-form note poison stripped; re-reads every `getProviders()` (no stale construct cache)
- **Honest debt (recorded, not a Cap reopen):** `available: true` is unconditional per configured id — **admitted**, not runtime-healthy
- **What this does NOT prove:** composition-root injection into Electron bootstrap; nine other empty families; AppStore authority cutover

### Step 5b-wire — composition-root injection — **LANDED**

- **SHA:** `cf3b03eb7` — `feat(host): wire provider admission into Electron Host bootstrap (Step 5b-wire)`
- **Author:** `@SolWork` · **Adopter:** `@GrokCapt`
- **Path:** `src/main/index.ts` **only** · `+15/−1`
- **Landed shape:** one `providers:` property added to R4' production bootstrap call; late-bound thunk (`() => getConfiguredProviderSnapshot()`); **zero** lines hoisted or moved; **zero** domain mapping in root (admission module owns all mapping)
- **Load-bearing detail:** the arrow closure is mandatory — passing the identifier directly hits TDZ ReferenceError because `getConfiguredProviderSnapshot` is a `const` arrow declared ~3,900 lines later in the same `whenReady` block
- **Fail-closed net is double:** Layer 1 (admission try/catch → `[]`) fires before Layer 2 (supplier try/catch → `[]`). Both are load-bearing; neither may be tidied as "redundant"
- **Gate evidence:** `typecheck:node` **0** Host errors (3 foreign AC14); host suite **950/950** (37 files) zero regressions; focused admission+suppliers+bootstrap **85/85**
- **Observation limits (binding, post–`cf3b03eb7`):** Host publishes / authenticates / serves under Electron on **three** independent profiles; `workspaces=8` / `threads=45` prove the chatList port. Early **and** late probes still returned `providers: []` — that is **permanently inconclusive from outside** because `ready` is not on the wire. **No further launches/probes** for providers population. Welcome modal ≠ Host wire (six probes; Cursor not among them). “Pristine profile” ≠ “unconfigured app” (machine-scoped CLI/PATH/daemons). Code-level evidence (typecheck + suite) stands; empty observation does **not** prove wire-broken or wire-absent.
- **What this CLOSES:** providers family is now wired from source through admission → suppliers → HostSnapshot — **5th real family** (was `[]`)
- **What this does NOT close (at this SHA alone):** 9 remaining empty families; AppStore authority cutover; iOS; honesty of “None reported” vs not-ready — **closed later by Wave 5d `215c03849`**

### Wave 5d — provider-source readiness honesty — **LANDED**

- **SHA:** `215c03849` — `fix(host): stop fabricating provider telemetry when source is not ready (Wave 5d)`
- **Author:** `@SolWork` · **Adopter:** `@GrokCapt`
- **Paths (exact-path nine):** `hostProtocol.ts`, `HostProductionProviderAdmission{,.test}.ts`, `HostProductionSuppliers{,.test}.ts`, `hostSnapshotProjection{,.test}.ts`, `HostStatusRow{,.test}.tsx` · **+357/−12** · **zero** forbidden roots
- **Design:** `providers` stays a **required** array (no protocol version change). Readiness travels as typed warning code `HOST_WARNING_PROVIDER_SOURCE_NOT_READY` = `provider_source_not_ready` (snake_case; `warningId: \`${code}:${detail}\``). Chain: `admission.readProviders()` → `{ providers, sourceReady }` (one snapshot read) → supplier emits warning when `!sourceReady` → projection exposes `warningCodes[]` (codes, never message prose) → leaf: code present → **Unknown**; absent → real count / **None reported**
- **RED-first + mutation-proved:** 11 RED against pre-fix bytes; mutation proofs — stop emitting warning (3 RED); stop consulting code (1 RED); always claim Unknown (7 RED, including genuine-zero regression guard)
- **Gate evidence (author handoff, Cap re-verified at adopt):** focused **100/100**; host glob **958/958** (37 files); renderer host **61/61**; `typecheck:node` / `typecheck:web` **0** owned (foreign residuals elsewhere); Prettier owned clean
- **Named follow-ups (not reopen):** (1) absent provider port still treated ready / `warnings: []` — preserves `@GemProWork` L169 pin; (2) warning `severity: 'info'` (startup-transient, not fault)
- **What this CLOSES:** fabricated “None reported” when source meant “not yet known” (`host-arc-64-…`)
- **What this does NOT close:** 9 empty families; AppStore authority cutover; iOS; admission `available: true` honesty debt; population of live `providers` rows (still externally inconclusive)

### Production supplier families (binding scope fact) — `host-arc-61-…`

| Kind | Families |
|---|---|
| **REAL today** | health · workspaces · threads · usage · providers |
| **Hardcoded empty until a port/donor fills them** | runs · missions · rounds · participants · questions · approvals · schedules · artifacts · warnings |

The goal names **all fourteen**. Client-projection work and source-population work are **two remainders**. Recording **5a/5b-port/admission** must not be read as “the arc is nearly done.”

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

**Host process wiring in main: ON** (`b45d4297f` + R4'-patch `7abaf33be` + Step 3 `9ef9e0361`).  
**Host process observed listening under Electron: YES** (`host-arc-58-…` — discovery + token + real socket + accept + clean stop).

**AC1–6: PARTIAL — never write PASS** (`host-arc-r4prime-does-NOT-pass-ac1-6`, updated after Electron publish):

- Process half (wiring): **yes**.
- Process half (Node production composition boot under test): **yes** — Wave **4.4** `402f34e0e`.
- Process half (observed under Electron): **publishes** — `host-arc-58-…` (start → serve → clean stop). Wave **4.8** “never publishes” is **superseded** after Step 3.
- Client projections: **TUI read/command/live**; Desktop **transport + mount + leaf + ungated** + **command capability** (`d2c79bd57`); **no** AppStore→Host authority cutover; paired-iOS still e2ee-v1 (zero Host v2 types in `ios/`).
- Approval correlation on the wire: ✅ **LANDED** `b74b33e33`.
- Desktop command plumbing: ✅ **LANDED** `d2c79bd57` — **not** a UI cutover.

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
| **4.3b** Desktop command cutover | ✅ **LANDED** `d2c79bd57` | `@CursorWork` / `@GrokCapt` | Desktop command/receipt IPC + `HostCommandClient` / `hostCommandFlow`. Caps `commands`/`receipts`. Pending ≠ success. **Capability only** — **no** App.tsx consumer; AppStore still primary authority. Cap: **28/28** focused; owned typecheck clean. |
| **4.3c** Desktop UI mount | ✅ **LANDED** `1269e3fc7` | `@SolWork` / `@GrokCapt` | Exact-path **3** files: `HostProjectionProvider{,.test}.tsx` + `main.tsx`. Provider wraps App + PopoutApp **inside** ErrorBoundary; **App.tsx untouched**; **ZERO forbidden roots**. Mount ≠ consumption. Does **not** retire AppStore authority. |
| **4.3d** Desktop leaf consumer | ✅ **LANDED** `e63add3c7` | `@SolWork` / `@GrokCapt` | Exact-path **3** files · `+294` · `HostStatusRow{,.test}.tsx` + `Sidebar.tsx` **+6/0**. First production UI call site for `useHostProjection`. unavailable ≠ cached wording; LED only on `live`. Cap live: vitest **53/53** (5 files) · `typecheck:web` zero owned on HostStatusRow. **Do NOT** `prettier --write` `Sidebar.tsx` (pre-dirty at HEAD; would rewrite ~3433 lines). App.tsx untouched. *(Original mount was Devices popover; relocated by 4.3e.)* |
| **4.3e** Host consumer out of iOS-flag chrome | ✅ **LANDED** `f370800da` | `@SolWork` / `@GrokCapt` | Exact-path **2** files · `+53/−7` · `Sidebar.tsx` + `HostStatusRow.test.tsx`. Boss ruling `host-arc-43e-host-consumer-must-not-live-behind-the-ios-flag` / `@K3Review` F1 closed. `HostStatusRow` **only** in ungated `ApprovalsFooterPopover`; **removed** from Devices; two-sided red-first placement pins (`IOS_REMOTE_ENABLED: false` mock). Cap live: focused **12/12** · **55/55** across 5 Host files · `typecheck:web` zero owned. **Do NOT** `prettier --write` `Sidebar.tsx`. `HostStatusRow.tsx` unchanged. |
| **4.4** Production boot proof (Node) | ✅ **LANDED** `402f34e0e` | `@GrokWork` / `@GrokCapt` | Exact-path **1** file · `+272/−0` · `HostProductionBootstrap.boot.test.ts` only. Omits both seams (`createComposition` / `createServer`); real composition + real server. BOOT → SERVE → STOP against `fs.mkdtemp`. Identity on **`welcome.hostId`**, not snapshot. Cap: Prettier clean · `typecheck:node` zero owned · Cursor sockets **EPERM disclosed not claimed** · accept GrokWork Claude **6/6** + host **929/929**. CursorScout fake-`createComposition` claim adjudicated **FALSE**. **Proves Node boot; does NOT prove Electron Host.** |
| **4.5** Electron Host boot smoke harness | ✅ **LANDED** `f1f950207` + timeout fix `3f521753e` | `@GrokWork` / `@GrokCapt` | Exact-path script. Stale-bundle gate intact. **`3f521753e`:** default discovery timeout **120s**; timeout → `EXIT_INCONCLUSIVE=22` (not Host-did-not-boot). **Zero in-repo tests** for the script. **Nothing launched by land.** **AC1–6 do not flip PASS.** |
| **4.6** TUI vs real Host (first client round trip) | ✅ **LANDED** `d7b44f23c` | `@DSeekWork` / `@GrokCapt` | Exact-path **1** file · `+267` · `src/tui/hostLiveIntegration.test.ts`. Real composition + real unix socket + real TUI; kill-Host RED-proof. Evidence: **2/2** focused · **58/58** across 7 TUI files · `typecheck:tui` exit 0. Seat probe: Pi **LISTEN OK**. Cap Cursor **EPERM** disclosed; Pi/Claude suite accepted. |
| **4.6a** Durable connection pin (timing flake) | ✅ **LANDED** `3d3d766cc` | `@DSeekWork` / `@GrokCapt` | Exact-path **1** file · `+62/−13` · `src/tui/hostLiveIntegration.test.ts` only. Three regex layers closed + pinned: (1) case/timing — notice + durable HUD `CONNECTED`; (2) `/CONNECTED/i` ⊇ `DISCONNECTED` → word boundary; (3) product notice `TaskWraith Host is not connected.` → `/(?<!not\s+)\bCONNECTED\b/i` (`host-arc-46a-NOT-CONNECTED-is-reachable-from-product-code`). Negative pin covers all three. Cap: negative pin **1/1**; accept Pi **3/3** · **59/59** · `typecheck:tui` exit 0 (Cursor EPERM disclosed). Test-only — TUI product code untouched. |
| **Step 5a** Desktop providers leaf | ✅ **LANDED** `266f20435` | Cap / `@GrokCapt` | Exact-path **4** files · projection allowlist + `HostStatusRow` honesty pins. **Projection leaf only** — not AppStore cutover; not source population. |
| **Step 5b-port** provider list conduit | ✅ **LANDED** `6c9658d6d` | `@GemProWork` / `@GrokCapt` | Exact-path **3** files · `HostProductionProviderListPort` + fail-closed supplier + bootstrap options. Conduit populated by 5b-wire. |
| **Step 5b-admission** snapshot → Host rows | ✅ **LANDED** `5bce10bac` | `@CursorWork` / `@GrokCapt` | Exact-path **3** files · admission mapper + bootstrap guard pins. Credential strip. `available: true` = admitted (honesty debt). Mapper lives in admission module; root stays wiring-only. |
| **Step 5b-wire** composition-root injection | ✅ **LANDED** `cf3b03eb7` | `@SolWork` / `@GrokCapt` | Exact-path **1** file · `src/main/index.ts` `+15/−1`. Lazy thunk (arrow closure avoids TDZ); **zero** domain logic in root; **zero** lines hoisted. Fail-closed net is double (admission + supplier). Evidence: host suite **950/950**; typecheck **0** Host errors; focused **85/85**. Providers now **5th real family**. Empty wire `providers` on live Electron = **permanently inconclusive** for population (`ready` not a snapshot field); no further probes. |
| **Wave 5d** provider-source readiness honesty | ✅ **LANDED** `215c03849` | `@SolWork` / `@GrokCapt` | Exact-path **9** files · `+357/−12`. Warning code `provider_source_not_ready`; leaf **Unknown** when not ready; genuine zero still **None reported**. Closes fabricated telemetry (`host-arc-64-…`). No protocol version bump. |
| **4.4+** AppStore authority / paired iOS / remaining families | 🔍 **RECON maps exist** · sequencing open | `@SolWork` (AppStore map) · `@GrokWork` (iOS) · Boss sequencing | **AppStore:** `HostSnapshot` is **metadata-only by design** — transcripts excluded. **iOS:** e2ee-v1 client; **zero** Host types in `ios/`; Kit **868/115** green. **Source:** nine families still empty until ports (`host-arc-61-…`). |

### Renderer-restart / per-window store (binding)

`host-arc-renderer-restart-per-window-store-is-CORRECT-not-a-defect` — MistralScout’s “shared singleton” flag was a **goal misreading**. Mission lives in **Host** (main), not the renderer store. Per-window `useState` store is correct: reload must re-fetch from Host, not retain competing authority. Do **not** turn into a work order.

### Markers in fan-out lanes (binding)

`host-arc-markers-not-required-in-fanout-lanes-my-fix-failed` — Boss ruled markers **not required** in fan-out lanes after the write-scope / one-shot retry path failed 0-for-N this round. This docs lane raises **no** marker (`TASKWRAITH_LOCK_OWNER_ID` absent).

### `index.ts` staging RULE (not a window status)

**Do not treat any prior clean/dirty reading as current** (`host-arc-window-is-instantaneous`).

**Operative form after R4'** (`host-arc-r4prime-staging-rule-restated`): when staging an `index.ts` hunk, the same-breath `git diff --stat -- src/main/index.ts` must show **ONLY OUR HUNK** — not empty-while-our-hunk-exists. Empty was correct only before the hunk existed. Ordinary exact-path staging when the diff is Host-only. Private-index (`GIT_INDEX_FILE`) is last resort and **must** be followed by shared-index resync. `git add -p` remains invalid.

**This paperwork pass:** do **not** cite this file for `index.ts` cleanliness. Re-measure with `git diff --stat -- src/main/index.ts` in the same breath as any stage. Host wiring lives in **HEAD** (`b45d4297f` + later Cap lands). That is a measurement discipline, not a durable window claim.

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
30. **Identity file ≠ Host listening.** `resolveHostInstallId` is evaluated **inside** the R4' argument object (`index.ts`) **before** `createHostProductionBootstrap` is entered. `host-runtime/host-install-identity.json` proves the wiring line was **reached**. It proves **nothing** about `start()`, listen, or discovery publish (`host-arc-52-HOST-CONSTRUCTS-BUT-NEVER-PUBLISHES-under-electron`).
31. **Construction throws are outside `.start().catch()`.** R4'-patch `7abaf33be` wraps construction so construct failures log `[host] production Host failed to construct`. Registry **returns**, never throws. Named Electron throw was `requires an injected chatList` — `AppStore` is a class; object-literal tests never exercised production (`host-arc-56-…`).
32. **Guard the METHOD, not the container.** Pre-fix `typeof !== 'object'` rejected production’s class and accepted `{}`. Step 3 `9ef9e0361` checks `typeof getChatList === 'function'` (`host-arc-57-…`). Same blind-spot class as Wave 4.4’s fake-composition tests covering a shape production never used.
33. **Rebuild before hostobs — prove by symbol flip.** Chunk hashes are content-addressed and rotate. `@GrokWork` flipped old→new guard counts in the bundle before launch; hoping is not evidence.
34. **Discovery poll ≥120s; timeout is inconclusive.** `@GrokWork`’s 60s brief would have false-negatived — absent at 40s, present by 70s (`host-arc-58-…`). Never treat poll timeout as “Host failed”.
35. **Host publishes under Electron** — discovery 0600 + token 0600 + real socket + accept + clean teardown (`host-arc-58-…`). Process half closed; client projection half remains. **4.3b** `d2c79bd57` is capability, not AppStore cutover.
36. **DONE-only docs** — never write IN-FLIGHT Cap/adopt status into this file; a doc that asserts an already-landed wave is unlanded (or invents a land) is worse than lag (`host-arc-docs-must-record-DONE-never-IN-FLIGHT`).
37. **Nine of fourteen families are still empty at the source** — health/workspaces/threads/usage/**providers** real after `cf3b03eb7`; the other nine hardcoded `[]` until ports (`host-arc-61-…` updated post-wire). Projection leaf ≠ population of the remainder.
38. **Admission `available: true` ≠ runtime health** — configured/admitted only; do not invent liveness in a wiring hunk.
39. **4.5 harness timeout is inconclusive, not Host-failed** — `EXIT_INCONCLUSIVE=22`, default **120s** (`3f521753e`). Script still has **zero** repo tests.
40. **5b composition-root inject is a lazy thunk, not a hoist** — Boss ruled against moving ~22 lines in `index.ts`; a late-bound `() => getConfiguredProviderSnapshot()` avoids TDZ without domain logic in the root (`host-arc-62-…`).
41. **Fail-closed net is double, not single** — admission module try/catch (Layer 1) fires before supplier try/catch (Layer 2). Both are load-bearing; "tidying" either as "redundant" silently removes a safety layer. All tests pass with either removed — only byte-level review catches it (`host-arc-63-…`).
42. **Empty live `providers` is permanently inconclusive from outside for population** — `ready` is not a snapshot field. Early and late probes both returned `[]`; waiting longer cannot help. Welcome modal ≠ Host `confirmedConfigured` (Cursor not in the six-probe list). “Pristine profile” ≠ “unconfigured app”. **No further launches/probes** for population.
43. **“Without an injected admission port” prose is FALSE after `cf3b03eb7`** — the port **is** injected.
44. **Unavailable telemetry is not zero** — pre-5d, `ready:false` → `providers:[]` → Desktop **None reported** fabricated a measured empty. Wave **5d** `215c03849` carries readiness as warning code `provider_source_not_ready`; leaf paints **Unknown**. Genuine measured zero after ready still **None reported** (`host-arc-64-…`).
---

## Wave 4.8 — Electron observation: Host constructs but never publishes (HISTORICAL)

Measured by `@GrokWork` (authorized cheaper-path launch) and re-measured by `@SolBoss` / `@GrokCapt` **before** Step 3. Residue and findings below are the **pre-fix** baseline. **SUPERSEDED for current state by `host-arc-58-…`** after Step 3 `9ef9e0361` + rebuild + relaunch. Kept as DONE history so the named throw / failure-window narrowing remain auditable.

### What was observed

An isolated dev instance (`TASKWRAITH_INSTANCE_ID=hostobs` → `TaskWraith Dev hostobs`) was launched against the rebuilt `out/` and torn down. Production pid **4902** untouched (same start time). First Electron observation of Host wiring in this arc.

### What worked

`host-runtime/host-install-identity.json` written — **107** bytes, mode **0600**, verbatim:

```json
{"schemaVersion":1,"hostId":"71e44cbd-0c4e-44d4-8688-a448f14be290","createdAt":"2026-08-06T16:40:54.383Z"}
```

That is Wave **3.6e** `resolveHostInstallId` executing under real Electron for the first time. It validates the `host-arc-hostid-ruling` design (UUID, persisted in the Host runtime data dir).

### What did not

- No `taskwraith-host-v2.json` under the isolated profile (or machine-wide under Application Support).
- No new `twh2-*` socket directory (newest on machine was ~47 minutes **before** the launch).
- No `[host] production Host failed to start` line — so `start()` did **not** reject into the R4' `.catch()`.

### Failure window (narrowed)

`HostLocalServer.start()` creates the socket directory at **L225**, twenty-four lines **before** `server.listen()` at **L249**. No new `twh2-*` directory exists from this launch. Therefore `HostLocalServer.start()` was **never reached**, and the hang is **not** in the server — it is earlier, inside `supervisor.start()` before the server is invoked (`host-arc-53-FAILURE-WINDOW-NARROWED-not-listen-earlier`).

### Open confound (unresolved)

`taskwraith-control-v1.json` is also **absent** from that profile. Control-v1 waits for `browser-window-created`; Host v2 does not. The shared absence may be coincidence or a shared startup condition. **Unresolved** — do not assume either way.

### AC1–6 after this measurement (Wave 4.8 — historical)

Remained **PARTIAL**. At that time process half was “Host constructs but never publishes under Electron”. **Later superseded** by `host-arc-58-…` after Step 3. Client projections still incomplete for PASS. **Never PASS** on publish alone.

### Follow-on (DONE observation after R4'-patch `7abaf33be`)

Relaunch with the wrap in the rebuilt bundle named the throw: `requires an injected chatList`. Failure window was **construction validation**. **Closed by Step 3** `9ef9e0361` + Electron publish `host-arc-58-…`.

---

## Chronology (Host Arc commits, newest first)

Top-of-tree churns every pass with foreign concurrent-session commits. This table lists **arc-owned commits only** — run `git log --oneline -1` for current HEAD.

```text
215c03849  fix(host): stop fabricating provider telemetry when source is not ready (Wave 5d) (@SolWork authored; @GrokCapt adopted; WARNING CODE — HONEST UNKNOWN)
95bd8587a  docs(host): record Step 5b-wire under DONE-only Host Arc status                  (@SparkDocs; @GrokCapt adopted; PRE–5d tip)
cf3b03eb7  feat(host): wire provider admission into Electron Host bootstrap (Step 5b-wire) (@SolWork authored; @GrokCapt adopted; LAZY THUNK — 5TH REAL FAMILY)
5bce10bac  feat(host): map configured providers into Host admission rows (Step 5b-admission) (@CursorWork authored; @GrokCapt adopted; MAPPER NOT WIRE)
6c9658d6d  feat(host): inject provider list port into production suppliers (Step 5b-port) (@GemProWork authored; @GrokCapt adopted; CONDUIT — STILL [] UNTIL INJECTED)
3f521753e  fix(host): treat Electron Host smoke discovery timeout as inconclusive          (@GrokWork authored; @GrokCapt adopted; EXIT_INCONCLUSIVE=22 / 120s)
266f20435  feat(host): project Host providers into Desktop status row (Step 5a)           (@GrokCapt adopted; PROJECTION LEAF — NOT CUTOVER)
7096defbe  docs(host): record Step 3, Electron publish, and Wave 4.3b under DONE-only     (@SparkDocs; @GrokCapt adopted; PRE–5a/5b tip)
d2c79bd57  feat(host): add Desktop Host command/receipt IPC path (Wave 4.3b)            (@CursorWork authored; @GrokCapt adopted; CAPABILITY NOT CUTOVER)
62d048b4c  docs(host): record R4'-patch, named throw, and Boss Step 3 (a') ruling         (@SparkDocs; @GrokCapt adopted; PRE–Step 3 / 4.3b — now superseded by this refresh)
9ef9e0361  fix(host): validate chatList method not container typeof (Wave Step 3)         (@GemProWork authored; @GrokCapt adopted; (a') METHOD GUARD)
7abaf33be  fix(host): catch R4' Host construction throws before start attaches          (@SolWork authored; @GrokCapt adopted; R4'-PATCH)
998dde2cd  docs(host): record Wave 4.8 Electron observation under DONE-only Host Arc status (@SparkDocs; @GrokCapt adopted; LESSON 30)
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
- ✅ **Wave 4.8 docs** @ `998dde2cd` — Electron observation recorded (constructs ≠ publishes; lesson 30) — **historical**; superseded by `host-arc-58-…`
- ✅ **R4'-patch** @ `7abaf33be` — construction `try/catch`; construct failures log distinctly from start failures
- ✅ **Step 3 (a')** @ `9ef9e0361` — chatList guard checks the **method**, not the container
- ✅ **Host publish under Electron** — `host-arc-58-…` (discovery + token + socket + accept + clean teardown)
- ✅ **Wave 4.3b** @ `d2c79bd57` — Desktop command/receipt **capability** (not AppStore cutover)
- ✅ **Step 5a** @ `266f20435` — Desktop `providers` projection leaf (not cutover; not source population)
- ✅ **4.5 harness timeout** @ `3f521753e` — `EXIT_INCONCLUSIVE=22` · default **120s** · zero repo tests
- ✅ **Step 5b-port** @ `6c9658d6d` — `HostProductionProviderListPort` conduit (still `[]` until injected)
- ✅ **Step 5b-admission** @ `5bce10bac` — configured snapshot → Host rows (mapper exists; not composition-root wire)
- ✅ **Step 5b-wire** @ `cf3b03eb7` — composition-root lazy thunk; providers = **5th real family**; empty live `providers` permanently inconclusive from outside for population
- ✅ **Docs catch-up (5b-wire tip)** @ `95bd8587a` — DONE-only; retired false “no injected port” prose
- ✅ **Wave 5d** @ `215c03849` — stop fabricating provider telemetry when source not ready; warning code; **Unknown** vs genuine **None reported**

### What remains (post–Electron publish)
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
| **Wave 4.5 — Electron Host boot smoke harness** | `@GrokWork` / `@GrokCapt` | ✅ **LANDED** `f1f950207` + timeout `3f521753e` — script only; **zero** repo tests; landing ≠ observation. |
| **Wave 4.3e — Host out of iOS-flag chrome** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `f370800da` — Cap exact-path 2 files; ungated Approvals surface. |
| **Wave 4.6a — durable connection pin** | `@DSeekWork` / `@GrokCapt` | ✅ **LANDED** `3d3d766cc` — Cap exact-path 1 file; three regex layers pinned. |
| **Wave 4.8 — Electron observation (historical)** | `@GrokWork` / `@SolBoss` / docs `@SparkDocs` | ✅ **RECORDED** `998dde2cd` — constructs but never publishes **before** Step 3. **Superseded** by `host-arc-58-…`. |
| **R4'-patch — construction catch** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `7abaf33be` — Cap exact-path `index.ts` only. |
| **Step 3 (a') — chatList method guard** | `@GemProWork` / `@GrokCapt` | ✅ **LANDED** `9ef9e0361` — method not container; RED pins; zero forbidden roots. |
| **Host publish under Electron** | `@GrokWork` observation | ✅ **PROVEN** `host-arc-58-…` — discovery 0600 + token 0600 + real socket + accept + clean teardown. |
| **Wave 4.3b — Desktop commands** | `@CursorWork` / `@GrokCapt` | ✅ **LANDED** `d2c79bd57` — **capability**, not AppStore cutover; no App.tsx consumer. |
| **Step 5a — Desktop providers leaf** | Cap / `@GrokCapt` | ✅ **LANDED** `266f20435` — projection + honesty; not cutover. |
| **Step 5b-port — provider list conduit** | `@GemProWork` / `@GrokCapt` | ✅ **LANDED** `6c9658d6d` — still `[]` until injected. |
| **Step 5b-admission — snapshot mapper** | `@CursorWork` / `@GrokCapt` | ✅ **LANDED** `5bce10bac` — mapper exists; does not by itself inject into Electron bootstrap. |
| **Step 5b-wire — composition-root injection** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `cf3b03eb7` — lazy thunk; providers = **5th real family**; empty live reads permanently inconclusive for population. |
| **Wave 5d — provider-source readiness honesty** | `@SolWork` / `@GrokCapt` | ✅ **LANDED** `215c03849` — warning code `provider_source_not_ready`; closes fabricated telemetry (`host-arc-64-…`). |
| **Bridge twin (9-method port)** | `@SolBoss` sequencing | Standing residual — not a Step 3 defect; do not mechanical-copy chatList guard. |
| **Source population — nine other empty families** | `@SolBoss` sequencing | Open — after providers, nine of fourteen families remain hardcoded empty (`host-arc-61-…`). |
| **Admission availability honesty** | `@SolBoss` sequencing | Named debt — `available: true` means admitted, not runtime-healthy. |
| **Absent-port readiness follow-up** | `@SolBoss` sequencing | Named 5d residual — no-port case still `warnings: []` (preserves `@GemProWork` pin). |
| **AppStore → Host metadata cutover** | `@SolBoss` sequencing | Open — HostSnapshot metadata-only; transcripts excluded by design (`host-arc-appstore-cutover-gap-map-measured`). |
| **iOS paired projection** | Downstream of Mac/Desktop cutover | 🔍 Recon done — e2ee-v1 client; zero Host types in `ios/`; Kit **868/115** green. |
| **Wave 5 — `.twmission` / AC9** | `@SolBoss` | **NOT STARTED** |
| **Wave 6 — adversarial + closeout** | `@SolBoss` | Socket **unit** gap **CLOSED**. Process publish proven; client cutover + adversarial gates remain. |

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
| `.WORK-IN-PROGRESS-host-arc-r4prime-patch.md` | **Absent** | n/a (R4'-patch Cap-landed `7abaf33be`) |
| `.WORK-IN-PROGRESS-sparkdocs-r4patch-done.md` | **Absent** | n/a (prior docs refresh Cap-landed `62d048b4c`) |

Foreign markers present (not Host Arc): `.WORK-IN-PROGRESS-observatory-gpu-calm.md`, `.WORK-IN-PROGRESS-seat-strip-desktop.md`, `.WORK-IN-PROGRESS-tool-event-dual-lane-dedupe.md`.

`@SparkDocs` note: this Cursor seat has **`TASKWRAITH_LOCK_OWNER_ID` absent**; docs lease uses open coordination (claiming marker is expires-only). Cap lands **`215c03849` / `cf3b03eb7` / `5bce10bac` / `6c9658d6d` / `3f521753e` / `266f20435`** + docs tip **`95bd8587a`** + Electron publish **`host-arc-58-…`** are **DONE**. This refresh records Wave **5d** only (DONE-never-IN-FLIGHT): tip SHA `215c03849`, retires false “None reported = not-ready source” conflation, adds lesson 44. Does **not** invent 5c / empty-family lands. This file records **DONE** waves only; a document that contradicts HEAD is worse than one that lags. Commit status is `git log`, not this file.

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
| AC1–AC6 | ⚠️ **PARTIAL** | Host **wiring** ON (`b45d4297f` + `7abaf33be` + Step 3 `9ef9e0361`). Wave **4.4** Node boot (`402f34e0e`). Wave **4.6/4.6a** real TUI round trip. Wave **4.3d/4.3e** Desktop consumes Host ungated. Wave **4.3b** `d2c79bd57` Desktop command **capability**. Step **5a** `266f20435` providers leaf. **5b-port/admission/wire** `6c9658d6d` / `5bce10bac` / `cf3b03eb7` — providers = **5th real family**. **Host publishes under Electron** (`host-arc-58-…`, three profiles). Process half **closed**; **two remainders** — client projection (AppStore cutover / iOS Host-shaped) **and** source population (**5 real / 9 empty** families). Empty live `providers` permanently inconclusive. **Never PASS.** |
| AC7–AC8 | ⚠️ PARTIAL | Host core authoritative; TUI is first full (read+command+live) projection client; Desktop mounts **and** consumes Host projection ungated **and** has command plumbing + providers leaf (AppStore still authority for most views); iOS already e2ee-v1 projection client (not Host v2) |
| AC9 | ❌ **NOT STARTED** | `.twmission` / mission evidence not started (Wave 5) |
| AC10–AC11 | ⚠️ PARTIAL | TUI read+command+live paths live in HEAD; Desktop pure + wire + adapter + mount + leaf + ungated + **4.3b command capability** + **5a providers leaf** + **5b-wire** providers family live in HEAD; **no** AppStore authority cutover; iOS Host-shaped work is Mac-side |
| AC12–AC13 | ✅ PASS | Provider/security boundaries untouched by Arc commits |
| AC14 | ⚠️ PARTIAL | Path-scoped evidence only; Wave 4 TUI uses `typecheck:tui`; Desktop pure/adapter/consumer/commands use `typecheck:web` (+ node for main/preload); wire/preload needs **node+web**; protocol slice needs **node+tui**; 4.4 / 5b host uses `typecheck:node` |
| AC15 | ✅ PASS | No forbidden path drift in scoped arc Cap lands (5b exact-path module lands; 4.3b exact-path plumbing; Step 3 exact-path 2; 4.6a exact-path 1; prior exact-path lands stand) |

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
- Composition roots (`index.ts`, `App.tsx`, `EnsembleOrchestrator.ts`) — tiny wiring hunks only, with Boss/Cap clearance (R4' + R4'-patch landed under that rule)

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
- Blackboard: `host-arc-wave3-closed-four-shas`, `host-arc-wave4-sequencing-ruling`, `host-arc-r4prime-adopt-authorized`, `host-arc-r4prime-does-NOT-pass-ac1-6`, `host-arc-production-host-has-never-actually-run`, `host-arc-socket-gap-CLOSED-seat-specific-not-environmental`, `host-arc-socket-epern-validation-gap` (superseded), `host-arc-43a-wire-and-adapter-verified-by-boss`, `host-arc-43a-adapter-chain-complete-appts-next`, `host-arc-43c-maints-wrap-corrects-my-own-ruling`, `host-arc-43c-already-ruled-stop-asking`, `host-arc-44-production-boot-proof-is-now-possible`, `host-arc-44-fake-composition-claim-is-FALSE-adjudicated`, `host-arc-44-boot-proof-REAL-COMPOSITION-BOOTS`, `host-arc-electron-observation-is-NOT-ops-a-harness-exists`, `host-arc-45-my-red-preauthorisation-was-a-trap-grokwork-caught-it`, `host-arc-45-harness-authored-plus-pgrep-guard-defect`, `host-arc-45-SUPERSEDED-app-fails-closed-not-open`, `host-arc-45-path-fixed-and-the-app-FAILS-CLOSED-not-open`, `host-arc-46-first-real-client-round-trip-and-two-overclaims-corrected`, `host-arc-46a-connection-pin-is-timing-dependent-and-worse-than-flagged`, `host-arc-46a-BLOCKED-regex-matches-DISCONNECTED`, `host-arc-46a-NOT-CONNECTED-is-reachable-from-product-code`, `host-arc-appstore-cutover-gap-map-measured`, `host-arc-ios-recon-already-a-projection-client-downstream-of-lane-A`, `host-arc-ios-toolchain-PRESENT-and-docs-header-lies-about-itself`, `host-arc-ios-kit-baseline-868-green-and-my-mirror-claim-was-too-broad`, `host-arc-docs-must-record-DONE-never-IN-FLIGHT`, `host-arc-cutover-and-ios-recon-only-not-implementation`, `host-arc-43e-host-consumer-must-not-live-behind-the-ios-flag`, `host-arc-43e-placement-pin-is-two-sided-and-red-proved`, `host-arc-43d-sidebar-is-prettier-dirty-do-not-write`, `host-arc-renderer-restart-per-window-store-is-CORRECT-not-a-defect`, `host-arc-markers-not-required-in-fanout-lanes-my-fix-failed`, `host-arc-lane-scope-omits-granted-marker-paths`, `host-arc-42c-one-field-grokwork-contest-upheld`, `host-arc-43a-cleared-and-wire-carveout-granted`, `host-arc-do-not-score-a-live-lane`, `host-arc-review-seats-have-no-shell`, `host-arc-55-registry-cannot-throw-suspect-is-ARG-EVALUATION`, `host-arc-56-ROOT-CAUSE-AppStore-is-a-CLASS-guard-demands-object`, `host-arc-57-STEP3-RULED-A-PRIME-check-the-METHOD-not-the-container`, `host-arc-58-HOST-PUBLISHES-UNDER-ELECTRON-start-serve-stop-PROVEN`, `host-arc-61-TEN-FAMILIES-EMPTY-and-step5b-scoped`, `host-arc-62-WIRE-IS-A-THUNK-not-a-hoist-and-the-availability-debt`, `host-arc-63-5b-wire-TDZ-PROVEN-and-a-pristine-profile-CANNOT-prove-the-wire`

**Maintained by:** `@SparkDocs` · Scope-limited to repo paperwork · figures byte-verified against live git + markers at time of writing · records DONE only · commit status is `git log`, not this file.
