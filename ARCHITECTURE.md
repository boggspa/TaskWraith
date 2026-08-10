# Architecture

**Core Stack**: Electron + React + TypeScript.

## Main Process (`src/main/`)

Responsible for system-level operations:

- Displaying native directory pickers.
- Spawning supported provider CLI subprocesses.
- **Trust Management**: Provider-specific trust/status services inspect official local configuration where supported.
- **Integrated Terminal**: Uses `node-pty` to provide interactive setup and trust flows where a provider requires them.
- Executing `git diff` on the selected workspace.
- Enforcing safety rules (denylists, workspace confinement).
- Maintaining local run state, approval/audit ledgers, persistent thread goals,
  provider failover state, and model-usage summaries.
- Hosting the optional iOS remote bridge: E2EE pairing, workspace allowlists,
  remote projections, APNs token routing, paired-device action validation, and
  the strict non-sensitive Live Activity display-state allowlist.

## Renderer Process (`src/renderer/`)

Responsible for the UI:

- React components (standard CSS, with specialized components like `ActivityStack` and `DiffViewer`).
- **Terminal UI**: Uses `xterm.js` for the embedded Trust Assistant terminal.
- Communicates exclusively via `window.api` IPC APIs defined in preload.
- Stream parsing adapters normalize provider events into shared activity, diff, usage, and approval records.

## Data Flow (Provider Runtime)

1. User clicks "Run" -> Renderer sends a provider run request with the prompt.
2. Main process verifies workspace safety, resolves the effective provider
   (including paused-provider failover and retired-provider fallback), applies
   active goal context, and starts the selected provider command, SDK,
   app-server, or Ollama harness. Architecturally supported selectable provider
   ids are Codex, Claude, AntiGravity, Kimi, Cursor, Grok, Pi, Mistral Vibe,
   and local Ollama, but a run still requires provider-specific admission. The older standalone
   Gemini provider id is retained for historical chats/configuration and decode
   paths only; AntiGravity is the live Gemini API/CLI integration. Managed
   Cursor uses Path-B: the shared CLI transport always-enables `cursor-agent`
   with hard-pinned `--sandbox enabled` argv (read-only vs write by seat) and
   registers a TaskWraith-owned MCP broker before enabling headless gateway
   calls. Brokered calls use host policy and grants; native Cursor actions
   remain provider-owned. Kimi
   Code, when admitted, runs over its `kimi acp` (Agent Client Protocol)
   transport inside a seat-isolated `KIMI_CODE_HOME`. Chats,
   delegated sub-threads, and ensemble participants use durable seat homes and
   native ACP session resume; legacy probes may still use a per-run home. ACP
   is the only managed Kimi transport. `TASKWRAITH_KIMI_ACP` only decides
   whether ACP may be considered; setting it to `0` makes Kimi unavailable and
   never opens a Wire/print fallback. The embedded reviewed runtime roster is
   currently empty, so managed Kimi admission runs in the explicitly labelled,
   non-release-qualifying `unattested-development` mode in every build
   (packaged included), gated by structural identity/probe/posture checks
   rather than an exact reviewed tuple. See
   [`docs/kimi-code-acp-migration.md`](docs/kimi-code-acp-migration.md).
3. Main process reads provider events and tool calls using the provider adapter.
4. Every admitted provider turn crosses the shared signed-posture normalizer
   and host lifecycle inventory. Stronger layers such as per-tool mediation,
   binary provenance, and scheduled launch seals are reported independently;
   missing one does not alter provider selectability.
5. Sensitive actions that cross a TaskWraith tool boundary route through
   TaskWraith policy, approval ledgers, and workspace confinement before
   execution. Provider-native actions remain bounded by the provider-specific
   launch contract described above.
6. Main process sends normalized events via IPC to Renderer.
7. Renderer updates transcript, activity, diff, usage, goal, and audit state.

## Agent Orchestration

- **Single-provider chats** run one provider against one workspace or global
  context.
- **Ensembles** share one transcript across multiple provider participants.
- **Sub-threads** create isolated child chats for delegated work.
- **Audit runs** coordinate provider-backed review passes with structured phases,
  findings, verdicts, and synthesis.
- **Workflows** are first-class chat/run definitions with scheduling,
  restart recovery, iOS projection plus authorized pause/resume/run-now
  controls, and optional ensemble execution where enabled. Workflow deletion
  remains desktop-only.
- **Thread goals** store a persistent objective and stopping condition separate
  from `todo_write`; Codex can mirror native goal state when the installed
  app-server exposes it, while other providers use TaskWraith-managed goal
  steering and lifecycle tools.

Ensemble rounds are coordinated by `EnsembleOrchestrator` in the main process.
The orchestrator dispatches one participant at a time, supports explicit
`ensemble_yield` handoffs and uniquely resolved `@mention` auto-promotion, and
terminates when the rotation queue is exhausted. Ambiguous in-round aliases
emit a warning and make no promotion. A shared liveness guard
(`ensembleRoundLifecycle`) prevents stale round records from keeping the
composer busy after the actual work has finished. Plain mention highlighting
and routing share the alias-aware tokenizer, but the renderer is not a dispatch
authority. In the source-ahead
checkout, the desktop picker writes a structured participant-id link and main
re-resolves every desktop/remote direct prompt against the canonical roster;
ambiguous plain aliases and stale structured ids fail before launch. This
main-authoritative routing hardening is newer than the v1.9.4 release baseline.

## Evidence Packs and Capability Ledger

Evidence Packs are the per-run truth layer for task completion. A pack records
the capability keys a run claims to affect, the evidence refs that support each
capability cell, completion claims, unsupported claims, touched files, and any
repo-convention observations gathered during the run.

Agents emit packs through the `evidence_pack_write` MCP tool. The tool stamps
workspace, chat, run, and provider context from the active run, accepts ergonomic
aliases such as `cells`, `claims`, and `changedFiles`, persists the pack, and
returns a ledger summary. `completion_claim_check` uses the same model rules to
check planned final-answer language before the agent claims work is done.

`scope_radar` is the pre-work normalizer for vague or high-load prompts. It
turns messy intent into a desired capability, inferred capability map,
prerequisite/known/unknown/speculative slice kinds, evidence requirements,
allowed surfaces, non-goals, open questions, and a slop budget. By default it
records that map as an Evidence Pack for the active run so the ledger has
pre-implementation scope before later packs add implementation evidence.

`prompt_task_normalize` is the read-only task-contract projection used before an
agent starts work. It reuses Scope Radar, folds in the latest Repo Convention
Index when present, infers the work mode, selects a first slice, and returns the
current state, desired capability, non-goals, acceptance criteria, evidence
requirements, allowed repo surfaces, questions, and slop budget. This is the
Olly-oriented path: vague intent becomes a bounded task contract before any
agent is asked to implement.

The Capability Ledger is not a separate source of truth. It is the longitudinal
projection of accumulated Evidence Packs for a workspace, using the latest
cell status per capability plus merged evidence refs and completion-claim
counts. This keeps progress tracking falsifiable: a "done" claim without a
supporting evidence-backed cell increases the unsupported-completion-claim
rate, which is the v1 accountability metric.

Scope maps and capability cells deliberately use separate provenance:

- **Map provenance** tracks whether the decomposition itself is inferred,
  user-confirmed, revised after implementation, or deprecated.
- **Cell provenance** tracks evidence-backed capability status: verified,
  partial, blocked, unsupported, or unverified.

Stall detection is deterministic-first. The first-pass signals are derived from
existing artifacts: repeated packs that touch files without changing the ledger,
or repeated partial cells without new evidence. LLM judgement should only be an
escalation layer for classifying whether the observed diff is churn.

Repo-convention indexes are workspace snapshots beside Evidence Packs. They
index architecture rules, file-ownership patterns, UI/design-system conventions,
test conventions, and workflow expectations, with evidence refs and freshness
timestamps. They can be built from scans, curated corrections, and conventions
observed in Evidence Packs; stale entries are refreshed or deprecated as agents
mutate the repo.

`repo_convention_scan` is the deterministic scanner for that index. It walks a
bounded active-workspace file inventory, detects package/tooling files,
component families, Electron process boundaries, test surfaces, style-system
assets, generated/dependency paths, and do-not-repeat rules, then persists the
snapshot by default. Coherence Gate uses this as the repo facts layer before it
decides whether a diff introduced duplicate abstractions or slop bloat.

`coherence_gate_check` is the deterministic pre/post-diff guard. It accepts
touched files, new files, placeholder files, validation evidence, optional Scope
Radar context, and the latest Repo Convention Index, then flags generated-path
edits, placeholder-only work, slop-budget overages, broad styling drift,
duplicate-abstraction risk, scope-surface mismatch, and missing validation
evidence. The gate records no workspace mutations; agents can call it from
read-only planning or review seats before making completion claims.

## Provider orchestration (caching, forks, worktrees)

User-facing behavior and guarantee language: `SESSION_AND_WORKSPACE.md`.

### Prompt cache policy

- **`PromptCachePolicySettings`** (settings + IPC `prompt-cache:get-policy` /
  `prompt-cache:save-policy`) stores global enablement and per-provider modes
  (`off` | `auto` | `explicit`).
- **`ProviderCacheCapabilitySummary`** (IPC `prompt-cache:get-capabilities`)
  exposes transport, `guaranteeTier` (`guaranteed` | `automatic-observed` |
  `best-effort` | `unsupported`), and whether TaskWraith can control caching on
  that path.
- Provider run paths apply cache controls only on **controllable** API/BYOK
  transports. CLI/subscription paths remain best-effort: usage is recorded when
  providers emit cache token fields (`cache_read_input_tokens`,
  `cache_creation_input_tokens`).
- Renderer: `PromptCacheSettingsSection` in Settings → AI & Providers →
  Providers; helpers in
  `promptCacheUi.ts`. Diagnostics via `prompt-cache:get-diagnostics`.

### Universal fork service

- **Native fork:** Codex `thread/fork` via `fork-agent-thread` IPC (existing
  handler extended with capability metadata).
- **Emulated fork:** sibling chat duplication with `ForkCapabilityKind`:
  `native` | `emulated` | `unsupported` (IPC `fork:get-capability` when
  available; static fallback in `universalFork.ts`).
- Renderer: `/fork` slash command and inspector actions call
  `forkAgentThreadUniversal()` and label **Fork (native)** vs **Fork (emulated)**.

### Git branch / worktree IPC

- Git IPC channels (via preload): `git:list-branches`, `git:checkout-branch`,
  `git:create-branch`, `git:list-worktrees`, `git:create-worktree`,
  `git:remove-worktree`, `git:select-worktree`.
- **`RuntimeProfile.workspaceMode: 'worktree'`** resolves to an effective checkout
  path and worktree metadata at run launch instead of being stored-only.
- Renderer: `ComposerBranchWorktreePopover` on the composer above-row branch
  control; helpers in `gitBranchWorktreeUi.ts`. Dirty-tree guards use
  `GitRepositorySnapshot` counts before checkout/branch/worktree mutations.

## Visual Architecture

### Appearance System

- **Theme tokens**: CSS custom properties in `src/renderer/src/styles/theme.css` define colors, spacing, typography, and surfaces.
- **Appearance modes**:
  - `solid` — fully opaque surfaces for maximum readability.
  - `soft_glass` — CSS `backdrop-filter` blur on sidebar and inspector panels.
  - `native_glass` — macOS `BrowserWindow` vibrancy (`sidebar`) + transparent background. Falls back to CSS soft glass on unsupported platforms.
- **Accessibility**: `prefers-reduced-motion`, `prefers-contrast`, and app-level `reduceTransparency` / `reduceMotion` settings are respected.
- **Settings storage**: Appearance settings live in `AppSettings` and persist to the OS user data directory.

### Layout

- **Header**: draggable chrome area with workspace/chat title and run status indicator.
- **Sidebar** (`src/renderer/src/components/Sidebar.tsx`): glass navigation
  surface with **Chat | Code | Work** primary modes. **Chat** contains general
  chats, **Code** contains workspace-scoped threads and workspace tooling, and
  **Work** renders `ProjectsSidebarView.tsx` for user-defined hierarchies,
  membership, and reorder. Project icon + hue editing reuses the shared
  `IdentityIconPicker.tsx` extracted from Agent Pool customization
  (`AgentPoolContainer.tsx`). Chat rows can be dropped onto projects via the
  sidebar chat drag MIME type. Search query state is isolated per mode; active
  mode, section collapse, and project expansion preferences remain renderer UI
  state in `localStorage`.
- **Transcript / Multiview** (`src/renderer/src/components/` via `App.tsx`):
  one or more live panes with message bubbles, floating composer, per-pane run
  routing, and status chips.
- **Right dock**: a resizable contextual panel with Home, Run, Chat, Media,
  Notes, Files, Inspect, and an optional workspace terminal surface. Its
  selected destination is stored in renderer `sessionStorage`: Chat/Code key by
  chat, while Work keys by project when the focused chat belongs to exactly one
  project and otherwise falls back to the chat key. Visibility remains
  ephemeral and a relaunch clears this memory.
- **Inspector** (`src/renderer/src/components/Inspector.tsx`): the right dock's
  Inspect surface for diffs, raw events, delegation, timeline, and safety.

### Components

- **ActivityStack** (`src/renderer/src/components/ActivityStack.tsx`): compact timeline rows for tool calls with status icons, labels, file paths, durations, and expandable raw events.
- **DiffViewer** (`src/renderer/src/components/DiffViewer.tsx`): Diff Studio with selectable file list, status badges, and unified diff detail view with syntax-highlighted additions/deletions.
- **SettingsPanel** (`src/renderer/src/components/SettingsPanel.tsx`): modal for appearance, providers, approvals, MCP/tools, workspaces, usage, devices, key commands, and local servers.
- **FirstLaunchSheet** (`src/renderer/src/components/FirstLaunchSheet.tsx`):
  provider setup, workspace, appearance, goals, and ensemble onboarding.

## Storage

- App settings are saved to the OS user data directory.
- Chats, run events, approval records, audit run state, usage summaries, and
  active goals are stored locally.
- **Projects registry** is a profile-global, main-owned
  `userData/projects.json` authority. The renderer's synchronous
  `projectsStore.ts` facade applies shared pure project operations optimistically,
  dispatches them through snapshot/apply/import IPC, and reconciles from invoke
  results plus the `projects-changed` broadcast. A one-shot import moves legacy
  `taskwraith-sidebar-projects` records out of `localStorage`; sidebar mode,
  section-collapse, and project-expansion preferences remain there as
  persistent UI state, while per-mode search queries are renderer-session
  state.
  Main-owned `ProjectWorkProfile` companion records keep durable Work-surface
  semantics separate from the V1 project shape; their atomic home-chat claim
  also adds project membership and enforces at most one project home per chat.
  The Work view exposes this boundary through Set/Clear Project Home actions,
  a Home badge, and an Open Project Home shortcut. For an unhomed project,
  **Start Project Home** creates an ordinary pristine General draft and records
  only an ephemeral renderer pending claim; the main-authoritative claim fires
  on the first committed message or run. Abandoned drafts gain no durable flag
  and remain eligible for the normal pristine-draft reuse/reaper behavior.
  Claims are intentionally main-authoritative rather than optimistic renderer
  mutations.
  Main-owned `ProjectReference` records add project-scoped file, folder, and URL
  catalogue metadata plus explicit context-policy and last-known verification
  fields. Main-renderer-only reference-op, verify, and path-picker IPC feed the
  renderer facade without an optimistic twin. Choosing a file/folder catalogues
  metadata but grants nothing; explicit verification performs a single
  main-side existence stat, rejects URL verification, and never reads content.
  The registry cascades references when a project is deleted, but it never
  fetches, indexes, or injects a reference and never turns one into an
  external-path grant; agent access still requires the existing per-chat/per-run
  authority flow. Selecting a project in Work exposes the reference library in
  its detail panel: users can add file, folder, or link records; verify the
  last-known existence of files/folders; toggle a record between Available and
  Off; or remove it. Those controls mutate catalogue metadata only.
  Projects are not workspace-scoped, so one project may reference chats from
  multiple workspaces. Archived chats remain members; deleting a chat removes
  its id from project membership.
- Paired-device records, remote bridge settings, APNs token routing data, and
  first-launch/readiness projections are local to the Mac unless explicitly
  transported over the paired E2EE bridge.
- Secrets and release credentials must use the OS keychain or external CI secret store, not source files.
