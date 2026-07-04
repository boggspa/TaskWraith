# `src/main/ipc/` — extracted IPC handler modules

This directory exists to break up the ~24.5k-line main-process god-module
`src/main/index.ts`, which registers roughly 260 `ipcMain.handle` channels across many
unrelated domains. Handlers are moved out **one cohesive domain at a time, with
no behavior change**.

## The pattern (follow it for every slice)

1. **One module per domain**, named `<domain>Handlers.ts`, exporting a single
   `register<Domain>Handlers(deps)` function that performs the `ipcMain.handle(…)`
   calls for that domain — lifted **verbatim** from the `app.whenReady()` block.
2. **Dependency injection, not back-imports.** The handlers in `index.ts` close
   over a large local scope (services, broadcast helpers, `requireRegisteredWorkspace`,
   `requestAgenticServiceApproval`, …). Pass those collaborators in via a typed
   `deps` object. The module imports **external** deps directly (`electron`,
   `node-pty`, `os`, shared sanitizers/types under `../`), but never imports back
   into `index.ts` — that avoids an import cycle. Domain-local state (e.g. PTY's
   `ptyProcesses` map) moves *into* the module when no other handler touches it.
3. **`ipcMain` stays the patched singleton.** `index.ts` calls
   `installIpcValidation(ipcMain)` once, early, before any registration. Because
   that monkey-patches the shared Electron `ipcMain.handle`, modules here that
   `import { ipcMain } from 'electron'` get the validated `handle` automatically —
   every channel still flows through `validateIpcArgs`. **Do not** re-import or
   re-wrap; just call `registerXxxHandlers(...)` after `installIpcValidation`.
4. **Keep the static invariant green.** Every channel must have an arg schema in
   `IPC_ARGUMENT_SCHEMAS` (`src/main/IpcValidation.ts`). The static test
   `src/main/IpcValidation.test.ts` scans `index.ts` **and every `*.ts`
   (non-test) file directly under `src/main/ipc/`**. So:
   - Put handler modules **directly under `src/main/ipc/`** (the scan is not
     recursive). If you nest subfolders, extend the scan in the test.
   - Never delete a channel's schema entry when you move its handler.
5. **Verify each slice:** `npm run typecheck` and `npm test` (the
   `IpcValidation.test.ts` suite is the fast invariant gate).
6. Land slices independently; other sessions edit `index.ts` concurrently, so use
   exact-string edits and stage by explicit path.

## Done

| Module | Channels |
| --- | --- |
| `ptyHandlers.ts` | `start-pty`, `stop-pty`, `pty-write`, `pty-resize` (owns `ptyProcesses`/`stoppedPtySessions`; injects `requireRegisteredWorkspace`, `requestAgenticServiceApproval`) |
| `shellHandlers.ts` | `shell:open-link`, `shell:reveal-in-finder`, `favicon:getForUrl` (stateless; injects `openSafeShellTarget`, `revealPathInFinder`, `getFaviconService`) |
| `launchHandlers.ts` | launch-target discovery and launch/open helpers extracted from the startup/target domain |
| `auditHandlers.ts` | audit-run lifecycle and audit-result handlers |
| `ensembleRosterPresetsHandlers.ts` | ensemble roster preset CRUD/import/export handlers |

## Proposed module map for the rest

Ordered roughly easiest/lowest-coupling first. Channel names are indicative; confirm
membership against `IPC_ARGUMENT_SCHEMAS` at extraction time.

| Proposed module | Domain | Channels (indicative) |
| --- | --- | --- |
| `trustHandlers.ts` | Workspace trust + session YOLO | `check-trust`, `trust-workspace`, `agentic-yolo-get`, `agentic-yolo-set` |
| `localServersHandlers.ts` | Dev-server detection | `local-servers-snapshot`/`-refresh`/`-stop`/`-stop-all` |
| `updateHandlers.ts` | Auto-update + changelog | `update-snapshot`, `check-for-updates`, `download-update`, `install-update-on-quit`, `install-update-now`, `changelog-snapshot`, `mark-changelog-seen` |
| `checkpointHandlers.ts` | Session checkpoints | `session-checkpoints:latest`/`:accept`/`:dismiss` |
| `apnsHandlers.ts` | APNs push config | `get-apns-config`, `select-apns-key-file`, `set-apns-config`, `clear-apns-config`, `test-apns-push` |
| `diagnosticsHandlers.ts` | Product ops / crashes / bug report / host info | `get-product-operations-status`, `get-product-crashes`, `record-product-crash`, `export-product-diagnostics`, `repair-product-install`, `app-shell-stats:snapshot`, `get-app-version`, `submit-bug-report`, `get-host-weather`, `native-capabilities:snapshot` |
| `usageRatesHandlers.ts` | Usage + FX/provider rates | `record-usage`, `get-usage`, `get-external-usage`, `fx-rates:get`/`:refresh`, `providerRates:get`/`:probe`, `grok-usage:probe` |
| `externalPathHandlers.ts` | External-path grants | `select-external-path-grant`, `external-path:pick-and-persist`, `probe-external-path` |
| `workspaceFileHandlers.ts` | Workspace file IO | `list-workspace-files`, `read-workspace-file`, `write-workspace-file`, `discover-gemini-commands`, `discover-gemini-memory`, `get-file-icon` |
| `workspaceHandlers.ts` | Workspace registry + diffs/snapshots | `get-workspaces`, `add-or-update-workspace`, `remove-workspace`, `clear-workspaces`, `select-workspace`, `upsert-/remove-agentic-workspace-grant`, `get-workspace-activity`, `get-diff`, `capture-snapshot`, `compute-run-diff`, `get-workspace-change-sets` |
| `chatHandlers.ts` | Chat CRUD + sub/side chats | `get-chats`, `get-chat-list`, `get-pinned-messages`, `get-chat`, `create-chat`, `create-global-chat`, `save-chat`, `delete-chat`, `clear-chats`, `truncate-chat`, `create-sub-thread`, `get-sub-threads`, `create-side-chat`, `get-side-chats` |
| `scheduleWorkflowHandlers.ts` | Scheduled tasks + workflow defs | `get-/save-/update-/delete-scheduled-task`, `get-/save-/update-/delete-workflow-definition`, `run-workflow-now` |
| `runQueueHandlers.ts` | Run queue + run events | `get-run-queue-jobs`, `get-run-recovery-records`, `request-/lease-/transition-run-queue-job`, `get-run-events`, `get-run-event-replay`, `run-analyst:analyze` |
| `settingsHandlers.ts` | Settings + toggles | `get-settings`, `update-settings`, `set-appearance-mode`, `set-bridge-daemon-enabled`, runtime-profiles + handoff-cards CRUD |
| `ensembleHandlers.ts` | Ensemble orchestration | `create-ensemble-chat`, `run-/cancel-ensemble-round`, `skip-ensemble-participant`, `wake-/cancel-ensemble-participant-wakeup` |
| `providerAuthHandlers.ts` | Provider auth + API keys + login terminals | claude/kimi/gemini auth-status, store/clear API keys, gemini OAuth profiles/login, codex usage credential, `provider:open-login/logout/upgrade-terminal`, `provider:open-kimi-upgrade-terminal` |
| `bridgeHandlers.ts` | iOS remote bridge / Tailscale / pairing / attach-window / sticky-appwatch | `bridge-networking-status`, `bridge-allowlist-*`, `bridge-*-pairing`, `bridge-list-paired-devices`, `bridge-unpair-device`, `get-/set-ios-remote-config`, `ios-remote-tailscale-*`, `attach-window:*`, `sticky-appwatch:*` |
| `discordContextHandlers.ts` | Read-only Discord composer context | `discord-context:*` |
| `agentRunHandlers.ts` (last; highest coupling) | Agent run + provider dispatch | `run-agent`, `compose-run`, `cancel-agent-run`, `respond-agent-approval`, `get-agent-status`/`-rate-limits`/`-mcp-status`/`-models`, `get-provider-capabilities`/`-adapters`, agent-thread fork/rollback/review, `answer-/cancel-agent-question`, approvals (`get-approval-ledger`, `record-approval-elevation-ack`) |
| `geminiSessionHandlers.ts` (last; highest coupling) | Gemini PTY/session + MCP bridge | `run-gemini`, `cancel-gemini`, `write-gemini-input`, `start-/stop-/write-/resize-gemini-session`, `list-gemini-sessions`, `get-gemini-version`/`-capabilities`, `*-gemini-mcp-bridge*` |

`agentRunHandlers` and `geminiSessionHandlers` are deliberately last: they close
over the most main-process state (run manager, provider adapters, live child
processes, MCP broker) and should be extracted only after the cheaper slices have
proven the DI seams.
