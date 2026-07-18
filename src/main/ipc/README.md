# `src/main/ipc/` — domain IPC handler modules

This directory holds the domain slices already extracted from
`src/main/index.ts`. Extraction is well under way, but it is not complete: the
main-process entry point still owns high-coupling registration and runtime
orchestration.

## Current snapshot

Measured from the source tree on 2026-07-18:

- `src/main/index.ts` is 39,095 lines.
- This directory contains 49 non-test `*Handlers.ts` modules, each with one
  exported `register*Handlers` registrar.
- All 49 modules have a matching `*Handlers.test.ts` file.
- The extracted modules contain 298 direct `ipcMain.handle` / `ipcMain.on` call
  sites. Another 58 remain in `index.ts` (54 `handle`, four `on`). These are raw
  registration call sites, not a promise about the number of unique or
  dynamically registered channels.

The extracted inventory is:

| Area | Handler modules (suffix omitted) |
| --- | --- |
| Shell, settings, and app state | `appearance`, `diagnostics`, `settings`, `update`, `shell`, `launch`, `localServers`, `sidebar`, `plugin` |
| Workspaces, projects, and files | `project`, `workspace`, `workspaceActivity`, `workspaceChangeLedger`, `workspaceDiffSnapshot`, `workspaceFileEditor`, `workspaceGeminiDiscovery`, `fileIcon`, `git`, `externalPathGrant` |
| Chats, queues, and orchestration | `chat`, `composeRun`, `runQueue`, `scheduledWorkflow`, `checkpoint`, `contextCompaction`, `agentQuestion`, `humanCollaboration`, `ensembleRosterPresets`, `introspection`, `audit` |
| Trust and approvals | `trust`, `approvalLedger`, `approvalResponse`, `agenticWorkspaceGrant` |
| Providers, authentication, and usage | `claudeAuth`, `kimiAuth`, `geminiAuth`, `codexThread`, `providerMetadata`, `providerTerminal`, `usageRates` |
| Bridge, terminal, and media surfaces | `bridgeAllowlist`, `bridgeRemote`, `apns`, `pty`, `mediaAsset`, `imageGeneration`, `spellcheck`, `discordContext` |

The inline registrations that remain are concentrated around agent and ensemble
run dispatch, retired-Gemini compatibility sessions, iOS pairing and attached
window/AppWatch state, composer attachments and audio, provider status/usage,
pop-out/app lifecycle actions, and a small number of renderer event listeners.
Those paths share substantial main-process state, so the remaining work should
be described as decomposition in progress rather than as a finished migration.

## Extraction pattern

1. Put one cohesive domain in `<domain>Handlers.ts` and export a single
   `register<Domain>Handlers(deps)` function. Preserve channel behavior while
   moving it.
2. Inject collaborators through a typed `deps` object. A handler module may
   import Electron, Node, shared types, and domain utilities directly, but must
   not import back from `index.ts`. Domain-local state can move with the
   handlers when nothing outside the slice owns it.
3. Keep the shared, patched `ipcMain` singleton. `index.ts` calls
   `installIpcValidation(ipcMain)` before handler registration, so a module that
   imports `ipcMain` from `electron` still passes every invocation through
   `validateIpcArgs`.
4. Keep every handled channel in `IPC_ARGUMENT_SCHEMAS` in
   `src/main/IpcValidation.ts`. The static invariant test scans `index.ts`, all
   non-test TypeScript files directly under this directory, and the separate
   Canvas IPC module. If handler modules are ever nested, extend that scan in
   the same change.
5. Add or update the matching `*Handlers.test.ts` file. Run the focused handler
   test and `src/main/IpcValidation.test.ts`; use `npm run typecheck` and the
   full test suite for the completed slice when practical.
6. Land one domain at a time. `index.ts` is frequently edited by concurrent
   work, so keep dependency wiring explicit and avoid unrelated formatting.

## Recomputing the snapshot

The counts above are maintenance context, not a release invariant. Recompute
them before making future numerical claims:

```sh
wc -l src/main/index.ts
rg --files src/main/ipc | rg 'Handlers\.ts$' | rg -v '\.test\.ts$' | wc -l
rg --files src/main/ipc | rg 'Handlers\.test\.ts$' | wc -l
rg -o 'ipcMain\.(handle|on)\(' src/main/index.ts | wc -l
rg -o 'ipcMain\.(handle|on)\(' src/main/ipc -g '*Handlers.ts' -g '!*test*' | wc -l
```
