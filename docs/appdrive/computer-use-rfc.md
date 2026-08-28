# RFC: App Drive Computer Use modes and safe vertical slice

**Status:** Accepted synthesis decision for this mission.
**Contract id:** `appdrive-computer-use-v1` (`src/shared/appDriveComputerUseContract.ts`)
**Authority:** Ensemble blackboard `appdrive-architecture-decision` (Boss draft + Captain reconciliation).
**Non-goals this run:** CGEvent productization, durable app-keyed trust, VM guest HID, Windows AppDrive, silent mode fallback.

### Ship vs candidate vs prototype (read this first)

| Layer                                                                                             | Status                                          | Meaning                                                                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| §12b Foreground AX authority (exact run/window lease, secret refuse, audit, host-global HID idle) | **Shipped production**                          | Already in main; do not re-derive or weaken                                                      |
| UI/session vertical slice (dock, enforced pause/takeover, display-only cursor, status binding)    | **Merged to `master`**                          | Main-owned admission gate, lifecycle IPC, persistent Drive tab, and normalized cursor projection |
| Background Drive / interference harness                                                           | **Prototype only** (`prototypes/` + `scripts/`) | Never productize until per-app harness proves non-interference                                   |
| Isolated Drive (VM guest HID)                                                                     | **RFC only**                                    | Not profile `--taskwraith-isolated-instance`                                                     |
| This RFC + shared contract + `AppDriveSliceAcceptance.test.ts`                                    | **Decision lock / acceptance evidence**         | Documentary + invariant tests; no actuation authority                                            |

Related: [`docs/appdrive/design.md`](./design.md) §12b (exact Tier 4 contract), §12c (mode taxonomy pointer).

---

## 1. Architecture decision (crisp)

Productize **Foreground Drive** chrome on the existing exact-run/window AX lease. Keep **Background Drive** prototype-only until a per-app interference harness proves zero host theft. Keep **Isolated Drive** RFC-only as real VM guest HID — never rename `--taskwraith-isolated-instance` profile isolation into that claim.

| Mode                 | Meaning                                                                                                          | This run                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Foreground Drive** | AX `observe/inspect/click/fill`; target app frontmost + exact window focused/visible; disruptive by construction | **Shipped** on `master`: §12b authority + UI/session slice   |
| **Background Drive** | Non-disruptive control: no host cursor, focus, keyboard, clipboard, or activation theft                          | **Prototype only** until interference harness passes per app |
| **Isolated Drive**   | Independent guest mouse/keyboard inside a VM                                                                     | **RFC only**; Windows AppDrive remains off in v1             |

Canonical session lifecycle literals (shared contract): `idle | active | paused | takeover | stopped`.
**Viewing** / **Driving** are display labels derived from observation vs control presence — not extra FSM states.

Hard rules:

1. No silent Background→Foreground (or any mode) fallback.
2. No global `CGEventPost`, cursor warp, clipboard typing, or agent-triggered OS permission prompts.
3. Native automatic “human pause” remains **host-global HID** today — UI may expose explicit Pause/Takeover/Stop, but must **not** claim target-scoped arbitration.
4. Preserve exact run/window leases, secret-field refusal, stale-target/input checks, per-click audit, and user-only consent.

---

## 2. Exact shipped vertical slice (this mission)

Productize existing safe backend projection; do **not** widen desktop authority.

| #   | Deliverable                                                                                    | Owner lane                         | Notes                                                                |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| 1   | Main-owned App Drive session (`paused` / `takeover` / refuse-while-paused)                     | GrokWork1                          | Wrap lease; do not mint/broaden/persist authority                    |
| 2   | Sanitized App Drive status projection (`mode=foreground`, target, verbs, steps/expires, pause) | GrokWork1                          | Consume coordinator status; no IPC wiring in peer prototype files    |
| 3   | Preload/renderer binding of already-safe `status.control`                                      | Boss-owned production wiring later | Renderer currently drops control                                     |
| 4   | Persistent App Drive dock + display-only virtual cursor                                        | CursorWork1                        | Label Foreground Drive; `pointer-events:none`; no OS cursor control  |
| 5   | Disclosure/authority model (exact chat/run/launch/process-birth; no bundle-ID authority)       | CursorWork2                        | Pure model + tests; no lease/ledger edits                            |
| 6   | Background-input prototype + interference harness (candidate-only)                             | GrokWork2                          | Under `prototypes/` + `scripts/`; no production imports              |
| 7   | This RFC, acceptance matrix, mode-contract + slice acceptance tests                            | CursorWork3                        | Docs + pure shared contract + `AppDriveSliceAcceptance.test.ts` only |

Out of slice (remain RFC/prototype):

- `CGEventPostToPid` as product Background Drive
- Persistent “remember this app” approvals
- Target-scoped native HID / event-tap arbitration
- VM guest desktop / Hyper-V / UTM stacks
- New MCP verbs (`key`/`type`/`scroll`/`hover`/`select`/`wait_for`)

---

## 3. Compatibility / risk matrix

| Surface                                  | Foreground (ship UI)                                | Background (prototype)              | Isolated (RFC)         |
| ---------------------------------------- | --------------------------------------------------- | ----------------------------------- | ---------------------- |
| Host cursor warp                         | Forbidden; overlay is display-only                  | Must prove none                     | Guest-only pointer     |
| Focus / activation theft                 | Required (frontmost+focused) — label honestly       | Must prove none                     | Host chrome stays free |
| Keyboard / pointer injection             | AX only; no CGEvent                                 | Research PostToPid only in harness  | Guest HID              |
| Secret fields                            | Refuse capture/fill (shipped)                       | Must not bypass via coords          | Guest policy TBD       |
| Human arbitration                        | Global HID soft-refuse + explicit Pause/Takeover UI | Target-scoped required before claim | Guest-local            |
| Windows                                  | Unavailable (`NativeCapabilities`)                  | N/A                                 | Greenfield guest stack |
| Profile `--taskwraith-isolated-instance` | State isolation only — **not** Isolated Drive       | Must not be relabeled               | Distinct               |

### Packaging / performance acceptance checks

| Check                     | Gate                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| macOS AppDrive capability | darwin + ≥15.2 + bridge (`appDriveFeatureForHost`)                              |
| Swift bridge              | `npm run test:swift:bridge` on mac builds; smoke bridge daemon                  |
| Control lease budgets     | Default 15 min / 20 click/fill attempts (obs/inspect free)                      |
| Appwatch ring             | Existing fps/duration/byte caps unchanged by this slice                         |
| Entitlements              | Do not silently strip `DYLD` / widen TCC; TW-SEC-2026-022 remains user decision |
| Windows packaging         | Keep `appDrive` / `appwatch` hard-off in v1                                     |

### Automated interference acceptance (Background Drive gate)

A Background Drive claim is **invalid** unless a machine-readable per-app harness records all of:

`focus`, `frontmost_app`, `host_cursor`, `keyboard_target`, `clipboard_hash`, `activation`, `target_success`, `target_scoped_human_arbitration`

Default harness posture: dry-run / observe-only; any PostToPid prototype is fixture-PID + explicit user invocation only. Fail any run that uses global post, warp, clipboard type, activate/raise, or agent permission prompts.

---

## 4. Acceptance matrix (vertical slice)

| ID  | Criterion                                                                                         | Evidence                                                               |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A1  | Mode chip / docs say **Foreground Drive** for native AX control                                   | Dock UI + this RFC + contract test                                     |
| A2  | Pause refuses new acts without revoking/minting lease authority incorrectly                       | Coordinator + CanvasWindowDriver integration tests                     |
| A3  | Takeover/Stop are explicit UI; no “target-scoped auto-pause” copy for native HID                  | Dock copy + contract `describeNativeHumanArbitrationHonesty`           |
| A4  | Virtual cursor is display-only (`pointer-events:none`); never warps OS cursor                     | CursorWork1 tests/CSS                                                  |
| A5  | Authority disclosure never treats bundle ID / app name as authorization                           | Existing exact-run ownership gates + dock disclosure tests             |
| A6  | No production CGEvent / silent fallback / persistent app trust in this slice                      | Grep + forbidden-list contract test                                    |
| A7  | Background/Isolated remain unshipped in UI mode enum                                              | `APP_DRIVE_SHIPPED_UI_MODES === ['foreground']`                        |
| A8  | Interference harness exists only under prototype/scripts paths                                    | Isolated GrokWork2 candidate; intentionally not imported by production |
| A9  | Focused invariant tests green                                                                     | 12 AppDrive/native/dock suites; 289 tests                              |
| A10 | Canonical lifecycle is `idle\|active\|paused\|takeover\|stopped`; Viewing/Driving are labels only | Shared contract helpers + peer dock/session alignment                  |

---

## 5. Ordered follow-up slices (file ownership)

1. ~~**Merge clearance (Boss)**~~ — **DONE.** The slice is on `master`.
2. ~~**Live dock preview (Renderer/AppWatch owner)**~~ — **DONE 2026-08-16** (`AppDrivePreviewFrame` + `attach-window:preview-frame`). Main validates `appwatch.latestFrame` into a bounded, generation-stamped `data:image/png` URL and the renderer drops any frame whose generation no longer matches the live attachment. Privileged geometry stayed main-owned. NOT secret-redacted — see the module header before putting any redaction claim on that surface.
3. **Renderer binder extraction (Renderer architecture owner)** — move AppDrive reconciliation out of `App.tsx` and import the shared lifecycle/mode contract. **Still open**; the preview poll added to `App.tsx` moves with it when it goes.
4. **Permission surface (Authority + UX owners)** — show the current-launch lease and revoke path; durable app-keyed approvals remain a separately consented RFC.
5. **Harness iteration (GrokWork2 → security review)** — fixture apps; publish per-app results; still no product claim.
6. **Target-scoped native arbitration RFC (Native/security owners)** — explicit consent required because event taps / Input Monitoring widen desktop authority.
7. **Background Drive productization (Native + compatibility owners)** — only after A8 metrics pass per app; never silently fall back.
8. **Isolated Drive implementation (VM/Windows owners)** — VM lifecycle, guest agent, host control-plane consent; Windows remains separate.
9. **Verb expansion (Tooling owner)** — new `canvas_*` verbs only with gateway generation, Tools.md regeneration, and observe→act→verify honesty.

---

## 6. Windows / VM implications

- **Windows AppDrive:** hard-off today; Isolated Drive on Windows implies Hyper-V/WSL2/other guest + UI Automation/RDP-class input — not an AX port.
- **Isolated Drive:** guest HID must never bridge to host input; consent UI stays on the **host** control plane (Tier 5 chrome-reach warning in design §6a / Tier 5 notes).
- **Naming:** never market profile isolation as Computer-Use isolation.

---

## 7. Unresolved decisions requiring the user

1. Whether to widen desktop authority for target-scoped native input sensing (event tap / Input Monitoring).
2. Whether durable app-keyed App Drive approvals should ever exist (capability governance: explicit consent).
3. TW-SEC-2026-022 packaged `DYLD` entitlement disposition.
4. Whether Foreground Drive QA of arbitrary (non-managed-launch) apps is ever in scope — today authority is exact managed launch only.
5. Isolated Drive vendor/stack choice (UTM/QEMU vs Hyper-V) and whether Windows parity is a release goal.

---

## 8. Verification commands

```bash
./node_modules/.bin/vitest run \
  src/main/appDrive/AppDriveSession.test.ts \
  src/main/nativeWindow/NativeWindowCoordinator.test.ts \
  src/main/canvas/CanvasWindowDriver.test.ts \
  src/main/canvas/CanvasWindowDriverFactory.test.ts \
  src/main/canvas/NativeWindowCanvasOpenResolver.test.ts \
  src/main/IpcValidation.test.ts \
  src/main/RendererIpcPolicy.test.ts \
  src/shared/appDriveComputerUseContract.test.ts \
  src/renderer/src/lib/appDriveDockState.test.ts \
  src/renderer/src/components/AppDriveDockPanel.test.tsx \
  src/renderer/src/components/AppDriveVirtualCursor.test.tsx \
  src/renderer/src/lib/rightDockState.test.ts
npm run typecheck
npm run build
npm run format:ratchet
npm run guard:doctrine-integrity
```

Expected: 12 focused suites / 289 tests plus typecheck, build, formatting ratchet, and doctrine integrity all pass after rebase.
