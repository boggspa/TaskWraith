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
  remote projections, APNs token routing, and paired-device action validation.

## Renderer Process (`src/renderer/`)

Responsible for the UI:

- React components (standard CSS, with specialized components like `ActivityStack` and `DiffViewer`).
- **Terminal UI**: Uses `xterm.js` for the embedded Trust Assistant terminal.
- Communicates exclusively via `window.electron` IPC APIs defined in preload.
- Stream parsing adapters normalize provider events into shared activity, diff, usage, and approval records.

## Data Flow (Provider Runtime)

1. User clicks "Run" -> Renderer sends a provider run request with the prompt.
2. Main process verifies workspace safety, resolves the effective provider
   (including paused-provider failover and retired-provider fallback), applies
   active goal context, and starts the selected provider command, SDK,
   app-server, or Ollama harness. Live selectable providers are Codex, Claude,
   Kimi, Grok, Cursor, and local Ollama; Gemini is retained for historical
   chats and decode paths only. Kimi Code runs over its `kimi acp` (Agent Client
   Protocol) transport inside a per-run sandboxed `KIMI_CODE_HOME`, behind the
   default-OFF `TASKWRAITH_KIMI_ACP` flag — see
   [`docs/kimi-code-acp-migration.md`](docs/kimi-code-acp-migration.md).
3. Main process reads provider events and tool calls using the provider adapter.
4. Sensitive actions route through TaskWraith policy, approval ledgers, and
   workspace confinement before execution.
5. Main process sends normalized events via IPC to Renderer.
6. Renderer updates transcript, activity, diff, usage, goal, and audit state.

## Agent Orchestration

- **Single-provider chats** run one provider against one workspace or global
  context.
- **Ensembles** share one transcript across multiple provider participants.
- **Sub-threads** create isolated child chats for delegated work.
- **Audit runs** coordinate provider-backed review passes with structured phases,
  findings, verdicts, and synthesis.
- **Workflows** are first-class chat/run definitions with scheduling,
  restart recovery, read-only iOS projection, and optional ensemble execution
  where enabled.
- **Thread goals** store a persistent objective and stopping condition separate
  from `todo_write`; Codex can mirror native goal state when the installed
  app-server exposes it, while other providers use TaskWraith-managed goal
  steering and lifecycle tools.

Ensemble rounds are coordinated by `EnsembleOrchestrator` in the main process.
The orchestrator dispatches one participant at a time, supports explicit
`ensemble_yield` handoffs and `@mention` auto-promotion, and terminates when the
rotation queue is exhausted. A shared liveness guard (`ensembleRoundLifecycle`)
prevents stale round records from keeping the composer busy after the actual
work has finished. Transcript mention chips resolve through the same alias-aware
shared tokenizer used for routing, so displayed labels match the participant
role or model alias the user typed.

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
- Renderer: `PromptCacheSettingsSection` in Settings → Providers; helpers in
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
  surface with a **Threads | Projects** tab strip. **Threads** keeps the
  existing grouped layout (workspaces, recents, ensembles, pinned, and related
  sections). **Projects** renders `ProjectsSidebarView.tsx`, wired to
  `projectsStore.ts` for user-defined hierarchies, membership, and reorder.
  Project icon + hue editing reuses the shared `IdentityIconPicker.tsx`
  extracted from Agent Pool customization (`AgentPoolContainer.tsx`). Chat
  rows can be dropped onto projects via the sidebar chat drag MIME type.
  Search query state is isolated per tab; the active tab and project expand
  state persist in renderer `localStorage`.
- **Transcript / Multiview** (`src/renderer/src/components/` via `App.tsx`):
  one or more live panes with message bubbles, floating composer, per-pane run
  routing, and status chips.
- **Inspector** (`src/renderer/src/components/Inspector.tsx`): right-side panel with tabs for Diff Studio, Raw Events, and Safety.

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
- **Sidebar Projects** (`projectsStore.ts`, key `taskwraith-sidebar-projects`)
  persist in renderer `localStorage` and are **profile-global** (not
  workspace-scoped) so a project can reference chats from any workspace.
  Membership is stored as chat id lists on each project record. When a chat is
  deleted (`App.tsx` → `removeChatFromAllProjects`), its id is stripped from
  every project; archived chats are **not** pruned from membership so unarchive
  can restore visibility without re-adding the chat manually.
- Paired-device records, remote bridge settings, APNs token routing data, and
  first-launch/readiness projections are local to the Mac unless explicitly
  transported over the paired E2EE bridge.
- Secrets and release credentials must use the OS keychain or external CI secret store, not source files.
