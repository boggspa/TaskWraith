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
   chats and decode paths only.
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
