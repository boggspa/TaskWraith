# AppDrive — agent actuation over TaskWraith-owned surfaces

**Status:** design, not started. Written 2026-07-26.
**Scope of this document:** Tier 0–2 (harden what ships → lease-bound web actuation). Tiers 3–5 sketched only.

---

## 0. Naming

**AppDrive.** Permission class `appDrive`. Tools stay in the `canvas_*` family.

- "Computer use" is the industry term for the general-desktop capability we are explicitly *not* building in v1. Using it invites the comparison we lose and sets the wrong user expectation about blast radius.
- "AppDrive" names the actual scope: driving an application on a surface TaskWraith owns.
- It composes with the existing vocabulary, which already has clean seams: **Run** owns the process lifecycle, **Canvas** owns the visible surface, **Appwatch/Screen Watch** observes an external window, **AppDrive** authorises and transacts input against one exact surface.
- Tools stay `canvas_*` because they act on canvases. A new `appdrive_*` prefix would fragment `ToolFamilyIcon`, `MCP_TOOL_GROUPED_NAMES` and the settings grouping for no gain, and Tier 4's non-web surfaces already model as the `window` driver kind under the same `CanvasDriver` contract.

The *product* built on AppDrive is **QA lanes** — agents driving your own builds under test. That framing is load-bearing; see §9.

---

## 1. The premise, and the one place it currently fails

The v1 instinct is right: restrict actuation to surfaces TaskWraith owns, and the catastrophic wrong-window / wrong-tab failure class disappears. Agent-opened canvases are additionally near-harmless because partitions are per-session ephemeral (`canvas-${sessionId}`, no `persist:` prefix, [CanvasWebDriver.ts:328](../src/main/canvas/CanvasWebDriver.ts:328)) — a freshly agent-opened canvas has no cookies and cannot act as the user anywhere.

**But the containment is not enforced today, because `canvasInteraction` grants are per-service, never per-surface.** The session-grant key is `provider:service:workspacePath` ([PermissionService.ts:263](../src/main/PermissionService.ts:263)) — no `canvasId`, no `chatId`. So:

- one "allow for session" covers every canvas in that run **and every canvas opened afterwards**;
- one "allow for workspace" covers every canvas in every chat for that provider;
- `canvas_list` is chat-scoped and returns the chat's canvases *including* the renderer-created embedded one the user logged into ([CanvasService.ts:646](../src/main/canvas/CanvasService.ts:646));
- therefore an agent can enumerate and actuate a surface the user never pointed it at.

The single exception is the `plan` preset, where `canvasInteraction` is grant-immune and re-prompts per call (`PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES`, [EffectiveRunPermissions.ts:246](../src/main/EffectiveRunPermissions.ts:246)). That is the mechanism we need, just not the default.

**Fixing the grant key is the gating item for this whole feature.** Until a grant names a surface, "the user chose this window" is a UX story, not an invariant.

### What the sandbox does and does not buy

The sandbox prevents **errors of aim**. It does nothing about **errors of judgment** — misread state, right accessible-name on the wrong element, "Confirm" on the wrong dialog. LLM actuation failures are overwhelmingly the second kind. So v1 eliminates the vivid risk and leaves the likely one; §7 (consequential-action confirmation) is the answer to the second, and it is not optional.

Second premise to retire: **login-in-canvas is a privilege grant with good UX, not containment.** Ephemeral partitions mean the user authenticates *inside the agent-drivable surface*, every time, and those frames are screenshotted and — on a hosted provider — egressed. Consent copy must say "act as you in this account", not "drive this window". §6 covers the credential mechanics.

---

## 2. Tier 0 — five defects in shipped code

These are bugs in `canvas_click` / `canvas_fill` / `canvas_sketch_update` **today**, independent of whether AppDrive is ever built. Every one is in the exact class AppDrive would amplify, and fixing them builds most of the AppDrive transaction layer as a side effect.

### D1 — Actuation returns success without a verified postcondition

`act()` resolves the ref out of the frozen snapshot map and fires immediately ([CanvasWebDriver.ts:206](../src/main/canvas/CanvasWebDriver.ts:206)). There is **no** `isConnected` check, no bbox revalidation, no snapshot epoch. `CanvasActionInput` ([canvasTypes.ts:129](../src/main/canvas/canvasTypes.ts:129)) has no precondition field, and `CanvasElementTree` exposes only `capturedAt` — nothing the caller could echo back.

Failure path: a React re-render between `canvas_snapshot` and `canvas_click` leaves the frozen ref pointing at a detached node. `scrollIntoView` no-ops, `el.click()` on a detached node does not throw, so the driver returns `{ok: true, found: true, action: 'click'}` ([CanvasWebDriver.ts:242](../src/main/canvas/CanvasWebDriver.ts:242)) and `CanvasService` audits `found: true` while nothing happened on screen.

This is the worst possible bug in an actuation layer: the model then re-observes, sees no change, and **tries harder**. It is also the same shape as the known missing-terminal-else class — silent empty success.

### D2 — Audit ordering is inverted (defence-in-depth, NOT a reachable bug)

**Corrected 2026-07-26 after attempting to reproduce it.** `assertLiveAfterAwait` runs **after** the driver call ([CanvasService.ts:773](../src/main/canvas/CanvasService.ts:773) click, `:790` fill, `:843` sketch), so on a liveness race it throws and skips the audit `emit` for an action that already executed. The ordering is genuinely backwards.

But it is **not reachable**. `emit` independently refuses to write once the history generation has moved ([CanvasService.ts:310](../src/main/canvas/CanvasService.ts:310)), and every path that makes `assertLiveAfterAwait` throw also either bumps the generation synchronously (`beginHistoryClear` does it before its first await, [CanvasService.ts:1254](../src/main/canvas/CanvasService.ts:1254)) or tears the canvas down and deletes its generation entry. Three vectors were tried — global clear, scoped authority clear, canvas close during await — and in all three the event would have been purged anyway. The only theoretical gap is a session *replaced* under the same `canvasId`, which cannot happen because ids are per-open UUIDs.

So: reorder it, because relying on a subtle invariant in a *different* function for a correctness property is fragile and the reorder is free — but do not bill it as a bug fix. The reachable wins in this area are the **pre-flight** assert (never touch a canvas whose clear is in flight) and **serialization** (below).

Contrast `evaluate` ([CanvasService.ts:867](../src/main/canvas/CanvasService.ts:867)), which does it correctly and for a real reason: `emitStrict('eval.started')` **before** execution, fail-closed if it cannot persist.

### D3 — No user-takeover concept exists, and the agent fights the user

No pause, no cancel-on-input, no lock, no "human is driving" flag anywhere. Worse:

- `actScript` calls `scrollIntoView` ([CanvasWebDriver.ts:210](../src/main/canvas/CanvasWebDriver.ts:210)) and `el.focus()` (`:217`, `:235`) on **every** click and fill — a focus steal mid-typing;
- `fill` overwrites through the native value setter with no merge (`:229`);
- `chargeInteraction` is a counter, not a mutex ([CanvasService.ts:749](../src/main/canvas/CanvasService.ts:749)) — concurrent calls interleave freely;
- `overlayGuard`'s `setVisible(false)` incidentally makes the view unclickable, but it fires on DOM occlusion only ([CanvasPane.tsx:131](../src/renderer/src/components/CanvasPane.tsx:131)) and the driver keeps scripting the hidden page.

The only human override is destroy, not pause.

### D4 — The sketch driver silently destroys in-progress user work

Page-side `applyUpdate` sets `doc.elements = next` unconditionally for `mode:'replace'` ([CanvasSketchDriver.ts:365](../src/main/canvas/CanvasSketchDriver.ts:365)). The human's in-progress stroke is pushed into `doc.elements` at pointerdown (`:316`), so an agent `canvas_sketch_update` mid-drag drops the draft from the document; the local `draft` var keeps mutating an orphan, `render()` rebuilds only from `doc.elements`, and `finish()` cannot restore it. `doc.updatedAt` is maintained (`:173`) and never used as a precondition. Last-writer-wins, reproducible, loses user work.

### D5 — Grants are not surface-scoped

§1. Listed here because it belongs in the same remediation series.

### Also worth fixing in the same pass (not defects, but adjacent)

- **`McpToolCatalog.ts:3506` lies to the agent**: it says a launched Run process "runs jailed to the workspace." It is not — spawn options are `cwd/shell/detached/windowsHide/env` with the real `process.env` inherited ([LaunchManager.ts:244](../src/main/launch/LaunchManager.ts:244)), no seatbelt, full user privileges. The only jail is a cwd check. Either sandbox it or fix the string; a false security claim in agent-facing text is worse than no claim.
- **The sketch surface is hardened less than the web one**: [CanvasSketchDriver.ts:635](../src/main/canvas/CanvasSketchDriver.ts:635) sets only window-open deny + `setPermissionRequestHandler(false)` — no `setPermissionCheckHandler`, no `will-download` guard, no WebRTC policy, despite sharing the embed factory with the web driver which has all four ([CanvasWebDriver.ts:450](../src/main/canvas/CanvasWebDriver.ts:450)).
- **The stale `canvasEval` docs** (§11, S0) — already stale in the tree today.

---

## 3. The authority model — two templates, two jobs

The instinct to model AppDrive on `canvasEval` is half right. `canvasEval` prompts on **every** call, which works because eval is rare; AppDrive performs hundreds of actions per session, so a per-call human prompt is unusable. The codebase already contains the right primitive for the other half.

| concern | template | why |
|---|---|---|
| **May this actor touch this surface at all?** | `ConcurrentLaneWriteScope` + `validateLaneWriteScopeForRun` ([EnsembleOrchestrator.ts:9917](../src/main/services/EnsembleOrchestrator.ts:9917)) | Approved **once** by user or Boss, persisted durably on the round state, consulted **per-call** at MCP-tool-execution time, scoped to a resource. Exactly a lease. Already adversarially reviewed for files. |
| **May this *specific* action, which looks destructive, proceed?** | `CanvasEvalApprovalReceipt` + `CanvasStore.appendEventStrict` claim ([CanvasStore.ts:758](../src/main/canvas/CanvasStore.ts:758)) | Content-bound, single-use, claim-before-write, durable across restart, desktop-only review. Exactly a consequential-action confirmation. |

Plus a third layer that needs no human at all:

| **Is the world still what the agent observed?** | new, cheap, per-call | The precondition. Not a permission. §5. |

### 3.1 `AppDriveLease`

```ts
interface AppDriveLease {
  schemaVersion: 1
  leaseId: string
  nonce: string                  // replay fence, claimed in the uses ledger on close
  instanceEpoch: string          // see §3.3 — dead lease after restart / wrong instance

  // Who
  chatId: string
  runId: string                  // REQUIRED — never resolve by chatId alone, see §3.4
  participantId: string          // the operator seat
  provider: ProviderId

  // Granted by whom
  approvedBy: 'user' | 'boss' | 'captain'
  approverParticipantId?: string // absent for 'user'
  approvalId: string             // joins the approval ledger row

  // What surface, exactly
  canvasId: string
  driverKind: CanvasDriverKind
  originScope: string            // exact origin; navigation out of it revokes
  surfaceIdentity: string        // digest of {canvasId, partition, driverKind}

  // What may be done
  verbs: readonly CanvasActVerb[]
  stepBudget: number
  stepsUsed: number
  expiresAt: number
  loopbackOnly: boolean          // true for all of Tier 1
}
```

**Revocation is total and eager.** Any of: canvas close, navigation off `originScope`, run reaching a terminal status, chat change, role change / Boss failover, user takeover timeout exceeded, step budget exhausted, expiry, `instanceEpoch` mismatch, app restart. Revocation is a lease *deletion*, not a flag — a revoked lease is indistinguishable from an absent one, so the failure path is the same code.

**Leases are not agent-requestable in v1.** Like `ConcurrentLaneWriteScope`, they are created by the human (composer / dock panel) or by Boss. There is no `appdrive_lease_request` tool. This removes the entire self-arming attack surface and a large chunk of the work.

**Migration:** when the renderer opens an embedded canvas (`canvas:open-embedded`, [CanvasEmbedIpc.ts:163](../src/main/canvas/CanvasEmbedIpc.ts:163)), auto-mint a lease scoped to that canvas + origin for the chat's own run. Existing human-initiated flows keep working with no new prompt. Agent-opened floating canvases get **no** lease — the agent must be handed one.

### 3.2 Grant surface-binding (D5) — **SHIPPED 2026-07-26** (`bbfa9ec7c`)

**What shipped differs from what this section originally proposed, in one important way: no new `AgenticServiceId` was added.** The design assumed `appDrive` would be a new permission class that happened to be surface-scoped. Implementing it made clear the defect lives in the *existing* capability — `canvasInteraction` is fine, its grant just names no surface — so scoping the existing service closes the hole with none of the ~30-file union sweep, and none of its risk.

Three things had to change together or the fix would have been cosmetic:

1. **The run-attached grant is the path that actually fires.** `PermissionService.addSessionGrant` delegates to `RunManager` and returns whenever a run is live, so scoping only the process-global key would have left the common case wide open. Both key functions are scoped (they are duplicated, not shared — `RunManager.ts:72` and `PermissionService.ts:263`).
2. **The canvasId was lost between request and response.** `PendingGeminiToolApproval` kept provider/service/workspace/runId only, so a grant could only ever be minted unscoped. It now carries `surfaceId`, read out of the preview the human was shown.
3. **Fail closed on omission.** A surface-scoped service with no surface in hand matches nothing, and minting an unscoped grant is *refused* rather than stored — a stored grant that can never match is worse than none, because the UI reports it as given.

Also dropped: no persistence, sanitizer or migration work is needed, because no surface-scoped grant is ever written to settings (see the workspace-tier removal below).

### 3.2.1 The original proposal, for reference

Additive change to the grant record: an optional `surfaceId`. `resolvePermission` only matches a grant whose `surfaceId` equals the request's; services with no surface leave it `undefined` and behave exactly as today.

- session key becomes `provider:service:workspacePath:surfaceId?` ([PermissionService.ts:263](../src/main/PermissionService.ts:263))
- workspace grant match gains the same component ([PermissionService.ts:130](../src/main/PermissionService.ts:130))
- **`canvasInteraction` joins the `workspaceGrantServiceIdsFor` drop list** ([EffectiveRunPermissions.ts:461](../src/main/EffectiveRunPermissions.ts:461)) alongside `canvasEval`/`mediaRecording`. A workspace-wide "click anything in any chat forever" grant is indefensible. **This is a deliberate behaviour change and needs its own commit and its own review.**

Net UX: one prompt still covers a whole drive session — it is just bound to one surface.

**Why not `forcePrompt` instead?** There is a cheaper, already-tested mechanism: `mcpToolAlwaysPrompts` ([McpRouteGuards.ts:36](../src/main/mcp/McpRouteGuards.ts:36)) sets `forcePrompt`, which is checked *ahead of* every auto-approval path — Boss auto-approval returns null on it ([BossmanAutoApproval.ts:78](../src/main/BossmanAutoApproval.ts:78)) and the trusted-session write path defers to it. It is one line, touches no shared type, and is the strongest available statement of "no standing grant, trusted session or session-YOLO may ever silence this". The appearance feature chose exactly this for `theme_tokens_set` over adding a service id.

**It is the wrong tool here, and the reason is the shape of the work.** A drive session performs hundreds of actions; a modal per click is unusable, and an unusable gate is worse than a correctly-scoped one because people route around it. That is the same reasoning that ruled out cloning `canvasEval`'s per-call receipt for actuation (§3). The user *should* be able to say "yes, drive this surface" once — the defect was never that `canvasInteraction` is grantable, it is that the grant names no surface. So scope the grant; don't abolish it.

The two mechanisms are not exclusive, and `canvas_eval` uses both: always-prompts *and* non-grantable. `forcePrompt` remains the right answer for the consequential-action subset in §7, where the per-call cost is the point.

### 3.3 Instance epoch (new primitive)

There is **no TaskWraith instance identifier anywhere** in the MCP or approval path. `appRunId` is `provider-timestamp-random` ([RunRoute.ts:10](../src/main/run/RunRoute.ts:10)) with no instance component; `ApprovalLedgerRecord` has no instance field; the broker request payload has none. The only instance-ish artifacts are implicit — the per-process broker token ([index.ts:2345](../src/main/index.ts:2345)) and the `userData`-derived socket path.

That matters because provider MCP registrations are **user-global** (`~/.cursor/mcp.json`, `~/.gemini/settings.json`), so a stale registration can point a CLI child at the wrong instance's socket. The broker token would reject a genuinely foreign instance, so the realistic failure is stale-config → wrong-socket rather than authenticated cross-instance write — but for an actuation primitive that distinction is too fine to rely on.

**Add an `instanceEpoch`:** one `randomUUID()` minted at boot next to the broker token, held in memory, never persisted. Stamped into every lease and verified **by the executor at actuation time**, not asserted by the caller. Mismatch → refuse, fail closed, terminal else. Free side benefit: leases cannot survive a restart, which is what we want anyway.

### 3.4 Never resolve by chatId alone

`RunManager.resolve` falls back: with only `appChatId` it returns the **most recently updated** active session for that provider in that chat ([RunManager.ts:207](../src/main/RunManager.ts:207)). In a parallel fan-out with two seats on one provider, a chatId-only-routed call resolves to the **wrong seat's** `ensembleRun`. `validateMutatingMcpRoute` only requires *one of* the two ([McpRouteGuards.ts:53](../src/main/mcp/McpRouteGuards.ts:53)).

**Every AppDrive verb must require `appRunId` and reject chatId-only routing.**

---

## 4. Ensemble authority

### 4.1 Gate on participant identity, never on role strings

`role` is a free-form `string` ([types.ts:783](../src/main/store/types.ts:783)) and `stageRole` is `'scout'|'worker'|'reviewer'|'background'` ([types.ts:751](../src/main/store/types.ts:751)) — **both are agent-patchable** through `ensemble_roster_edit`'s `PATCH_FIELDS` ([EnsembleRosterMutation.ts:144](../src/main/EnsembleRosterMutation.ts:144), `:153`). Authority is participant-ID equality against `chat.ensemble.bossmanParticipantId` / `secondInCommandParticipantId` ([types.ts:1607](../src/main/store/types.ts:1607)), as every existing check does.

Resolver already exists and is already called from the MCP dispatcher: `listParticipantsForRun(context.appRunId)` ([EnsembleOrchestrator.ts:10530](../src/main/services/EnsembleOrchestrator.ts:10530)) returns `bossmanAuthorityRole: 'boss'|'second_in_command'` plus `bossmanPrimaryUnavailableReason`, failover included. Prefer wrapping `actionableRunForTool` → `resolveBossAuthorityForCaller` ([EnsembleOrchestrator.ts:10088](../src/main/services/EnsembleOrchestrator.ts:10088)) so the gate inherits the `terminalFinalized` check that stops late/retried calls reusing dead authority.

### 4.2 The matrix

| Participant | May operate a leased surface | May create / reassign a lease |
|---|---|---|
| User | yes | yes |
| Boss | yes | yes, within a user-approved drive group |
| Captain | yes, when explicitly assigned | only after formal failover (`primary.unavailable`) |
| BG stage | yes, by direct delegation only | no |
| scout / worker / reviewer | no | no |
| Solo provider chat | yes, with an explicit user-created lease | no |

Captain's dormant failover authority and its active operator lease are **different things**: while Boss is available Captain may operate Surface B as an assigned executor without being an approval authority.

### 4.3 BG — the posture clamp falls out for free

BG is a stage (`stageRole === 'background'`), not a role or flag. Verified properties: dispatched via `runParallelFanoutPass` with `waitForCompletion: false` ([EnsembleOrchestrator.ts:13485](../src/main/services/EnsembleOrchestrator.ts:13485)); absent from `activeRound` until explicitly delegated (`:13444`); excluded from rotation, plan ownership and authority lines ([EnsemblePrompt.ts:821](../src/main/EnsemblePrompt.ts:821), `:411`, `:376`); can never hold Boss or Captain (`:9997`, `:10011`); **always** gets `disallowTrustedSession: true` ([EnsembleOrchestrator.ts:16207](../src/main/services/EnsembleOrchestrator.ts:16207)).

Critically, `resolveBackgroundDispatchPosture` ([EnsembleBackgroundDispatch.ts:74](../src/main/services/EnsembleBackgroundDispatch.ts:74)) clamps a BG lane to `read_only_clamp` unless `honorSeatPosture && writeLanesEnabled`, and `honorSeatPosture: true` is set **only** by the user-origin `runRound` call site. Peer mentions and `ensemble_yield` routes stay clamped.

**Therefore: a BG lane that was not user-mentioned cannot hold an AppDrive lease at all, with no new code.** Only a user-origin-mentioned BG seat with write lanes enabled can be delegated one.

**The lease handed to BG must be clamped *down* by BG's own seat posture, not merely granted by the delegator:**

```
effectiveLease = min(delegator authority, actor seat posture, surface scope)
```

Otherwise Boss becomes a privilege-escalation path around a seat the user deliberately configured read-only. Same principle as the unsigned → `plan`+`read_only` run-permission clamp.

### 4.4 Normalise the authority-role union first

Three literal unions exist for one concept and this is a live drift hazard for a new gate:

- `'boss' | 'second_in_command'` — [EnsembleOrchestrator.ts:10093](../src/main/services/EnsembleOrchestrator.ts:10093), [EnsembleSubThreadMailboxDelivery.ts:60](../src/main/EnsembleSubThreadMailboxDelivery.ts:60)
- `'boss' | 'captain'` — [BossmanAutoApproval.ts:101](../src/main/BossmanAutoApproval.ts:101), `rosterPresetAuthorityRole` ([EnsembleOrchestrator.ts:10544](../src/main/services/EnsembleOrchestrator.ts:10544))
- `'boss' | 'captain' | 'agent'` — [EnsembleParticipantsAboveRow.tsx:120](../src/renderer/src/components/EnsembleParticipantsAboveRow.tsx:120)

Pick one (`'boss' | 'captain'` reads better in UI and matches the user-facing labels) and normalise before adding a fourth consumer. Likewise, there are already **three** hand-duplicated copies of the Boss-unavailability check ([EnsembleOrchestrator.ts:10014](../src/main/services/EnsembleOrchestrator.ts:10014), [index.ts:11807](../src/main/index.ts:11807), [EnsembleSubThreadMailboxDelivery.ts:167](../src/main/EnsembleSubThreadMailboxDelivery.ts:167)) — route the fourth through an existing one, do not re-derive.

### 4.5 Boss auto-approval stays out

[BossmanAutoApproval.ts:88](../src/main/BossmanAutoApproval.ts:88) refuses everything outside `shellCommands`/`fileChanges`, explicitly so Boss can never touch the MCP auto-allow surface. **Keep that.** `appDrive` joins `neverAutoAllow` ([ApprovalOrchestration.ts:478](../src/main/run/ApprovalOrchestration.ts:478)) — Boss may *create a lease* through the deliberate lease flow, and may never *auto-approve an actuation*.

---

## 5. Concurrency and the recovery loop

### 5.1 Two clocks, never one DOM revision

A whole-surface revision that bumps on any DOM mutation **will livelock** — polling, websockets, animations and blinking carets mean it never settles and the agent never lands an action. (Same shape as the SwiftUI one-ULP geometry oscillation that wedged first frames.) Split them:

**Clock A — user presence and freshness (authoritative, main-side).** *Implemented; corrected from the original sketch.* Use `webContents.on('input-event')`, **not** `before-input-event` — the latter is keyboard-only, and a mouse click is precisely the interaction we must not talk over. `input-event` is a main-process hook on the real OS input pipeline, so it covers mouse, wheel and touch, a page cannot forge or suppress it, and **no page-world listener is needed at all**. It also cannot self-trigger: synthetic DOM events dispatched through `executeJavaScript` never enter the input pipeline (we deliberately never use `sendInputEvent`).

Two separate values fall out of it:
- **presence** — `userActiveUntil = now + 1500ms`; any actuation inside that window is refused `user_active` without injecting anything. `mouseMove` is excluded, or a parked cursor would lock the agent out forever.
- **freshness** — a monotonic `inputEpoch`, stamped onto every snapshot. A caller may echo it back as `expectedInputEpoch` and have the action refused `stale_input_epoch` if the human touched the page since. Opt-in: omit it to act on the live page.

**Clock B — per-target precondition (not a counter).** At snapshot time each ref records a `targetIdentity` digest over `{tagName, role, accessibleName, ordinal selector path}`. Before dispatch, the injected script asserts:

1. `el.isConnected`
2. recomputed `targetIdentity` still matches
3. `document.elementFromPoint(bbox center)` resolves to `el` or a descendant

Any failure → `{ok:false, found:false, reason:'stale_target'}`. This closes D1 without a global DOM version.

### 5.2 Honest postconditions

`CanvasActResult` gains:

```ts
executed: boolean               // did we actually dispatch
verified: 'changed' | 'unchanged' | 'unknown'
staleReason?: 'stale_target' | 'stale_input_epoch' | 'user_active' | 'occluded'
```

`verified` comes from a cheap pre/post digest of `{target subtree hash, document.title, url, inputEpoch}`. A click that dispatched but changed nothing returns `executed: true, verified: 'unchanged'` — which the agent contract (§8) requires it to treat as a possible no-op rather than a success. **`ok: true` with `found: true` for a detached node becomes impossible.**

Note `CanvasActResult.action` duplicates the `CanvasActionInput['kind']` union rather than deriving from it ([canvasTypes.ts:140](../src/main/canvas/canvasTypes.ts:140)) — widen both or the new verbs typecheck in one place and not the other.

### 5.3 Serialization and takeover

- **Per-canvas async mutex** so actuations serialize. `chargeInteraction` is a counter and stays one; the mutex is separate.
- **KEEP `el.focus()` on the click path** — reversed from the original plan. A synthetic click has no default action, so `focus()` is what makes focus-driven widgets (menus, comboboxes) work at all; removing it would break them to solve a problem the presence guard already covers. The harm was the agent stealing the caret *while the user was typing*, and an agent that cannot act while the user is active cannot do that.
- **`scrollIntoView`** becomes conditional: skip when the element is already in view, to stop the agent yanking the viewport under a reading user.
- **Sketch (D4):** `sketchUpdate` gains `expectedUpdatedAt` and is refused outright while a stroke is in flight (page-side `draft !== null`).

### 5.4 Audit before execute (D2)

Reorder `click`/`fill` to match `evaluate`: `require → charge → assertLive → emit(intent) → act → emit(outcome only on failure)`.

Emitting the intent *before* execution means a crash or a history-clear race leaves a record that the action was attempted. Emitting the outcome only on failure/unverified keeps it to ~1 event per action against `EVENT_HISTORY_LIMIT = 2000` ([CanvasStore.ts:29](../src/main/canvas/CanvasStore.ts:29)).

**Use best-effort `emit` for ordinary actions and `emitStrict` only for consequential ones (§7).** A strict write is a pinned-fd, fsync'd full-file JSON rewrite; 200 of them per session would be a main-process stall — the known unbounded-sync-`writeJson` freeze class. Audit-before-execute *strictly* only where the action is irreversible.

---

## 6. Credentials and frame egress

Ephemeral partitions mean the user logs in inside the drivable surface, repeatedly, and hosted providers receive the frames.

- **Never type into a secret field.** `fill`/`type` hard-refuse (not redact) when the resolved target is `input[type=password]`, or carries `autocomplete="current-password"|"new-password"|"one-time-code"`. The user types it; the agent does not.
- **Screenshots must not leak password pixels.** Snapshots already redact password and hidden `<input>` **values** — screenshots leak the rendered field. Before `capturePage`, probe the page: if a password field has focus, refuse; if one is visible and non-empty, return the PNG with those rects filled. This is new hardening, not a reorganisation.
- **Disclose the frame destination in the lease consent.** The card names the provider that will receive screenshots. This is the honest version of the privacy claim, and it is also the argument for the local-model path later.
- Sketch surface gains the four missing session hardenings so it matches web (§2).

---

## 6a. HARD INVARIANT — AppDrive never targets TaskWraith's own chrome

**Agreed 2026-07-26 with the session building `theme_tokens_*` (agent-accessed appearance customisation), commit `eed45afa7`.** This is a cross-feature invariant: neither feature is dangerous alone, and the combination is.

Their side of it: TaskWraith's approval and permission chrome is **ordinary DOM in the same document**, so its layout is a security surface — a mis-rendered elevation card is consent forgery that looks like the real gate. Their tool is therefore a strict data channel (allowlisted tokens, typed scalars, no CSS text) that deliberately cannot touch provider identity colours, focus rings, or approval-sheet geometry.

Our side of it, stated as a rule rather than an implementation note:

> **AppDrive must never be able to observe or actuate TaskWraith's own renderer — its main window, its approval sheets, its permission dialogs, or any surface that hosts consent UI.** Targets are limited to canvas surfaces, simulators and Run-owned application windows.

The threat is the **product** of the two capabilities. An agent that can both restyle the chrome and click it can approve its own prompts: shift a decline button under the cursor, or make destructive text unreadable, then click Accept. Each capability is individually reviewable and jointly a complete consent bypass. Neither feature's own review would catch it, which is exactly why it is written down here.

Concretely, for each tier:

- **Tier 0–2 (canvas):** already satisfied structurally, not by policy. Each canvas is its own `WebContents` on an isolated ephemeral partition, and the driver only ever scripts *that* `webContents`. There is no path from a canvas verb to the host renderer, and `canvasEval` is confined the same way. The one thing that must never change: do not add a driver that resolves TaskWraith's own `webContents` as a target.
- **Tier 4 (`window` driver):** this is where the invariant becomes load-bearing rather than free. A PID-bound window driver must **refuse TaskWraith's own process and windows**, by pid identity, not by title or bundle heuristics — titles are attacker-controlled. Fail closed on an unresolvable pid.
- **Tier 5 (general desktop):** the invariant is the reason Tier 5 needs its own risk acceptance rather than inheriting Tier 4's. A general screen-and-input capability can reach our own chrome by construction, so it would need a positive exclusion enforced at the executor, and that exclusion is only as good as its window-identity check.

The user-presence guard (§5.1) is *not* a substitute. It stops the agent talking over a human; it does nothing about an agent driving chrome while the human is away, which is precisely the unattended case AppDrive is for.

### 6a.1 The rule has already caught something

Recorded so this reads as a tested invariant rather than an untested aspiration.

The appearance-customisation feature planned a "Tier 3" that would load TaskWraith's own renderer into a Canvas as a sandboxed preview, so an agent could rehearse a restyle against a copy instead of the real chrome. Checked against §6a, it collapsed into two variants with no safe-and-useful middle:

- **With a preload** it is a second live copy of the app with real IPC, and `canvas_click` reaches real chrome through the front door — a direct violation.
- **Without a preload** `window.api` is undefined and the renderer dies on mount — safe and useless.

**The useful version is precisely the dangerous one.** A third path (a mock-IPC harness serving canned data, essentially Storybook) is safe and genuinely useful, but it is a large build that drifts from reality the moment anyone adds an IPC surface.

**Tier 3 was cancelled, not deferred**, and the premise turned out to be weak independently: the feature's live-apply broadcast means the *user* sees a restyle instantly, and for a taste decision the human is the better feedback loop than an agent screenshotting a copy. So no canvas ever hosts our renderer, and §6a stays structurally true rather than policy-true — the stronger form.

The secondary threat that motivated the conditions is worth keeping even though this particular design is gone: a pixel-identical screenshot of an app state that never happened is **evidence forgery**, and it doesn't need to *be* the app to work — it only needs to look like it. If a self-preview is ever revisited, the load-bearing condition is that any watermark or preview chrome must be stamped **main-side at capture time** (in `screenshot()` after `capturePage`), never in the page, because `canvas_eval` can strip anything the page contains. And `validateCanvasUrl` must stay http(s)-only — a `file://`/`app://` carve-out would weaken the SSRF guard for *every* canvas, so a non-http source wants a separate driver kind, ideally one where `evaluate` is unsupported.

## 7. Consequential-action confirmation

The lease answers "may you touch this surface". It cannot answer "should this particular click happen", and that is where judgment errors live.

Before dispatch, evaluate a **destructive predicate** against the *resolved structured target* — accessible name, ARIA role, element type, enclosing form's method. Matches (delete / remove / send / publish / transfer / pay / confirm / submit-to-non-idempotent, plus `type=submit` inside a form with a payment or destructive intent hint) require a **per-call human confirmation** using the `canvasEval` mechanism verbatim:

- mint a content-bound receipt at prompt-creation time from the exact resolved target the human is shown ([ApprovalOrchestration.ts:592](../src/main/run/ApprovalOrchestration.ts:592)), self-verify it immediately, fail closed on mint failure;
- digest over UTF-16LE code units, not UTF-8 — unpaired surrogates alias to U+FFFD under UTF-8 and would let one receipt verify a different target ([CanvasEvalAudit.ts:29](../src/main/canvas/CanvasEvalAudit.ts:29));
- verify twice: cheap presence check in the executor, authoritative re-derivation in the service;
- claim the `approvalId` in a single-use on-disk ledger **before** writing the event ([CanvasStore.ts:758](../src/main/canvas/CanvasStore.ts:758)) so replay throws and a crash burns the approval rather than reopening the window;
- **desktop-only review** — a paired phone may decline but never accept ([ApprovalService.ts:764](../src/main/services/ApprovalService.ts:764)).

**This is the payoff of AX-first targeting.** You cannot gate "click (840, 210)"; you can gate `Button: "Delete account"`. So the tier order is not "fall back to pixels when structure is missing" — it is "**pixels are the mode where the safety rails are gone**", and a pixel-only action must therefore always be treated as consequential. Note that macOS/DOM structure is excellent for native Cocoa and standard web, and genuinely poor for canvas/WebGL, games and custom-drawn UIs, so the pixel mode is not rare — it needs to be first-class and loud from day one.

Ledger note: `canvas-eval-approval-uses.json` is append-only with **no GC**, and `purgeAuthoritiesStrict` deliberately does not clear it ([CanvasStore.ts:734](../src/main/canvas/CanvasStore.ts:734)) so a scoped privacy clear cannot un-burn an approval. Unbounded growth is the intentional price. AppDrive's uses ledger inherits the same property — say so in the design, do not "fix" it.

---

## 8. The agent-facing contract

Reliability is the recovery loop, not click accuracy. Every computer-use agent's failure mode is compounding error: one misclick and the model's world-model drifts from the screen.

**Mandated cycle, one action at a time in v1 — no long batches:**

```
observe (snapshot + inputEpoch)
  → propose ONE action bound to (targetIdentity, expectedInputEpoch)
  → execute
  → re-observe and verify the postcondition against the stated intent
  → on 'unchanged' or 'stale_*': re-observe, do NOT retry the same action
```

`canvas_wait_for` (selector appears/disappears/text present, bounded timeout) is the primitive that makes this loop cheap instead of a poll.

**Actor/verifier split is where the ensemble is a genuine edge**, and it maps directly onto fan-out: the operator seat proposes, a cheaper seat checks the after-state against the stated intent before the lease advances. Hosted single-agent products structurally cannot do this. It is expensive; make it a per-lease option, default on for consequential actions.

**New verbs** (`CanvasActVerb`): `key` (named-key whitelist only — Enter/Tab/Escape/arrows/Backspace/Delete/Home/End/PageUp/PageDown plus modifier combos; never arbitrary key codes), `type`, `scroll`, `hover`, `select`. Plus `wait_for` as a new driver method.

**Explicitly not in v1:** drag, right-click, double-click, file upload (already refused, [CanvasWebDriver.ts:225](../src/main/canvas/CanvasWebDriver.ts:225)), arbitrary key codes, multi-action batches.

Today's verb set is click + fill only — no keyboard at all beyond setting an input value, no scroll, no hover ([CanvasWebDriver.ts:608](../src/main/canvas/CanvasWebDriver.ts:608)). Observation is ~90% built; actuation is ~40%.

---

## 9. Scope and delivery order

### Tier 1 is loopback-only. This is the most important scoping decision in the document.

Codex's ordering put web first for code proximity. Keep that, but **fence v1 to loopback origins** — your own dev server, your own build under test ([canvasTypes.ts](../src/main/canvas/canvasTypes.ts) already has `isLoopbackHost`). That buys code proximity *and* disposability *and* the QA product story, with no third-party account and no user credentials anywhere near the actuation layer. It is strictly better than either "web, broadly" or "simulator first", because the first thing that ships is undoable.

### One actuating lane in v1

The multi-surface drive group (Boss → Web A, Captain → Simulator B, BG → macOS build C) is well-designed and the logical-resource-lock addition is correct — but you cannot debug three concurrent cursors while the actuation layer is itself unproven; you cannot distinguish an AppDrive bug from an app bug from a lane race. Three lanes against one staging backend is a distributed system with no transaction manager, and the failure mode is nondeterministic flake blamed on the app under test.

"One writer per surface" is the fan-out worktree pattern, which is proven here — but that took a whole feature to get right **for files**, which are inspectable after the fact. UI state is not. Ship one lane, then parallelise.

When it does land, the governing rules are: one writer per surface (many observers); one surface per actor; disjoint surface locks enable concurrency; no ambient access (knowing a canvasId confers nothing); scope changes return to authority; user input wins locally without disturbing other lanes; every lane reports verified postconditions; and **optional logical resource locks** (`test-account:qa-user-17`) alongside the UI locks, so Boss can sequence two lanes that share a fixture. Failover is fail-closed: Boss's surface pauses, Captain does not silently inherit it, and on formal succession Captain explicitly reaffirms, reassigns or closes each lease.

### Tiers

| Tier | Scope | Notes |
|---|---|---|
| **0** | Harden what ships: D1–D5 | No new capability. Do regardless. |
| **1** | AppDrive Web, **loopback origins only** | Lease + verbs + observe-act-verify. The QA-lane product. |
| **2** | AppDrive Web, any origin | Louder consent, credential protections, consequential-action confirmation mandatory. |
| **3** | AppDrive Simulator | XCUITest/idb adapter behind `CanvasDeviceDriver`, which is `simctl`-only today with 11 verbs throwing ([CanvasDeviceDriver.ts:559](../src/main/canvas/CanvasDeviceDriver.ts:559)). Disposable (`simctl erase` is a real undo). |
| **4** | AppDrive Native (managed window) | The declared-but-disabled `window` driver kind ([canvasTypes.ts:14](../src/main/canvas/canvasTypes.ts:14), absent from `SUPPORTED_DRIVERS` at [CanvasService.ts:102](../src/main/canvas/CanvasService.ts:102)). Run-owned PID + ScreenCaptureKit + AX-first. Covers AppKit/SwiftUI/Electron/Tauri/Rust builds. |
| **5** | General attached-window desktop control | Out of scope. Separate decision with its own risk acceptance. |

**Xcode SwiftUI Preview is not a target** — no public control API, needs a running Xcode GUI + XPC, version churn. Already the recorded design conclusion; do not relitigate. For macOS QA, launch a dedicated build/test host and attach a PID-bound window driver.

**Tiers 3 and 4 share more than they appear to:** XCUITest against a simulator and AX against a managed Mac app are the same idea against two different accessibility endpoints. Build one adapter abstraction.

**Run processes are not sandboxed** (§2) and Canvas isolates the *rendered page*, not the dev server or native build behind it. Tier 1 QA sessions deserve explicit sandbox/test-profile work, or at minimum an honest statement that the process under test has the user's privileges.

---

## 10. Residual risk, stated plainly

Accepted for Tier 1–2:

1. **In-origin destructive actions remain possible** on an authenticated surface. Mitigated by §7, not eliminated.
2. **The dev server / native build under test is not sandboxed.** Displaying it in a Canvas does not contain it.
3. **Screenshots leave the Mac when a hosted provider drives.** Disclosed in the lease consent; the local-model path is the eventual answer.
4. **DNS rebinding** needs connect-time IP pinning (pre-existing, documented).
5. **The page-world ref map is ultimately page-controllable** — `Object.freeze` is partial. `targetIdentity` recomputation (§5.1) narrows this but does not close it.
6. **Uses-ledger growth is unbounded by design.**
7. **Judgment errors are the dominant residual.** The sandbox does not address them; the actor/verifier split and consequential confirmation are mitigations, not proofs.

---

## 11. Slice plan

Each slice is independently shippable with gates green. Stage by explicit path and commit in slices — no `stash`, no bulk `git add` (concurrent sessions share the index).

| # | Slice | Notes |
|---|---|---|
| **S0** | Land the dirty `canvasEval` posture change + fix its 4 stale doc surfaces | `plan: deny→ask` and the test flips are already in the tree. Fix [McpToolCatalog.ts:3964](../src/main/McpToolCatalog.ts:3964), [OllamaToolsDoc.ts:111](../src/main/ollama/OllamaToolsDoc.ts:111), its pinning test, and regenerate `resources/Tools.md`. Clears the tree before anything else. |
| **S1** | D1 — target identity + preconditions + honest `CanvasActResult` | Widen both duplicated unions. |
| **S2** | D2 + serialization — audit-before-execute reordering, per-canvas mutex | Best-effort emit, not strict. |
| **S3** | D3 — user takeover: `inputEpoch`, `userActiveUntil`, drop the click focus steal, conditional `scrollIntoView` | Main-side `before-input-event` is the authority. |
| **S4** | D4 — sketch `expectedUpdatedAt` + in-flight-stroke refusal | |
| ~~**S5**~~ | **DONE `bbfa9ec7c`** — grant `surfaceId` binding; `canvasInteraction` workspace grants dropped | Shipped without a new service id — see §3.2. |
| **S6** | Credential protection — secret-field refusal, screenshot redaction, sketch session hardening | |
| **S7** | `instanceEpoch` primitive | Boot-time UUID beside the broker token; verified by the executor. |
| **S8** | Normalise the authority-role union; route Boss-unavailability through one existing implementation | Prerequisite for S10. |
| **S9** | `appDrive` service id + `AppDriveLease` record + `validateAppDriveLeaseForRun` + lease approval prompt + loopback fence + auto-lease on renderer-opened embeds | Clone `validateLaneWriteScopeForRun`. **Full `AgenticServiceId` seam sweep — see §12.** |
| **S10** | Ensemble authority gate — participant-ID equality, `appRunId` required, BG posture intersection | Wrap `actionableRunForTool` → `resolveBossAuthorityForCaller`. |
| **S11** | New verbs (`key`/`type`/`scroll`/`hover`/`select` via `CanvasActionInput.kind`; `wait_for` as a driver method) | Lease-required from birth. New gateway profile (§12). |
| **S12** | Consequential-action confirmation — destructive predicate + `canvasEval`-style receipt + single-use ledger | |
| **S13** | Observe-act-verify agent contract, drive-session reporting, optional actor/verifier split | |
| **S14** | Tier 2 — lift the loopback fence behind louder consent | Gate on S6 + S12 being live. |

---

## 12. Seam inventory (grep-verified 2026-07-26)

This codebase punishes incomplete seam sweeps — `canvasInteraction` and `canvasEval` both shipped with silent gaps. Both lists below were verified against the current tree.

### 12.1 Adding the `appDrive` `AgenticServiceId` (S9)

**Typecheck tripwires (fail loudly — good):**
[store/types.ts:414](../src/main/store/types.ts:414) union · `:598` `AgenticServicesSettings` · `:1789` `ProviderToolingCapabilityId` Exclude · [RunPermissionPosture.ts:553](../src/main/RunPermissionPosture.ts:553) · [ScheduledOccurrenceSeal.ts:78](../src/main/ScheduledOccurrenceSeal.ts:78) · [AgenticServiceMessages.ts:2](../src/main/AgenticServiceMessages.ts:2) labels · [workspacePolicyServices.ts:19](../src/renderer/src/lib/workspacePolicyServices.ts:19) + `:47` · [ProviderCapabilities.ts:29](../src/main/ProviderCapabilities.ts:29) + `:1231`

**Silent-drop seams (fail quietly — the dangerous ones):**

1. **[EffectiveRunPermissions.ts:18](../src/main/EffectiveRunPermissions.ts:18) `AGENTIC_SERVICE_IDS` array** — if the id is missing here, the resolver loop at `:329` never applies the preset *or* the override, so the service silently keeps its raw global setting under **every** posture including `read_only`. Second-order and easy to miss.
2. **[EffectiveRunPermissions.ts:397](../src/main/EffectiveRunPermissions.ts:397) `servicesFromSettings`** — key-by-key, no spread; omission leaves `undefined`.
3. **[NativeApprovalPolicy.ts:46](../src/main/NativeApprovalPolicy.ts:46) `effectiveAgenticSettings`** — spreads `...current`, so the value survives but `preserveCurrentDeny` is skipped and the preset's `deny` is silently replaced by the raw setting. This is the exact P1 leak class.
4. **[CliProviderRuntime.ts:283](../src/main/providers/CliProviderRuntime.ts:283)** — same shape; the runtime-profile strictness clamp is silently skipped.
5. **[settingsHandlers.ts:240](../src/main/ipc/settingsHandlers.ts:240) `rendererSafeSettings`** — omission means the renderer never sees the policy.
6. **[MainSanitizers.ts:1536](../src/main/settings/MainSanitizers.ts:1536) settings-patch rebuild** — its own comment records that three services were once silently dropped here.
7. Also: [MainSanitizers.ts:80](../src/main/settings/MainSanitizers.ts:80), `:97` `GRANTABLE_AGENTIC_SERVICE_IDS`, `:1293` · [store/index.ts:1943](../src/main/store/index.ts:1943) · [agenticServicesDefaults.ts:3](../src/renderer/src/lib/agenticServicesDefaults.ts:3) · [RunQueueService.ts:76](../src/main/services/RunQueueService.ts:76) · [ManagedPolicyService.ts:141](../src/main/ManagedPolicyService.ts:141) · [PluginManifest.ts:101](../src/main/plugins/PluginManifest.ts:101) · [ScheduledOccurrencePostureAuthority.ts:43](../src/main/ScheduledOccurrencePostureAuthority.ts:43) (**runtime throw**, not typecheck) · [AgenticServiceMessages.ts:36](../src/main/AgenticServiceMessages.ts:36) `assertAgenticServiceId` (**rejects the service at the IPC/tool boundary**) · [PluginTypes.ts:16](../src/shared/plugins/PluginTypes.ts:16) (hand-duplicated union, **no** typecheck error)

**Presets:** [EffectiveRunPermissions.ts:63](../src/main/EffectiveRunPermissions.ts:63) `read_only` (exhaustive) · `:113` `plan` (exhaustive) · `:180` `workspace_write` (sparse) · `:209` `full_access` (sparse) · `:226` `PREVIEW_RISK_PROMPT_SERVICES` · `:246` `PLAN_APPROVAL_ONLY_INSTRUMENT_SERVICES`

**Non-grantable machinery:** [PermissionService.ts:38](../src/main/PermissionService.ts:38) `isNonGrantableService` · [EffectiveRunPermissions.ts:425](../src/main/EffectiveRunPermissions.ts:425) `clampNonGrantablePolicy` · `:442` `workspaceGrantServiceIdsFor` · `neverAutoAllow` at **three** hand-listing sites: [index.ts:11752](../src/main/index.ts:11752), [ApprovalOrchestration.ts:478](../src/main/run/ApprovalOrchestration.ts:478), [index.ts:24832](../src/main/index.ts:24832) · [AgenticServiceMessages.ts:57](../src/main/AgenticServiceMessages.ts:57) `approvalActionsForPolicy` (**omission puts "Allow for session" on an elevated card**)

**Three live tool→service classifiers.** `canonicalToolCoalesce` is authoritative for the catalog path but is duplicated by two others; `NativeApprovalPolicy` and the Codex path are pure delegators and need no edit:
- [canonicalToolCoalesce.ts:253](../src/shared/canonicalToolCoalesce.ts:253) — shared, authoritative
- [index.ts:17008](../src/main/index.ts:17008) `claudeAgenticServiceForTool` — its **own substring ladder**; fires first on the Claude path
- [McpToolApprovalPreview.ts:658](../src/main/McpToolApprovalPreview.ts:658) — **does not import the shared module at all**; hand-assigns service literals, terminal fallthrough is `mcpTools`. **Most likely to be missed.**
- [GrokAcpProtocol.ts:294](../src/main/grok/GrokAcpProtocol.ts:294) `grokToolKindToService` — a fourth, keyed on ACP *kind*; unconfirmed whether canvas tools reach it. Verify at runtime.

**Tests:** 6 typecheck-blocking, 5 runtime-blocking, 3 assertion-blocking, ~15 more for coverage. Full list in the S9 working notes.

### 12.2 Adding the new `canvas_*` verbs (S11)

- **Registry:** [taskWraithMcpCatalog.ts:10](../src/shared/taskWraithMcpCatalog.ts:10) `TASKWRAITH_MCP_TOOLS` first · [CanvasToolExecutors.ts:33](../src/main/mcp/CanvasToolExecutors.ts:33) `CANVAS_MCP_TOOL_NAMES` · [McpToolCatalog.ts:3888](../src/main/McpToolCatalog.ts:3888) entry — `orderTaskWraithMcpToolDefinitions` (`:4874`) **throws at module init** on a registry name with no definition.
- **The fail-open hazard:** the family router at [index.ts:30189](../src/main/index.ts:30189) has **no terminal else** (`text=''`, `richResult=null`), so a name in the catalog but missing from `CANVAS_MCP_TOOL_NAMES` returns a **silent successful empty result**. `executeCanvasTool`'s own switch does fail closed ([CanvasToolExecutors.ts:638](../src/main/mcp/CanvasToolExecutors.ts:638)). Add the terminal else as part of this slice.
- **Gateway profiles:** [GATEWAY_V1_MCP_HIDDEN_TOOL_NAMES is derived from FULL_MCP_ADVERTISE_TOOLS](../src/main/mcp/McpToolProfiles.ts:348) despite both being documented immutable — adding to FULL silently mutates the frozen v1 hidden universe and **no test catches it**. Follow the precedent: add `GATEWAY_V6_ADDED_TOOL_NAMES` + hidden list + a `'taskwraith-gateway-v6'` arm, plus [store/types.ts:765](../src/main/store/types.ts:765), [McpSessionProfileFence.ts:17](../src/main/mcp/McpSessionProfileFence.ts:17), [ProviderLaunchAuthorityDigest.ts:1060](../src/main/ProviderLaunchAuthorityDigest.ts:1060).
- **`PLAN_INSTRUMENT_ADVERTISE_TOOLS` is hand-listed** ([McpAutoAllowedTools.ts:246](../src/main/mcp/McpAutoAllowedTools.ts:246)) — a new actuation verb must be added or a `plan` seat can never reach it. Stay out of `MCP_AUTO_ALLOWED_TOOLS`.
- **`ToolClassTaxonomy`:** keep actuation verbs **out** of `ORCHESTRATION_TOOLS` ([ToolClassTaxonomy.ts:156](../src/main/ToolClassTaxonomy.ts:156)) so they inherit the `workspace_write` default and its read-only block. *Verify during implementation how the class-axis block interacts with plan-instrument advertising* — `canvas_click` is both `workspace_write` and plan-advertised, so the two axes evidently compose in a way worth confirming rather than assuming.
- **`inputSchema` is not enforced** — only `ensemble_bossman_control` is in `PRE_APPROVAL_SCHEMA_VALIDATED_TOOLS` ([McpPreApprovalArgumentValidation.ts:10](../src/main/mcp/McpPreApprovalArgumentValidation.ts:10)). **Join it**, so the human sees validated args on the approval card.
- Route A (extend `CanvasActionInput.kind`) covers `key`/`type`/`scroll`/`hover`/`select`: the four non-web drivers already `unsupported(...)` for any `act` kind, so they need no edit. Route B (`wait_for` as a new `CanvasDriver` method) requires all six drivers plus `FakeDriver` ([CanvasService.test.ts:95](../src/main/canvas/CanvasService.test.ts:95)) — TypeScript catches those.
- `actScript`'s JSON payload drops any field not in `{kind,ref,selector,x,y,value}` ([CanvasWebDriver.ts:195](../src/main/canvas/CanvasWebDriver.ts:195)) — new params need explicit plumbing.
- `canvasTargetAudit` only digests `ref`/`selector` ([CanvasService.ts:142](../src/main/canvas/CanvasService.ts:142)); a `type` verb needs its own redacted projection. `fill` deliberately never logs `value` — preserve that.
- **`resources/Tools.md` is a byte-identical drift test** ([OllamaToolsDoc.test.ts:28](../src/main/ollama/OllamaToolsDoc.test.ts:28)). Regenerate: `npm run generate:ollama-tools-md`.
- **IPC** only if a renderer control is added: [IpcValidation.ts:89](../src/main/IpcValidation.ts:89) `IPC_ARGUMENT_SCHEMAS` (a missing entry throws on **first invocation**, though `IpcValidation.test.ts` / `RendererIpcPolicy.test.ts` do catch it at test time) · [RendererIpcPolicy.ts:284](../src/main/RendererIpcPolicy.ts:284) · [CanvasEmbedIpc.ts:163](../src/main/canvas/CanvasEmbedIpc.ts:163) · preload `index.ts` + `index.d.ts`.

### 12.3 Pre-existing gaps found in passing (not caused by this work)

- `threadMessage` is missing from the `tw_approvals_list` service enum ([McpToolCatalog.ts:1739](../src/main/McpToolCatalog.ts:1739)) — agents cannot filter for it.
- `TaskWraithPluginAgenticServiceId` is missing `externalPublish` ([PluginTypes.ts:16](../src/shared/plugins/PluginTypes.ts:16)) although `PluginManifest.ts:104` accepts it.
- `CanvasDriverKind` includes `'window'` with no implementing class anywhere.

---

## 12a. Found while implementing §3.2 — and fixed

Mapping the grant lifecycle turned up a disclosure the design had not anticipated, fixed in `520415ce5`.

The canvas approval preview passes the tool's raw args through as `preview.params` so the human can see what is about to be typed. That same payload is written to the durable run-event store **and** the approval ledger, and the durable redaction path special-cased `canvasEval` only — so **`canvas_fill`'s typed value was retained indefinitely in two places**, while the tool catalogue told models *"the typed value is never recorded in the audit log."*

The claim was true of the canvas audit log (which deliberately records only the target) and false of the approval path. **A security claim that holds for one store and not another is worse than no claim, because it is the one people quote.** Fixed with the same live-vs-durable split `canvas_eval` uses: the human still sees the real value transiently, the permanent record keeps only its shape, and targeting metadata is untouched so the audit trail is not gutted.

Narrower than it first sounds now that credential fields are refused outright (§6) — the values reaching this path are ordinary form data, not passwords. Ordinary form data is still the user's.

**Generalisable lesson:** the preview object is the one place a tool's raw arguments travel this far into the permission machinery, and it feeds a transient sink and two durable ones. Any tool whose args contain something you would not keep forever needs a durable-path redaction, not just a careful audit-log call.

**The fix is forward-only, and deliberately so.** Records already written still hold those values, and 1.9.0 does not rewrite them — which is why the release notes disclose it rather than fixing it quietly: a user who knows can clear that chat's history, a user who doesn't cannot.

A retro-scrub was considered and rejected on grounds worth recording, because it will be proposed again:

- **The approval ledger is hashed into a signed audit bundle** — `ProductOperations.ts:148`, `approvalLedger: diagnosticsSha256(...)`, with a record count at `:128`. Rewriting historical records to redact them would silently invalidate the hash of any bundle already issued, and the resulting mismatch is indistinguishable from tampering. **Scrubbing an audit log is itself an audit-integrity event.**
- **The ledger self-caps.** Writes go through `capApprovalLedgerRecords` ([store/index.ts:483](../src/main/store/index.ts:483)), which bounds retained non-live history — live records are always kept, the rest age out through ordinary use. The residue is transient by design.
- **There is no precedent for mutating durable run events.** The only paths that touch them are the scoped and global history clears, which are user-initiated and already the right tool. Inventing a mutation path for this would be a new capability with a wider blast radius than the thing it cleans up.

So disclosure plus the existing history-clear is the correct remediation, not merely the cheap one.

## 12b. The 1.9.1 self-launch incident, and what it revealed

A seat with launch grants was asked to QA the app, spawned TaskWraith itself, and hit what looked like constant crashes. Diagnosed 2026-07-26; **the crash is fixed (`d79ab7f7c`), the two capabilities it implied are not, and are sized here.**

### What actually happened — a bug, not an AppDrive gap

[devAppName.ts:111](../src/main/devAppName.ts:111) gates the entire multi-instance lane behind `!app.isPackaged`. A **packaged** build therefore ignores `TASKWRAITH_INSTANCE_ID` completely — same app name, same userData, same lock — so a child copy hits `app.requestSingleInstanceLock()` ([index.ts:35028](../src/main/index.ts:35028)) and quits in milliseconds. Provider- and grant-agnostic; launching any *other* app would have worked.

The cost was the **retry loop**, not the exit: an instant exit with no window and no useful stderr reads as transient. Fixed by refusing up front with a reason that says not to retry.

**The process-parenting the incident seemed to call for already exists** — that is Run/`LaunchManager`: PID *and* process group tracked, killed via the negative pgid, start reservation held across approval, cwd jailed, `LD_PRELOAD`/`DYLD_*` stripped, surfaced in Active processes. What does not exist is any way to *drive* what it spawns.

### B — supported self-instancing. Larger than it looks; do not rush it.

Naively flipping the `!app.isPackaged` gate is unsafe. The broker socket is instance-scoped — `join(app.getPath('userData'), 'taskwraith-gemini-mcp.sock')` ([index.ts:30531](../src/main/index.ts:30531)) — but the provider-side registration that points at it is **not uniformly so**:

- **Claude** gets a **per-run** MCP config written to the OS temp dir plus `--mcp-config <path>` on argv ([index.ts:18399](../src/main/index.ts:18399)) — already instance-safe.
- **Gemini** resolves `~/.gemini/settings.json` ([index.ts:30534](../src/main/index.ts:30534)) — user-global, one file, last writer wins. There is already a `repairKnownStaleGeminiMcpBridgeConfigs` path ([McpBridgeRuntime.ts:2683](../src/main/mcp/McpBridgeRuntime.ts:2683)) that shells out to `gemini mcp list` to detect staleness, which is direct evidence this has bitten before.
- **Cursor** uses `~/.cursor/mcp.json`, same shape.

So B is not one gate flip — it is **auditing MCP-bridge registration across the provider roster** and making the non-per-run ones instance-aware. Two instances otherwise means a CLI child launched by instance A can dial instance B's socket: precisely the known cross-instance write leak, which this would *widen*. **A half-done B is worse than no B.**

Also unresolved and worth deciding before building: should a *release* build ever run a second instance? An accidental `TASKWRAITH_INSTANCE_ID` gives a user an empty app with none of their chats. That argues for a distinct, explicit opt-in rather than reusing the dev variable.

### C — the `window` driver. Gated on a consent flow, not on a driver class.

The `window` kind is declared in `CanvasDriverKind` and absent from `SUPPORTED_DRIVERS`, which makes it look like a one-line enable. It is not.

- **Capture exists**: `swift/TaskWraithBridge` owns SCStream/`SCContentFilter` window capture with OCR, exposed as `appwatch_start` / `_stop` / `_status` / `_frames` / `_latest_frame`.
- **The implementation is in Swift, over JSON-RPC** — there is no TS Appwatch service class to hang a driver off, so a `CanvasWindowDriver` needs a bridge client.
- **Attachment requires a user picker.** `AttachedWindow.swift` sources its metadata by correlating `SCShareableContent` *against the picker's filter*. An agent cannot attach a window by itself.

That last point is the important one, and it is a **feature, not an obstacle**: consent by construction. But it means C is really *"the user attaches a window, and an agent may then observe it as a canvas"* — an attach/adopt flow with UI, not a driver registration. Screenshot-only, following `CanvasDeviceDriver`'s pattern where structured verbs explicitly throw.

### Actuation over a native window is blocked on a macOS permission

Worth stating plainly so nobody re-scopes it optimistically: there is **zero actuation primitive anywhere in the tree** — no `AXUIElement`, no `CGEvent`, in TS or Swift — and the app has never declared or requested the Accessibility TCC permission. Native actuation therefore needs a new Swift input surface *and* a permission the user must grant in System Settings, which cannot be done programmatically.

That is Tier 4, and it should be planned as a permission-and-consent feature that happens to involve input synthesis, not as a driver that happens to need a permission.

## 13. Open questions for the next session

1. Does `grokToolKindToService` sit on the live path for canvas tools, or do Grok canvas calls always route through the MCP-bridge preview? Needs runtime tracing.
2. ~~How do the class axis and `PLAN_INSTRUMENT_ADVERTISE_TOOLS` compose?~~ **ANSWERED 2026-07-26, verified at the source.** They are two orthogonal layers that AND, and the class axis does **not** gate the plan tier at all:
   - `classifyTool(name) === 'workspace_write'` feeds exactly two consumers — `isReadOnlyBlockedTool` ([ToolClassTaxonomy.ts:330](../src/main/ToolClassTaxonomy.ts:330)), which is the **read_only deny**, and `isMutatingTaskWraithMcpTool` ([McpRouteGuards.ts:17](../src/main/mcp/McpRouteGuards.ts:17)), which is the **unrouted-mutation guard** (a mutating bridge call with no run/chat route is rejected outright, `:69` and `:106`).
   - `PLAN_INSTRUMENT_ADVERTISE_TOOLS` ([McpAutoAllowedTools.ts:246](../src/main/mcp/McpAutoAllowedTools.ts:246)) is **bridge visibility only**. Plan-tier safety comes from the main-side service gate (`canvasInteraction: 'ask'`), backed by the `SAFETY INVARIANT` test at [McpAutoAllowedTools.test.ts:287](../src/main/mcp/McpAutoAllowedTools.test.ts:287) asserting no plan instrument is also in `MCP_AUTO_ALLOWED_TOOLS`.

   Being `workspace_write` therefore neither adds nor removes anything under `plan`. **Trap for new verbs:** `PLAN_INSTRUMENT_ADVERTISE_TOOLS` is a `.filter()` over three hard-coded literals plus `MEDIA_EDITING_TOOLS`, so a new verb is not picked up automatically and must be added by name. It fails safe (forget it → invisible to plan seats, not silently permitted), but the invariant test only iterates that derived list, so a new verb inherits the not-auto-allowed guarantee **only once added** — add to both or neither.
3. Should Tier 1's loopback fence be origin-based (`isLoopbackHost`) or Run-attempt-based (only URLs `detectedUrls` produced)? Run-attempt-based is tighter and ties the lease to a build under test, which is the QA framing — but it forbids driving a hand-typed `localhost` URL.
4. Sandbox posture for the process under test — real seatbelt profile, or documented non-containment?
