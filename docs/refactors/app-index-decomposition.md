# Workspace Monolith Decomposition Plan

Last refreshed: 2026-07-08

This is the active source of truth for decomposing TaskWraith's remaining
monoliths. It supersedes the old tactical "First 10 Slices" queue in this file
and the older renderer-only plan in `docs/app-tsx-decomposition.md`.

The immediate priority remains `src/renderer/src/App.tsx` and
`src/main/index.ts`, but the mission is broader: keep decomposing the workspace
until large production modules have intentional ownership, clear public APIs,
focused tests, and no extracted file has simply become the next monolith.

## Objective

Turn the two largest roots into explicit composition roots:

- `src/renderer/src/App.tsx` should own renderer bootstrapping, top-level state
  composition, and view assembly only.
- `src/main/index.ts` should own Electron pre-ready ordering, service
  construction, top-level registrar calls, and process lifecycle only.

Then continue through the workspace-wide large-file backlog with the same
rules. The target is not a magic module count. The target is a module graph
where each file has one domain owner, capped complexity, typed seams, and a
test or smoke gate that proves the extraction preserved behavior.

Use roughly 3-4K lines as a soft ceiling for production files and for newly
extracted modules. A file above that ceiling is not automatically wrong, but it
must have an explicit reason and a follow-up split plan. Never move one 8K pile
into a new 8K file and call the slice done.

## Current Snapshot

Measured from the live worktree on 2026-07-08. Pass-1 landed two slices
(`5d1ada4fb`, `6a06b1ebc`); main-root metrics below reflect post-`main-m1`
state. `src/renderer/src/App.tsx` remains at 25,738 lines. Treat these numbers
as orientation only. Every Ensemble round must refresh counts and dirty state
before assigning a slice.

Pass-2 dirty baseline (recorded at round start):

- Branch `master`, ahead 48 of `origin/master` (includes pass-1 commits).
- `src/main/index.ts` contested by a foreign session — chat CRUD slice HELD.
- Untracked scaffold paths from @NewFiles pending adversary review:
  `src/main/runtime/MainRuntimeContext.ts`,
  `src/renderer/src/hooks/useScopedIpc.ts`,
  `src/renderer/src/hooks/useScopedIpc.test.ts`,
  `src/renderer/src/state/chatMutations.ts`,
  `src/renderer/src/state/useChatMutations.ts`.
- `.cursor/` untracked — never staged.
- Peer-owned dirty paths (`ios/**`, bridge/remote/store) defer or coordinate
  before write.

Tier-2 orientation: early Pass-1 recon reported `SettingsPanel.tsx` ~10,714 and
`EnsembleOrchestrator.ts` ~11,996 lines; live `wc -l` on 2026-07-08 confirms
11,063 and 12,416 — the ranking table below remains accurate.

IPC handler-test gap (43 flat modules, 39 tests): `shellHandlers`,
`contextCompactionHandlers`, `ptyHandlers`, and `ensembleRosterPresetsHandlers`
lack focused handler tests. `humanCollaborationHandlers.test.ts` landed in
pass-1 (`6a06b1ebc`).

Snapshot commands:

```sh
wc -l docs/refactors/app-index-decomposition.md src/renderer/src/App.tsx src/main/index.ts
find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 wc -l | sort -nr | head -40
rg -n "ipcMain\.(handle|on)" src/main/index.ts | wc -l
rg -n "^\s+register[A-Za-z0-9]+Handlers\(" src/main/index.ts | wc -l
find src/main/ipc -maxdepth 1 -name '*Handlers.ts' | wc -l
find src/main/ipc -maxdepth 1 -name '*Handlers.test.ts' | wc -l
rg -n ": any" src/renderer/src/app/views/MainAppLayout.types.ts | wc -l
git status --short
```

Current high-level facts:

| Area | Current signal |
| --- | ---: |
| `src/main/index.ts` | 31,698 lines (was 32,234 pre-pass-1) |
| `src/renderer/src/App.tsx` | 25,738 lines |
| Inline `ipcMain.handle/on` registrations still in `index.ts` | 77 (was 103) |
| Registrar calls already wired from `index.ts` | 44 (was 43) |
| Flat `src/main/ipc/*Handlers.ts` modules | 43 (was 42) |
| Flat `src/main/ipc/*Handlers.test.ts` modules | 39 (was 38) |
| `MainAppLayout.types.ts` remaining `: any` props | 391 |

Largest production TS/TSX files at this snapshot:

| Rank | File | Lines | Campaign |
| ---: | --- | ---: | --- |
| 1 | `src/main/index.ts` | 32,234 | Tier 1 main root |
| 2 | `src/renderer/src/App.tsx` | 25,738 | Tier 1 renderer root |
| 3 | `src/main/services/EnsembleOrchestrator.ts` | 12,416 | Tier 2 service |
| 4 | `src/renderer/src/components/SettingsPanel.tsx` | 11,063 | Tier 2 renderer settings |
| 5 | `src/renderer/src/components/Sidebar.tsx` | 5,533 | Tier 2 renderer shell |
| 6 | `src/main/store/types.ts` | 5,490 | Tier 2 store types |
| 7 | `src/main/store/index.ts` | 5,467 | Tier 2 store |
| 8 | `src/renderer/src/components/Composer.tsx` | 4,879 | Tier 2 composer |
| 9 | `src/renderer/src/components/TranscriptPanel.tsx` | 4,292 | Tier 2 transcript |
| 10 | `src/main/McpToolCatalog.ts` | 4,218 | Tier 2 MCP catalog |
| 11 | `src/main/mcp/WorkspaceToolExecutors.ts` | 3,511 | Tier 2 MCP executors |
| 12 | `src/renderer/src/components/ActivityStack.tsx` | 3,423 | Tier 2 transcript/activity |
| 13 | `src/main/ollama/OllamaProvider.ts` | 3,162 | Tier 2 provider |
| 14 | `src/renderer/src/components/Inspector.tsx` | 3,055 | Tier 2 renderer component |

Largest test hotspot: `src/main/services/EnsembleOrchestrator.test.ts`
is 12,641 lines and should be split when the service is split.

## Completed Work Archive

The previous R/M slice history remains useful as evidence of extraction
patterns, but it is no longer an active queue. Do not execute old slice labels
without fresh recon.

- Renderer: R1-R9 plus R9b-1/R9b-2 landed. The important result is that
  `MainAppLayout` exists, `MainAppLayout.types.ts` has started to tighten its
  prop contract, and view-host extraction proved that typecheck alone is not
  enough to catch runtime prop omissions.
- Main: M1-M17f and later focused registrar slices landed many flat IPC
  modules under `src/main/ipc/`; as of pass-1 close there are 43 handler
  modules and 39 focused handler tests. That proved the registrar pattern and
  reduced inline `ipcMain.handle/on` registrations to 77, but the easy
  thin-registrar well is now mostly exhausted. The remaining mass is facade and
  trust-boundary work, not just more file shuffling.
- Main pass-1 (2026-07-08): `refactor(main-m1)` — 26 human-collaboration
  channels moved from inline `index.ts` into `humanCollaborationHandlers.ts`
  with `HumanCollaborationHandlersDeps` injection, will-quit collaborator
  teardown, and focused registration test (`humanCollaborationHandlers.test.ts`,
  4 tests). Commit `6a06b1ebc`. Gates: `npm run typecheck:node` green;
  `npm test -- src/main/IpcValidation.test.ts` (34) and
  `npm test -- src/main/ipc/humanCollaborationHandlers.test.ts` (4) green.
- Docs pass-1 (2026-07-08): `docs(refactor-plan)` Phase-0 baseline refresh —
  Pass-1 dirty snapshot, cadence override for concurrent locked scopes,
  handler-test gap, and active slice ledger. Commit `5d1ada4fb`. Gate:
  `git diff --check -- docs/refactors/app-index-decomposition.md` green.
- Current IPC handler rule from `src/main/ipc/README.md` still applies:
  handler modules stay directly under `src/main/ipc/` unless the IPC validation
  scanner is expanded in the same commit.

Archive rule: plan updaters may add commit ids and facts after slices land, but
the active work queue lives in the phase plan below.

## Non-Goals

- No behavior changes ride along with extraction commits.
- No visual redesigns, provider behavior changes, approval policy changes, or
  feature work inside structural slices.
- No repository-wide formatting. Follow `AGENTS.md`: format only files
  deliberately touched when formatting is part of the slice.
- No new barrel exports until the module graph is stable.
- No imports from extracted modules back into `App.tsx` or `index.ts`.
- No direct provider dispatch from extracted scheduler, workflow, remote,
  sub-thread, MCP, or IPC modules.
- No slice may land by only moving a large block into a newly large file.

## Global Invariants

These rules are more important than line-count reduction:

- A new module needs a domain noun, a named owner, one public API shape, and a
  reason it will not immediately exceed the soft cap.
- Extracted modules receive dependencies through typed arguments or context
  objects. They do not import late-bound mutable state from orchestration roots.
- Pure helpers must not import React hooks, Electron, browser globals, mutable
  app stores, or provider runtime services.
- Renderer modules may import main-process types only with `import type`, and
  only when the type is already safe for the renderer bundle. If a value is
  shared, move it to an explicit shared module.
- Main-process side effects that rely on Electron ordering remain visible in
  `index.ts` or a documented bootstrap module.
- `protocol.registerSchemesAsPrivileged` stays pre-ready and single-call.
- `installIpcValidation(ipcMain)` stays before handler registration.
- Run dispatch remains centralized behind `RunCoordinator`,
  `dispatchRunWithProviderPause`, or a future `runDispatchFacade`.
- Approval resolution remains a single choke point. Provider code must not call
  approval modals, grants, ledgers, or policy bypasses directly.
- Worktree hygiene is part of the architecture work. A clean staged diff is a
  gate, not a courtesy.

## Ensemble Rollout Discipline

Run the Ensemble as a slice factory, not a debate room. Each round should
produce at most one committed implementation slice, with separate recon, write,
review, and plan-update responsibilities.

Pass-1 cadence override (2026-07-08): when Lead authorizes disjoint locked
write scopes, multiple slices may land in one pass — each with its own gates and
exact pathspec commit. The default one-slice-per-round rule resumes unless Lead
re-authorizes concurrent scopes.

### Roles

| Role | Responsibility | Output |
| --- | --- | --- |
| Lead / Committer | Owns the queue, file ownership, staging, commits, and go/no-go | One committed slice or a documented deferral |
| Deep Recon | Read-only mapping of source anchors, dependencies, dirty files, and gates | Slice brief with current facts |
| Writer | Edits only the assigned files for one slice | Focused patch and tests |
| Adversarial Reviewer | Reviews the actual diff before commit | Behavior, boot-order, ownership, and test-risk findings |
| Plan Updater | Updates this doc after a slice lands or is deferred | Commit id, tests, blockers, next checkpoint |

Recon stays read-only unless Lead explicitly promotes it. Writers are not alone
in the worktree: they must assume unrelated dirty files belong to someone else.

### Slice Contract

No writing starts until the slice has:

- one outcome;
- explicit file list;
- explicit owner;
- allowed imports and forbidden imports;
- dependency injection plan for extracted code;
- side effects and ordering that must be preserved;
- focused tests or manual smoke gate;
- current `git status --short`;
- stop condition if the slice proves larger than expected.

If the writer discovers a second domain, unrelated files, or a behavior change,
stop and return to recon. Do not stretch the slice.

### Concurrent Worktree Rules

At slice start, Lead records the dirty baseline. Existing dirty or untracked
files are treated as owned by another session unless ownership is explicit.

Use exact path staging only:

```sh
git status --short
git diff -- <slice paths>
git diff --check -- <slice paths>
git add -- <slice paths>
git diff --cached --name-only
```

`git diff --cached --name-only` must show only approved slice paths. Never use
`git add -A`, `git add .`, or broad path staging for decomposition work.

Ops note: `docs/` is gitignored-but-tracked in this repo. Staging plan-doc
slices requires `git add -f -- docs/refactors/app-index-decomposition.md` (or
the specific doc path). @CheckCommit must use `-f` for docs commits.

If a target file is already dirty from another session, defer, coordinate
ownership, or split the slice into non-overlapping files. Do not edit over
concurrent changes.

### Commit Cadence

Commit immediately after a green slice. Do not accumulate multiple slices in
the worktree. Commit messages should name the phase and domain, for example:

```text
refactor(renderer-r0): add scoped app ipc unsubscribe
refactor(main-m1): extract human collaboration ipc handlers
```

Each commit body should list the exact gates run. If a full gate is red because
of a documented unrelated baseline, Lead may accept focused gates only when the
staged diff is limited to the slice paths and the failure is named.

## Active Phase Plan

The phase order is explicit. Exact line ranges are intentionally omitted because
they rot quickly. Recon must refresh anchors before each slice.

### Active slice ledger

#### Pass 1 — LANDED (2026-07-08)

| Slice | Owner | Status | Commit | Gates | Metric deltas |
| --- | --- | --- | --- | --- | --- |
| `docs(refactor-plan)` Phase-0 baseline refresh | @WriteDocs | LANDED | `5d1ada4fb` | `git diff --check` on doc path | — |
| `refactor(main-m1)` human collaboration IPC extraction | @WriteMain | LANDED | `6a06b1ebc` | `typecheck:node`; `IpcValidation.test` (34); `humanCollaborationHandlers.test` (4) | inline `ipcMain` 103→77; `index.ts` 32,234→31,698; handler modules 42→43; handler tests 38→39; registrar calls 43→44 |

Pass-1 retired from the active queue. Stale IN FLIGHT rows above are superseded
by this table.

#### Pass 2 — IN FLIGHT (2026-07-08)

| Slice | Owner | Status | Scope | Notes |
| --- | --- | --- | --- | --- |
| `refactor(preload-r0)` scoped app IPC unsubscribes | @WriteMain | IN FLIGHT | `src/preload/index.ts`, `src/preload/index.d.ts` ONLY | 17 void listeners → scoped unsubscribes; `index.d.ts` parity; additive — `removeListeners()` stays until renderer-r0 lands |
| `refactor(renderer-r0)` scoped app IPC unsubscribe | @WriteRender | IN FLIGHT | `src/renderer/src/App.tsx` | Serial after preload green; fresh zero-gap precheck mandatory; delete `removeListeners()` |
| `refactor(main-m1)` residual chat CRUD | @WriteMain | HELD | `src/main/index.ts`, `src/main/ipc/chatHandlers.ts` | `index.ts` contested by foreign session; channels: `save-chat`, `delete-chat`, `reap-abandoned-chats`, `truncate-chat`, `clear-chats` |
| NewFiles scaffolds (5 files) | @NewFiles | IN FLIGHT | `src/main/runtime/MainRuntimeContext.ts`; `src/renderer/src/hooks/useScopedIpc.ts` + `.test.ts`; `src/renderer/src/state/chatMutations.ts`; `src/renderer/src/state/useChatMutations.ts` | Pending @Adversary1 review before commit |
| `docs(refactor-plan)` pass-1 ledger update | @WriteDocs | IN FLIGHT | `docs/refactors/app-index-decomposition.md` | This slice |

Commit names: `refactor(preload-r0): return scoped unsubscribes from app ipc
listeners`, `refactor(renderer-r0): add scoped app ipc unsubscribe`,
`refactor(main-m1): move residual chat crud into chat handlers`,
`docs(refactor-plan): record pass-1 landed slices`. @CheckCommit owns staging
and commits by exact pathspec only (`git add -f` for docs).

### Phase 0 - Refresh And Freeze Invariants

Purpose: make the next implementation slice safe.

Actions:

- Refresh the large-file inventory, dirty state, inline IPC count, registrar
  count, `MainAppLayout.types.ts` `any` count, and known red/green gates.
- Build a current ownership map for late-bound refs and roots: run sessions,
  bridge broadcasters, provider processes, MCP brokers, composer service,
  ensemble orchestrator, approval service, launch/process registries, and
  persistent provider seat/session state.
- Add or identify route-coverage tests for MCP tool catalog, auto-allowed
  tools, read-only advertised tools, mutating tools, unknown tools, and approval
  service classification before moving MCP dispatch code.
- Identify trust-boundary bundles that must move together: run payload
  normalization, posture signing/verifying, external grant normalization,
  provider preflight, durable run events, approval resolution, and workspace
  trust.

Done when Lead can assign a slice without relying on stale line numbers or
unowned mutable root state.

### Renderer R0 - Scoped IPC Cleanup And Chat Mutation Ownership

Purpose: unblock safe renderer state-hook extraction.

Actions:

- Ensure every `window.api.on*` listener used by renderer code returns a scoped
  unsubscribe or is wrapped by a renderer-owned scoped subscription API.
- Ban broad `window.api.removeListeners()` from extracted hooks.
- Establish a single chat mutation facade. Extracted modules may not call
  `setChats`, `setCurrentChat`, or mutate `chatByIdRef` directly.
- Add pure selector contracts for chat scope, runtime provider vs display
  provider, welcome state, rendered transcript messages, composer lock/model
  state, and workspace selection decisions.

Do not extract event-ingestion hooks before this phase lands.

Suggested gates:

- `npm run typecheck:web`
- focused preload/renderer subscription tests where practical
- chat merge/reconcile tests
- Electron smoke if runtime listener wiring changes

### Renderer R1 - Layout Prop Contract And Focused Chat Surface

Purpose: finish the safety contract created by the `MainAppLayout` extraction.

Actions:

- Continue `MainAppLayoutProps` typing by hand, one prop group per commit.
- Do not use script-generated prop typing.
- Group by real ownership: sidebar, settings, focused chat surface, side chat,
  right dock, multiview, shell, modals.
- Introduce a focused chat surface boundary only after its props are typed
  enough to avoid another runtime missing-identifier crash.
- Use `ChatViewPane` as a behavioral precedent, not a drop-in source of truth:
  focused chat has focused-only affordances that secondary panes intentionally
  disable.

Suggested gates:

- Pure `.types.ts` slice: `npm run typecheck:web` and `git diff --check`
- Runtime TSX slice: same plus Electron renderer smoke with zero console errors
- `ChatViewPane` comparator updates in the same slice as any render-affecting
  prop addition

### Renderer R2 - Root JSX, ModalHost, Welcome, Transcript, Composer View Models

Purpose: remove view assembly from `App.tsx` without moving state too early.

Actions:

- Extract `ModalHost` and root sheet/modal siblings after R1 makes prop
  threading explicit.
- Extract `WelcomeSurface` / `useWelcomeSurfaceModel` so welcome, transcript,
  and composer remain one behavioral surface.
- Extract focused transcript prop builders only with tests proving focused-only
  affordances remain present: file diffs, user gutter, plan/question handlers,
  cost props, side-chat affordances, and run summaries.
- Introduce typed `ComposerViewModel` and `ComposerActions` builders before
  splitting `Composer.tsx`.

Suggested gates:

- `npm run typecheck:web`
- focused tests for welcome state, welcome dashboard, chat view props,
  transcript props, model picker, permissions picker, composer provider binding
- Electron smoke for global welcome, workspace welcome, ensemble welcome,
  provider switch, model picker, permission picker, side chat, multiview, long
  transcript scroll/search/jump, and usage dashboard

### Renderer R3 - Run, Side Chat, Workflow, Ensemble, And Composer Controllers

Purpose: move high-leverage state out of `App.tsx` behind explicit facades.

Order:

1. Run queue helpers and request-building selectors.
2. Run persistence/rehydration and execution controller.
3. Side-chat and guest participant state after run ownership is explicit.
4. Workflow, board, cockpit, and scheduled-run controllers.
5. Ensemble participant binding and selected-participant mutation helpers.
6. Composer prop/model controller, then `Composer.tsx` split below the soft cap.

Guardrails:

- Provider/workspace selection is transactional behavior, not a picker callback.
- Welcome, transcript, and composer state must not diverge between focused and
  multiview panes.
- Mount-once IPC effects should remain event routers using refs; do not "fix"
  dependencies by re-registering listeners on every chat/workspace change.

### Main M0 - Runtime Context And Trust Boundary Map

Purpose: prevent `index.ts` extraction from creating hidden cycles or policy
holes.

Actions:

- Create or update a typed `MainRuntimeContext` plan with getters for
  late-bound services.
- Assign ownership for all mutable root refs before moving functions.
- Freeze approval, MCP, run-normalization, and provider fallback invariants in
  tests or explicit slice gates.
- Identify which functions are pure leaves and which are trust boundaries that
  must move as bundles.

Recommended context shape:

```ts
export interface MainRuntimeContext {
  store: AppStoreLike
  getMainWindow: () => BrowserWindow | null
  sendToRenderer: (channel: string, payload: unknown) => void
  getApprovalService: () => ApprovalService
  dispatchRun: (payload: AgentRunPayload) => Promise<RunDispatchResult>
}
```

### Main M1 - Remaining Inline IPC Domains

Purpose: finish the low-coupling registrar migration before deeper runtime
facades.

Candidate clusters, subject to fresh recon:

- iOS remote config and pairing
- human collaboration
- chat CRUD still inline after existing `chatHandlers`
- ensemble controls and wakeups
- approval response handlers
- Gemini session/PTY controls
- residual provider usage/status handlers

Rules:

- New IPC modules stay flat under `src/main/ipc/`.
- Every handler receives explicit deps.
- No IPC module imports `src/main/index.ts`.
- Every registered channel remains covered by IPC validation.

Suggested gates:

- `npm run typecheck:node`
- `npm test -- src/main/IpcValidation.test.ts`
- focused handler tests for the moved domain

### Main M2 - MCP Dispatcher And Policy Split

Purpose: shrink the shared TaskWraith MCP dispatcher without weakening gates.

Actions:

- Split approval preview and service classification into a tested module.
- Split execution by tool family only after route coverage proves every
  `TASKWRAITH_MCP_TOOLS` entry has exactly one intended route.
- Keep auto-allowed, read-only-advertised, mutating, shell/write,
  orchestration, and unknown-tool policies distinct.
- Do not move the whole dispatcher into one new giant file.

Suggested gates:

- MCP catalog completeness tests
- permission classifier tests
- auto-allowed invariant tests
- focused executor tests for each moved family

### Main M3 - Run Dispatch, Compose-Run, And Approval Facades

Purpose: extract the core run path as a trust-boundary bundle, not as scattered
helpers.

Actions:

- Move run payload normalization, posture signing/verifying, external grant
  normalization, provider preflight, and durable run-event setup as a designed
  unit.
- Keep scheduled, headless, remote, sub-thread, ensemble, and renderer-started
  runs behind the same dispatch facade.
- Treat `requestAgenticServiceApproval` plus `ApprovalService.resolve` as the
  single approval choke point.
- Preserve external-path grant ordering and read-only/non-grantable denials.

Suggested gates:

- run dispatch focused tests
- scheduled/headless dispatch tests
- approval timeout/resolution tests
- external grant tests
- sub-thread result propagation tests
- remote/iOS projection tests when touched

### Main M4 - Provider Runtime Split

Purpose: move provider launch flows one provider family at a time.

Order:

1. Shared CLI process host and stream/event utilities.
2. Lower-coupling provider runners.
3. Higher-risk provider runners with fail-open/fail-closed behavior: Cursor,
   Kimi, Codex, Grok, Gemini.
4. Cancellation/session cleanup and provider persistent seat/session ownership.

Guardrails:

- Provider-specific security decisions must remain explicit.
- Provider modules may not call approval directly.
- Provider modules may not bypass run normalization or dispatch facade.
- Every process/session acquisition has paired cleanup.

### Main M5 - Bootstrap, Window Lifecycle, Remote Bridge, And App Lifecycle

Purpose: make `index.ts` a readable Electron composition root.

Actions:

- Split main window, popouts, menu, permission helper, app activate/quit, and
  window registries behind bootstrap modules.
- Move service graph construction into named builders while keeping ordering
  visible.
- Extract remote bridge bootstrap and lifecycle after run dispatch and approval
  facades are stable.
- Leave pre-ready protocol registration and validation ordering easy to audit.

Suggested gates:

- `npm run typecheck:node`
- focused bootstrap/window tests where available
- manual smoke for main window, workspace popout, side-chat popout docking,
  macOS activate, remote bridge close/reopen, and permission helper windows

## Tier 2 Workspace-Wide Campaign

Start Tier 2 writes only when Tier 1 roots have active phase owners and the
target file has a fresh adjacent plan or slice brief. Recon can run in parallel
earlier, but writes need ownership.

Recommended order:

1. `SettingsPanel.tsx` - extract pure helpers first: user MCP parsing/export,
   TOML helpers, MCP catalog grouping, tab metadata, plugin helpers. Then split
   tabs into components and settings hooks.
2. `McpToolCatalog.ts` and `WorkspaceToolExecutors.ts` - split catalog by tool
   family and executors by command family while preserving facade exports.
3. `Sidebar.tsx` - split settings menu, footer popovers, search/filter helpers,
   workflow rows, linked-child labels, and inline icons.
4. `Composer.tsx` - after renderer R2/R3 produces typed view models, split
   welcome hero, provider/model/permission binding, attachments, plan import,
   send controls, and telemetry/footer.
5. `EnsembleOrchestrator.ts` and its test - extract pure helper clusters first:
   concurrent write scopes, proposed-plan parsing, tool activity normalization,
   participant catalog/model helpers, wakeup formatting. Split tests in the same
   conceptual order.
6. `src/main/store/index.ts` and `src/main/store/types.ts` - split domain
   normalizers/defaults and type groups: appearance/settings, chat/ensemble,
   workflows, audit/run events, provider/runtime, workspace boards.
7. `Inspector.tsx`, `TranscriptPanel.tsx`, and `ActivityStack.tsx` - split only
   where props, memo comparators, and focused tests are ready.

Tier 2 done does not require every file to be tiny. It requires no production
file above the soft cap to be unowned, unexplained, or lacking a split plan.

## Responsibility Map

Do not trust fixed line ranges in this document. Use these domain anchors and
refresh commands before each slice.

Renderer anchors:

- `function App()` - root state and refs.
- `updateChatById` / chat merge callbacks - single chat mutation owner.
- `window.api.removeListeners` - broad IPC cleanup that must be eliminated from
  extracted hooks.
- `shouldRenderWelcome` - focused welcome state source.
- `mainAppLayoutProps` - current layout prop assembly.
- `MainAppLayout` focused transcript/composer block - focused chat surface.
- `ComposerProps` - current composer pass-through seam.
- `chatViewPanePropsEqual` - multiview memo comparator that must track prop
  additions.

Main anchors:

- pre-ready protocol/validation setup
- late-bound refs and singleton registries
- `normalizeAgentRunPayload`, posture signing, external grant normalization,
  provider preflight
- `requestAgenticServiceApproval` and main approval request flow
- `previewForGeminiMcpTool` and shared MCP dispatcher
- provider runner functions and shared CLI process host
- `app.whenReady()` service graph and registrar block
- inline `ipcMain.handle/on` clusters

Recommended recon commands:

```sh
rg -n "function App|mainAppLayoutProps|removeListeners|shouldRenderWelcome|updateChatById" src/renderer/src/App.tsx
rg -n "ipcMain\.(handle|on)|app\.whenReady|requestAgenticServiceApproval|normalizeAgentRunPayload|executeGeminiMcpTool|previewForGeminiMcpTool" src/main/index.ts
rg -n "from ['\"].*(App|index)['\"]" src/renderer/src src/main
rg -n "export \*" src/renderer/src src/main
```

## Gate Tiers

### Slice Green

Required for every slice:

```sh
git diff --check -- <slice paths>
```

Plus the relevant side typecheck, focused tests, no root back-imports, and any
phase-specific invariant.

Renderer helper/hook slice:

```sh
npm run typecheck:web
npm test -- <focused renderer tests>
```

Main IPC slice:

```sh
npm run typecheck:node
npm test -- src/main/IpcValidation.test.ts
npm test -- src/main/ipc/<domain>Handlers.test.ts
```

Docs-only slice:

```sh
git diff --check -- docs/refactors/app-index-decomposition.md
```

### Batch Green

After every 3-5 implementation slices:

```sh
npm run typecheck
npm test
npm run guard:no-bundled-secrets
npm run smoke:node-pty
```

### Bundle Green

Run when imports, renderer host boundaries, preload/main wiring, or asset paths
move:

```sh
npm run build
```

### Release Green

Near merge/release, not per slice:

```sh
npm run ci
npm run test:swift:bridge
swift test --package-path ios/TaskWraithKit
```

Full lint is useful but advisory for this refactor unless the touched files are
lint-clean and the team intentionally gates on them.

## Risk Register

| Risk | Why it matters | Required mitigation |
| --- | --- | --- |
| Broad renderer listener cleanup | One extracted hook can remove sibling subscriptions | R0 scoped unsubscribe before event hooks |
| Split chat mutation ownership | Active streams, synthetic questions, and sub-thread updates can disappear | Single chat mutation facade before chat state extraction |
| Welcome/transcript/composer drift | The three surfaces share behavioral state | Shared view model and focused tests |
| View-host missing props | Typecheck can pass with `any` and crash at runtime | Hand-typed prop groups plus Electron smoke for runtime TSX |
| Memo comparator drift | Multiview panes can stale or re-render every streamed token | Comparator updates in same slice as prop additions |
| Electron boot-order drift | Some calls must occur before ready or before handler registration | Keep ordering visible and smoke boot/window behavior |
| Circular imports from roots | Late-bound refs can freeze `null` or create cycles | DI context/getters, grep gate for root imports |
| IPC validation blind spot | Scanner currently assumes flat handler modules | Keep handlers direct under `src/main/ipc/` or update scanner |
| Approval policy bypass | Providers/tools can skip deny/read-only/non-grantable gates | Single approval choke point and classifier tests |
| Run dispatch bypass | Scheduled/headless/remote/sub-thread paths depend on shared bookkeeping | Dispatch facade; no direct provider adapter calls |
| MCP policy collapse | Tool safety is multi-axis, not read/write only | Route coverage and classifier invariants |
| Pile movement | A new monolith replaces the old one | Soft cap on extracted modules and split plan before landing |

## Done Criteria

Tier 1 is done when:

- `App.tsx` and `src/main/index.ts` are readable composition roots near the
  soft cap, with any residual complexity named and justified.
- No extracted module imports back from `App.tsx` or `index.ts`.
- No new production module created by the campaign is above the soft cap without
  an explicit split plan.
- Renderer event ingestion has scoped unsubscribe ownership.
- Chat mutation has a single facade.
- Main run dispatch, approval, MCP, provider runtime, and bootstrap paths have
  named facades or service owners.
- IPC validation covers every handler file.
- Relevant typechecks and focused tests are green, and batch gates have run
  recently.
- The owned worktree paths are clean after the final commit.

Workspace-wide hygiene is done when:

- Every production TS/TSX file above the soft cap has either been split or has a
  documented owner, reason, and next split checkpoint.
- Large test files that mirror split services have been split or given a
  matching test-organization plan.
- The module graph is understandable without reading a root file end to end.
- Future feature work has obvious homes that are not `App.tsx` or `index.ts`.

Do not stop merely because the first visible iceberg is smaller. Stop when the
workspace no longer depends on monolithic roots for ordinary feature ownership.
