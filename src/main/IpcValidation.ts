import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { assertSafeChatId } from './ChatPath'

type ArgSpec =
  | 'any'
  | 'string'
  | 'nonEmptyString'
  | 'antigravityGeminiApiKey'
  | 'piUpstreamId'
  | 'piApiKey'
  | 'optionalString'
  | 'number'
  | 'positiveInteger'
  | 'optionalNumber'
  | 'boolean'
  | 'optionalBoolean'
  | 'object'
  | 'optionalObject'
  | 'array'
  | 'optionalArray'
  | 'provider'
  | 'optionalProvider'
  | 'approvalAction'
  | 'settingsPatch'
  | 'chatRecord'
  | 'runPayload'
  | 'workspacePath'
  | 'workspacePathOrObject'
  | 'filePath'
  | 'runId'
  | 'chatId'
  | 'externalPathGrantAccess'
  | 'runQueueStatus'
  | 'bugReportPayload'
  | 'optionalCanvasOpenArgs'
  | 'optionalCanvasSketchArgs'
  | 'canvasBounds'
  | 'stickyAppWatchStash'

// Pi BYOK upstream ids accepted over IPC; must mirror PI_ALLOWED_UPSTREAMS in
// src/main/pi/PiModelPolicy.ts (this module stays import-light by design).
const PI_UPSTREAMS = new Set([
  'deepseek',
  'zai',
  'qwen-token-plan',
  'minimax',
  'mistral',
  'groq',
  'cerebras'
])
// Structural IPC/decode allowlist only. Live run/authority admission is enforced
// downstream by the canonical selectable-provider contract.
const PROVIDERS = new Set([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
])
const APPROVAL_ACTIONS = new Set([
  'accept',
  'acceptForSession',
  'acceptForWorkspace',
  'decline',
  'cancel',
  'useProviderNative',
  'useTaskWraithSubthread',
  // Slice 4 of the external-path-redesign arc — see
  // AgentApprovalAction in store/types.ts.
  'grantExternalPathRead',
  'grantExternalPathEdit',
  'declineExternalPath'
])
const RUN_QUEUE_STATUSES = new Set([
  'queued',
  'starting',
  'active',
  'paused',
  'cancelling',
  'cancelled',
  'failed',
  'completed'
])
const BUG_REPORT_SEVERITIES = new Set(['info', 'minor', 'major', 'blocking'])

export const IPC_ARGUMENT_SCHEMAS: Record<string, ArgSpec[]> = {
  'get-settings': [],
  'update-settings': ['settingsPatch'],
  'upsert-agentic-workspace-grant': ['provider', 'workspacePath', 'string'],
  'remove-agentic-workspace-grant': ['provider', 'workspacePath', 'string'],
  'get-workspaces': [],
  'add-or-update-workspace': ['workspacePath', 'optionalObject'],
  'remove-workspace': ['string'],
  'clear-workspaces': [],
  'projects:snapshot': [],
  'projects:apply-op': ['object'],
  'projects:set-home-chat': ['nonEmptyString', 'optionalString'],
  'projects:update-work-profile': ['nonEmptyString', 'object'],
  'projects:reference-op': ['object'],
  'projects:graph-edge-op': ['object'],
  'projects:verify-reference': ['nonEmptyString'],
  'projects:pick-reference-path': ['nonEmptyString'],
  'projects:import-legacy': ['optionalString'],
  'projects:list-reference-proposals': ['nonEmptyString'],
  'projects:review-reference-proposal': ['object'],
  'get-chats': ['optionalString'],
  'get-chat-list': ['optionalString'],
  'get-pinned-messages': ['optionalString'],
  'get-chat': ['chatId'],
  'create-chat': ['string', 'workspacePath'],
  'create-global-chat': [],
  'create-ensemble-chat': ['optionalObject'],
  'post-blackboard-entry': ['object'],
  'delete-blackboard-entry': ['object'],
  'clear-blackboard-entries': ['object'],
  'run-ensemble-round': ['object'],
  'steer-queued-ensemble-prompt': ['object'],
  'remove-queued-ensemble-prompt': ['object'],
  'blackboard-queued-ensemble-prompt': ['object'],
  'request-ensemble-participant-seat-change': ['object'],
  'cancel-ensemble-round': ['chatId'],
  'skip-ensemble-participant': ['chatId'],
  'skip-ensemble-read-fanout': ['chatId'],
  'session-checkpoints:latest': ['chatId'],
  'session-checkpoints:accept': ['nonEmptyString'],
  'session-checkpoints:dismiss': ['nonEmptyString'],
  'compact-provider-context': ['object'],
  'create-sub-thread': ['object'],
  'get-sub-threads': ['chatId'],
  'create-side-chat': ['object'],
  'get-side-chats': ['chatId'],
  'set-chat-kind': ['object'],
  'rebind-chat-workspace': ['object'],
  'save-chat': ['chatRecord'],
  'set-chat-git-workflow': ['object'],
  'delete-chat': ['chatId'],
  // Human collaboration (shared chat: host + up to 2 human collaborators). These
  // MUST be registered — installIpcValidation throws "No IPC schema registered"
  // for any unregistered ipcMain.handle channel, so their absence bricks the whole
  // feature at runtime AND turns the invariant test (below) red. The object-shaped
  // channels carry collaborator-DERIVED payloads; their handlers do deep field
  // validation downstream (requireSafeChatId / requireBoundedText(8000) /
  // requireNonEmptyString), so the coarse 'object' spec here matches the existing
  // 'compose-run' / 'create-sub-thread' precedent and is the IPC-boundary shape gate.
  'human-collaboration:invite-health': ['nonEmptyString'],
  'human-collaboration:create-share': ['object'],
  'human-collaboration:copy-invite': ['object'],
  'human-collaboration:list-shares': ['optionalString'],
  'human-collaboration:connected-chat-ids': [],
  'human-collaboration:revoke-share': ['nonEmptyString'],
  'human-collaboration:revoke-participant': ['object'],
  'human-collaboration:consume-invite': ['object'],
  'human-collaboration:append-comment': ['object'],
  'human-collaboration:projection': ['object'],
  'human-collaboration:promote-comment': ['object'],
  'human-collaboration:update-share-rules': ['object'],
  'human-collaboration:audit-log': ['optionalObject'],
  'human-collaboration:session-status': [],
  'human-collaboration-runtime:begin-admission': ['object'],
  'human-collaboration-runtime:confirm-sas': ['object'],
  'human-collaboration-runtime:subscribe-projection': ['object'],
  'human-collaboration-runtime:append-comment': ['object'],
  'human-collaboration-runtime:receive-frame': ['object'],
  'human-collaboration-runtime:disconnect': ['object'],
  // Collaborator side (this instance joining someone else's shared chat).
  'human-collaboration-collaborator:join': ['object'],
  'human-collaboration-collaborator:confirm': [],
  'human-collaboration-collaborator:last-session': [],
  'human-collaboration-collaborator:reconnect': [],
  'human-collaboration-collaborator:append-comment': ['object'],
  'human-collaboration-collaborator:leave': [],
  'reap-abandoned-chats': ['optionalObject'],
  'clear-chats': ['optionalString'],
  'record-usage': ['object'],
  'get-usage': ['optionalString', 'optionalString'],
  'get-scheduled-tasks': ['optionalString'],
  'save-scheduled-task': ['object'],
  // Renderer pushes its localStorage roster-preset list up so the bridge can
  // project presets to iOS (the renderer is the source of truth).
  'ensemble-roster-presets:sync': ['array'],
  'update-scheduled-task': ['string', 'object'],
  'cancel-scheduled-task': ['nonEmptyString', 'optionalString'],
  'delete-scheduled-task': ['string'],
  'get-workflow-definitions': ['optionalString'],
  'save-workflow-definition': ['object'],
  'update-workflow-definition': ['string', 'object'],
  'delete-workflow-definition': ['string'],
  'get-workspace-boards': ['optionalString'],
  'save-workspace-board': ['object'],
  'update-workspace-board': ['string', 'object'],
  'delete-workspace-board': ['string'],
  'get-workspace-board-cards': ['optionalString'],
  'save-workspace-board-card': ['object'],
  'update-workspace-board-card': ['string', 'object'],
  'delete-workspace-board-card': ['string'],
  'set-workflow-unattended-elevation': ['string', 'string'],
  'run-workflow-now': ['string'],
  // Stage 1 slice 4 — durable run-ledger read queries.
  'get-workflow-run-summaries': ['optionalString'],
  'get-workflow-run-events': ['optionalObject'],
  // Main-owned durable execution graph and live Stack surface.
  'execution-graphs:diagnostics': [],
  'execution-graphs:list': ['optionalString'],
  'execution-graphs:get': ['object'],
  'execution-graphs:get-layout': ['object'],
  'execution-graphs:save-layout': ['object'],
  'execution-runs:list': ['optionalObject'],
  'execution-runs:get': ['nonEmptyString'],
  'execution-runs:events': ['nonEmptyString'],
  'execution-runs:append-stack-step': ['object'],
  'execution-runs:cancel': ['nonEmptyString', 'optionalString'],
  'execution-runs:cancel-step': ['object'],
  'execution-runs:formalize': ['object'],
  'get-evidence-packs': ['optionalString'],
  'save-evidence-pack': ['object'],
  'delete-evidence-pack': ['nonEmptyString'],
  'get-capability-ledger-snapshot': ['optionalString'],
  'get-repo-convention-indexes': ['optionalString'],
  'save-repo-convention-index': ['object'],
  // Agent Pool (Phase 2) — per-Agent stats summaries (non-empty id list only).
  'get-agent-stats-summaries': ['array'],
  // Audit-run orchestration (handlers in src/main/ipc/auditHandlers.ts).
  'audit-run:start': ['object'],
  'audit-run:cancel': ['nonEmptyString'],
  'get-audit-run': ['nonEmptyString'],
  'get-audit-runs': ['optionalString'],
  'get-run-queue-jobs': ['optionalObject'],
  'get-run-recovery-records': ['optionalObject'],
  'request-run-queue-job': ['object'],
  'lease-run-queue-job': ['optionalObject'],
  'transition-run-queue-job': ['string', 'runQueueStatus', 'optionalObject'],
  'promote-queued-job-for-steer': ['object'],
  'lease-promoted-steer-job': ['object'],
  'fallback-promoted-steer-job': ['object'],
  'get-run-events': ['optionalObject'],
  'get-run-event-replay': ['runId'],
  'run-analyst:analyze': ['object'],
  'closeout:summarize': ['object'],
  'get-approval-ledger': ['optionalObject'],
  'record-approval-elevation-ack': ['object'],
  'get-memory-proposal-packs': ['optionalString'],
  'get-memory-proposal-pack': ['nonEmptyString'],
  'update-memory-proposal': ['object'],
  'apply-memory-proposal': ['object'],
  'run-manual-introspection': ['object'],
  'get-introspection-schedule': ['optionalString'],
  'update-introspection-schedule': ['object'],
  'get-product-operations-status': [],
  'get-product-crashes': ['optionalObject'],
  'record-product-crash': ['object'],
  'export-product-diagnostics': ['optionalString'],
  'export-product-audit-bundle': ['optionalObject'],
  'verify-product-audit-bundle': ['optionalObject'],
  'purge-product-audit-retention': ['optionalObject'],
  'repair-product-install': [],
  'app-shell-stats:snapshot': [],
  'set-appearance-mode': ['any'],
  'get-host-weather': [],
  'native-capabilities:snapshot': [],
  'fx-rates:get': [],
  'fx-rates:refresh': ['optionalBoolean'],
  'providerRates:get': [],
  'providerRates:probe': [],
  'plugins:get-catalog': [],
  'plugins:get-contributions': [],
  'plugins:get-activation': [],
  'plugins:get-secret-status': [],
  'plugins:set-secret': ['nonEmptyString', 'nonEmptyString', 'string'],
  'plugins:clear-secret': ['nonEmptyString', 'nonEmptyString'],
  'plugins:materialize-mcp-preset': ['nonEmptyString', 'nonEmptyString'],
  'plugins:install': ['nonEmptyString'],
  'plugins:set-enabled': ['nonEmptyString', 'boolean'],
  'plugins:update': ['nonEmptyString'],
  'plugins:uninstall': ['nonEmptyString'],
  'get-extension-secret-status': [],
  'set-extension-secret': ['object', 'string'],
  'clear-extension-secret': ['object'],
  'antigravity-gemini-api:get-secret-status': [],
  'antigravity-gemini-api:set-secret': ['antigravityGeminiApiKey'],
  'antigravity-gemini-api:clear-secret': [],
  'antigravity-gemini-api:get-discovery-outcome': [],
  'pi:get-key-status': [],
  'pi:set-upstream-key': ['piUpstreamId', 'piApiKey'],
  'pi:clear-upstream-key': ['piUpstreamId'],
  'pi:clear-all-keys': [],
  'get-managed-policy-status': [],
  // 1.0.6-CRUX42 — open a Terminal running a provider's interactive CLI login.
  'provider:open-login-terminal': ['provider'],
  'provider:open-logout-terminal': ['provider'],
  'provider:open-upgrade-terminal': ['provider'],
  'app:quit': [],
  // Auto-update service (no-arg snapshot/control channels).
  'update-snapshot': [],
  'check-for-updates': [],
  'download-update': [],
  'download-update-and-restart': [],
  'install-update-on-quit': [],
  'install-update-now': [],
  // Local Servers — dev servers detected under the user's workspaces.
  'local-servers-snapshot': [],
  'local-servers-refresh': [],
  'local-servers-stop': ['number'],
  'local-servers-stop-all': [],
  'launch-targets-snapshot': ['workspacePath'],
  'launch-attempts-snapshot': [],
  'launch-start': ['object'],
  'launch-stop': ['object'],
  // Canvas WebContentsView control is main-renderer-only (see
  // RendererIpcPolicy). Keep the IPC boundary strict because malformed bounds
  // or a secondary renderer driving the shared overlay can obscure/spoof the
  // primary app surface.
  'canvas:open-window': ['optionalCanvasOpenArgs'],
  'canvas:open-embedded': ['optionalCanvasOpenArgs'],
  'canvas:open-sketch-window': ['optionalCanvasSketchArgs'],
  'canvas:open-sketch-embedded': ['optionalCanvasSketchArgs'],
  'canvas:set-bounds': ['nonEmptyString', 'canvasBounds'],
  'canvas:set-visible': ['nonEmptyString', 'boolean'],
  'canvas:close': ['nonEmptyString'],
  'canvas:close-chat': ['nonEmptyString', 'nonEmptyString'],
  'canvas:list': [],
  'canvas:list-chat': ['nonEmptyString'],
  // Mesh Canvas is a main-window dock. Native pickers supply external model or
  // scene-package paths in main; the renderer passes only its canonical chat/
  // scene identity.
  'mesh-scene:list-chat': ['nonEmptyString'],
  'mesh-scene:view': ['nonEmptyString', 'nonEmptyString'],
  'mesh-scene:import-user-model': ['nonEmptyString'],
  'mesh-scene:import-user-package': ['nonEmptyString'],
  'mesh-scene:close-presentation': ['nonEmptyString', 'nonEmptyString'],
  'mesh-scene:delete': ['nonEmptyString', 'nonEmptyString'],
  // Changelog sheet (update-pill feature): `changelog-snapshot` is a no-arg
  // read returning ProductChangelogSnapshot | null; `mark-changelog-seen`
  // persists the last-seen version. The handler coerces a missing/empty
  // version defensively (returns the snapshot unchanged), so optionalString
  // mirrors the store-*-api-key channels rather than nonEmptyString.
  'changelog-snapshot': [],
  'mark-changelog-seen': ['optionalString'],
  // Agent-question modal replies (the payload object carries questionId).
  'answer-agent-question': ['optionalObject'],
  'cancel-agent-question': ['optionalObject'],
  'answer-ensemble-poll': ['optionalObject'],
  // Runtime profiles + handoff cards (store CRUD).
  'save-runtime-profile': ['optionalObject'],
  'delete-runtime-profile': ['nonEmptyString'],
  'save-handoff-card': ['optionalObject'],
  'update-handoff-card': ['nonEmptyString', 'optionalObject'],
  'delete-handoff-card': ['nonEmptyString'],
  // Provider API-key storage + login (handlers coerce defensively).
  'store-claude-api-key': ['optionalString'],
  'clear-claude-api-key': [],
  'trigger-claude-login': [],
  'store-kimi-api-key': ['optionalString'],
  'clear-kimi-api-key': [],
  'provider:open-kimi-upgrade-terminal': [],
  // GitHub PR creation (optional payload with target path / options).
  'git:snapshot': ['optionalObject'],
  'git:subscribe-snapshot': ['optionalObject'],
  'git:unsubscribe-snapshot': ['optionalObject'],
  'git:invalidate-snapshot': ['optionalObject'],
  'git:stage': ['optionalObject'],
  'git:unstage': ['optionalObject'],
  'git:commit': ['optionalObject'],
  'git:push': ['optionalObject'],
  'git:list-branches': ['optionalObject'],
  'git:checkout-branch': ['optionalObject'],
  'git:create-branch': ['optionalObject'],
  'git:list-worktrees': ['optionalObject'],
  'git:create-worktree': ['optionalObject'],
  'git:remove-worktree': ['optionalObject'],
  'git:select-worktree': ['optionalObject'],
  'fanout-candidates:list': ['string'],
  'fanout-candidates:diff': ['string', 'string'],
  'fanout-candidates:promote': ['string', 'string'],
  'fanout-candidates:discard': ['string', 'string'],
  'github:pr-status': ['optionalObject'],
  'github:pr-readiness': ['optionalObject'],
  'github:ci-status': ['optionalObject'],
  'github:set-watched-pr': ['optionalObject'],
  'github:watch-pr-notify-ack': ['optionalObject'],
  'create-github-pr': ['optionalObject'],
  'agentic-yolo-get': [],
  'agentic-yolo-set': ['boolean'],
  'trusted-session-get': ['object'],
  'trusted-session-set': ['object', 'boolean'],
  'get-file-icon': ['string'],
  'get-gemini-version': [],
  'get-gemini-capabilities': ['optionalString'],
  'get-gemini-mcp-bridge-status': [],
  'install-gemini-mcp-bridge': [],
  'set-gemini-mcp-bridge-enabled': ['boolean'],
  'set-bridge-daemon-enabled': ['boolean'],
  'get-ios-remote-config': [],
  'set-ios-remote-config': ['object'],
  // T66 Tailscale wss lane — status probe + serve enable/disable. All
  // zero-arg; the handlers read live `tailscale` CLI state themselves.
  // These were initially registered as handlers WITHOUT schema entries,
  // which broke the Devices panel's status poll AND its Enable button at
  // runtime ("No IPC schema registered") — the second occurrence of this
  // bug class (see external-path:pick-and-persist above). The
  // ipc-channel-registry invariant test now cross-checks every
  // ipcMain.handle() literal against this table at test time.
  'ios-remote-tailscale-status': [],
  'ios-remote-tailscale-enable': [],
  'ios-remote-tailscale-test': [],
  'ios-remote-tailscale-disable': [],
  'ios-remote-tailscale-link': ['nonEmptyString'],
  // QR-optional discovery (Slice 5d): set takes {clientId, clientSecret}; the
  // handler validates+encrypts. clear/status are zero-arg.
  'ios-remote-tailscale-oauth-set': ['object'],
  'ios-remote-tailscale-oauth-clear': [],
  'ios-remote-tailscale-oauth-status': [],
  'run-approved-host-command': ['nonEmptyString'],
  'list-gemini-sessions': [],
  'select-workspace': [],
  'select-image-files': [],
  'save-clipboard-image-attachment': ['chatId', 'any'],
  'composer-audio:transcribe': ['object'],
  'read-image-preview': ['string'],
  'image-generation:get-status': [],
  'image-generation:set-enabled': ['object'],
  'image-generation:set-key': ['object'],
  'image-generation:clear-key': ['object'],
  'spellcheck:get-last-context': ['object'],
  'spellcheck:replace-misspelling': ['object'],
  'spellcheck:add-word-to-dictionary': ['object'],
  'sidebar:show-workspace-in-finder': ['nonEmptyString'],
  'sidebar:copy-workspace-directory': ['nonEmptyString'],
  'sidebar:show-chat-workspace-in-finder': ['chatId'],
  'sidebar:copy-chat-working-directory': ['chatId'],
  'sidebar:copy-chat-transcript-path': ['chatId'],
  'copy-chat-markdown-transcript': ['chatId'],
  'copy-chat-messages': ['chatId'],
  'select-external-path-grant': ['externalPathGrantAccess'],
  // 1.0.6-EW69 — the composer workspace manager's add flows (proactive
  // read/write folder grant + attach-known-workspace-as-secondary) all
  // go through this one channel with a single `{ chatId, access?, path? }`
  // payload. (`['object']` mirrors `compose-run`; the handler does its own
  // field validation via optionalString/getChat.) This was previously
  // missing from the registry, so installIpcValidation threw
  // "No IPC schema registered" the moment any add flow fired.
  // Peer thread messaging. The handlers re-derive and re-check every field
  // themselves (sender scope, main-renderer proof, the send gate); these specs are
  // the outer shape check that keeps them from being reached with the wrong arity
  // or type at all. `nonEmptyString` rather than `string`: a blank chat id has no
  // valid meaning on any of the three.
  'thread-message:targets': ['nonEmptyString'],
  'thread-message:inbox': ['nonEmptyString'],
  'thread-message:send': ['object'],
  'external-path:pick-and-persist': ['object'],
  'external-path:revoke': ['object'],
  'probe-external-path': ['nonEmptyString'],
  'list-workspace-files': ['workspacePath'],
  'list-workspace-files-for-editor': ['workspacePath', 'optionalObject'],
  'read-workspace-file': ['workspacePath', 'filePath'],
  'discover-gemini-commands': ['workspacePath'],
  'discover-gemini-memory': ['workspacePath'],
  'write-workspace-file': ['workspacePath', 'filePath', 'string', 'optionalString'],
  'delete-workspace-file': ['workspacePath', 'filePath', 'optionalString'],
  'office:read-document': ['workspacePath', 'filePath'],
  'office:write-document': ['workspacePath', 'filePath', 'object', 'optionalString'],
  'office:delete-document': ['workspacePath', 'filePath', 'optionalString'],
  // External office documents: payload objects carry chatId + absolute path;
  // field validation lives in the handler (mirrors external-path:pick-and-persist).
  'office:read-external-document': ['object'],
  'office:write-external-document': ['object'],
  'office:import-document': ['object'],
  'office:reveal-document': ['object'],
  'office:open-document-in-default-app': ['object'],
  // Microsoft account connect/disconnect. The sign-in payload carries a
  // client id + tenant; the handler validates their shapes.
  'outlook:status': [],
  'outlook:start-sign-in': ['object'],
  'outlook:poll-sign-in': [],
  'outlook:disconnect': [],
  'get-agent-status': ['provider'],
  'get-agent-rate-limits': ['provider', 'optionalObject'],
  'import-codex-usage-credential': ['optionalString'],
  'clear-codex-usage-credential': [],
  'get-codex-usage-snapshot': ['optionalObject'],
  'get-external-usage': ['optionalObject'],
  'get-workspace-activity': ['workspacePath', 'optionalNumber'],
  'grok-usage:probe': [],
  'mistral-quota:get': [],
  'mistral-quota:set-plan': ['nonEmptyString'],
  'mistral-quota:set-anchor': ['object'],
  'mistral-quota:clear-anchor': [],
  'mistral-admin-key:status': [],
  'mistral-admin-key:set': ['nonEmptyString'],
  'mistral-admin-key:clear': [],
  'mistral-quota:refresh-admin': [],
  'get-claude-auth-status': [],
  'get-kimi-auth-status': [],
  'get-gemini-auth-status': [],
  'list-gemini-auth-profiles': [],
  'save-gemini-auth-profile': ['object'],
  'delete-gemini-auth-profile': ['nonEmptyString'],
  'set-default-gemini-auth-profile': ['optionalString'],
  'start-gemini-oauth-login': ['optionalObject'],
  'get-gemini-oauth-login-status': ['optionalString'],
  'cancel-gemini-oauth-login': ['optionalString'],
  'get-agent-mcp-status': ['provider'],
  'get-provider-capabilities': ['provider', 'optionalString', 'optionalString'],
  'get-provider-adapters': [],
  'get-configured-provider-snapshot': [],
  'prompt-cache:get-policy': [],
  'prompt-cache:save-policy': ['object'],
  'prompt-cache:get-capabilities': [],
  'prompt-cache:get-diagnostics': [],
  'get-runtime-profiles': ['optionalProvider'],
  'get-handoff-cards': ['optionalObject'],
  'list-agent-threads': ['provider', 'optionalObject'],
  'fork:get-capability': ['provider'],
  'fork-agent-thread': ['provider', 'string', 'optionalObject'],
  'rollback-agent-thread': ['provider', 'string', 'optionalNumber'],
  'start-agent-review': ['provider', 'string', 'optionalObject'],
  'get-agent-models': ['provider'],
  'run-agent': ['runPayload'],
  // Phase B6 ComposerService: renderer calls compose-run with the
  // ComposerRunInput shape (single object) and receives a fully
  // constructed AgentRunPayload + composer metadata back.
  'compose-run': ['object'],
  'cancel-agent-run': ['optionalProvider', 'optionalString'],
  'respond-agent-approval': ['nonEmptyString', 'approvalAction'],
  'run-gemini': [
    'workspacePath',
    'string',
    'optionalString',
    'optionalString',
    'optionalBoolean',
    'optionalArray',
    'optionalString',
    'any',
    'optionalObject'
  ],
  'cancel-gemini': ['optionalString'],
  'write-gemini-input': ['string'],
  'start-gemini-session': [
    'workspacePath',
    'optionalString',
    'optionalString',
    'optionalBoolean',
    'optionalNumber',
    'optionalNumber',
    'optionalString',
    'any'
  ],
  'stop-gemini-session': [],
  'write-gemini-session': ['string'],
  'resize-gemini-session': ['number', 'number'],
  'get-diff': ['workspacePathOrObject'],
  'open-workspace-popout': ['object'],
  'dock-side-chat-popout': ['object'],
  'wake-ensemble-participant-now': ['string'],
  'cancel-ensemble-participant-wakeup': ['string'],
  'get-workspace-change-sets': ['optionalObject'],
  'capture-snapshot': ['workspacePath'],
  'compute-run-diff': ['runId', 'any', 'any', 'optionalObject'],
  'check-trust': ['workspacePath'],
  'trust-workspace': ['workspacePath'],
  'shell:open-link': ['nonEmptyString'],
  'shell:reveal-in-finder': ['nonEmptyString'],
  // Content-addressed AV media-asset path resolution for renderer reveal/copy/save.
  // Each takes a single `{ sha256, mimeType, ... }` object; the handler re-validates
  // the sha256 + jails the resolved path via transcriptMediaAssetPath (the renderer
  // never resolves filesystem paths itself).
  'media-asset:reveal': ['object'],
  'media-asset:get-path': ['object'],
  'media-asset:save-as': ['object'],
  'favicon:getForUrl': ['nonEmptyString'],
  'start-pty': ['workspacePath', 'optionalString'],
  'stop-pty': ['optionalString'],
  'pty-write': ['string', 'optionalString'],
  'pty-resize': ['number', 'number', 'optionalString'],
  'bridge-networking-status': [],
  'bridge-allowlist-list': [],
  'bridge-allowlist-upsert': ['object'],
  'bridge-allowlist-remove': ['nonEmptyString'],
  'bridge-allowlist-clear': [],
  'discord-context:list-targets': [],
  'discord-context:read-channel': ['object'],
  'bridge-finalize-pairing': ['nonEmptyString', 'boolean'],
  'bridge-begin-pairing': ['optionalString'],
  'bridge-list-paired-devices': [],
  'bridge-unpair-device': ['nonEmptyString'],
  // Native-window attachments are chat-scoped. The renderer receives only a
  // safe status projection; the opaque handle and scope remain main-owned.
  'attach-window:pick': ['chatId'],
  'attach-window:detach': ['chatId', 'positiveInteger'],
  'attach-window:status': ['chatId'],
  // M11 (1.0.7) — sticky AppWatch per-chat attachment snapshots.
  'sticky-appwatch:get': ['chatId'],
  'sticky-appwatch:stash': ['stickyAppWatchStash'],
  'sticky-appwatch:clear': ['chatId'],
  /* Slash-picker `/clear` — non-destructive of the chat record, only of
   * its message + run history. Mirrors deleteChat's arg shape. */
  'truncate-chat': ['chatId'],
  // Phase E1: APNs production wiring — Settings panel uses these to configure
  // the iOS bridge push gateway. All handlers live in main; safeStorage handles
  // .p8 encryption at-rest; renderer never sees the decrypted PEM.
  'get-apns-config': [],
  'select-apns-key-file': [],
  'set-apns-config': ['object'],
  'clear-apns-config': [],
  'test-apns-push': [],
  // Tester-feedback intake (1.0.1). The renderer collects a short
  // title + optional description / expected / severity from
  // BugReportSheet.tsx and ships the auto-captured context block
  // alongside; main appends to `<userData>/TaskWraith/bug-reports.md`.
  // Also exposes a tiny `get-app-version` so the sheet's read-only
  // context row can display the canonical version without hard-coding.
  'get-app-version': [],
  'submit-bug-report': ['bugReportPayload']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validateArg(channel: string, spec: ArgSpec, value: unknown, index: number): void {
  const label = `${channel} argument ${index + 1}`
  if (spec === 'any') return
  if (spec.startsWith('optional') && (value === undefined || value === null)) return
  if ((spec === 'string' || spec === 'optionalString') && typeof value !== 'string')
    throw new Error(`${label} must be a string.`)
  if (spec === 'nonEmptyString' && (typeof value !== 'string' || !value.trim()))
    throw new Error(`${label} must be a non-empty string.`)
  if (
    spec === 'antigravityGeminiApiKey' &&
    (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > 4_096)
  ) {
    throw new Error(`${label} must be a non-empty Gemini API key of at most 4096 bytes.`)
  }
  if (spec === 'piUpstreamId' && (typeof value !== 'string' || !PI_UPSTREAMS.has(value))) {
    throw new Error(`${label} must be a supported Pi upstream id.`)
  }
  if (
    spec === 'piApiKey' &&
    (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > 4_096)
  ) {
    throw new Error(`${label} must be a non-empty API key of at most 4096 bytes.`)
  }
  if (
    (spec === 'workspacePath' || spec === 'filePath' || spec === 'runId' || spec === 'chatId') &&
    (typeof value !== 'string' || !value.trim())
  )
    throw new Error(`${label} must be a non-empty string.`)
  if (spec === 'chatId') assertSafeChatId(value, label)
  if (spec === 'workspacePath' && !/^([/\\~]|[A-Za-z]:[\\/])/.test(value as string))
    throw new Error(`${label} must be an absolute workspace path.`)
  if (spec === 'workspacePathOrObject') {
    const candidate =
      typeof value === 'string'
        ? value
        : isRecord(value)
          ? typeof value.repoPath === 'string'
            ? value.repoPath
            : value.workspacePath
          : undefined
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error(`${label} must include a non-empty workspace path.`)
    }
    if (!/^([/\\~]|[A-Za-z]:[\\/])/.test(candidate)) {
      throw new Error(`${label} must include an absolute workspace path.`)
    }
    if (isRecord(value) && value.chatId !== undefined) {
      assertSafeChatId(value.chatId, `${label} chat id`)
    }
  }
  if (spec === 'filePath' && /\0/.test(value as string))
    throw new Error(`${label} must not contain null bytes.`)
  if (
    (spec === 'number' || spec === 'optionalNumber') &&
    (typeof value !== 'number' || !Number.isFinite(value))
  )
    throw new Error(`${label} must be a finite number.`)
  if (spec === 'positiveInteger' && (!Number.isSafeInteger(value) || Number(value) <= 0))
    throw new Error(`${label} must be a positive safe integer.`)
  if ((spec === 'boolean' || spec === 'optionalBoolean') && typeof value !== 'boolean')
    throw new Error(`${label} must be a boolean.`)
  if (
    (spec === 'object' ||
      spec === 'optionalObject' ||
      spec === 'settingsPatch' ||
      spec === 'chatRecord' ||
      spec === 'runPayload') &&
    !isRecord(value)
  )
    throw new Error(`${label} must be an object.`)
  if ((spec === 'array' || spec === 'optionalArray') && !Array.isArray(value))
    throw new Error(`${label} must be an array.`)
  if (
    (spec === 'provider' || spec === 'optionalProvider') &&
    (typeof value !== 'string' || !PROVIDERS.has(value))
  )
    throw new Error(`${label} must be a known provider.`)
  if (spec === 'approvalAction' && (typeof value !== 'string' || !APPROVAL_ACTIONS.has(value)))
    throw new Error(`${label} must be a known approval action.`)
  if (spec === 'runQueueStatus' && (typeof value !== 'string' || !RUN_QUEUE_STATUSES.has(value)))
    throw new Error(`${label} must be a known run queue status.`)
  if (
    spec === 'externalPathGrantAccess' &&
    value !== undefined &&
    value !== null &&
    value !== 'read' &&
    value !== 'write'
  )
    throw new Error(`${label} must be read or write.`)
  if (spec === 'runPayload') validateRunPayload(channel, value)
  if (spec === 'chatRecord') validateChatRecord(channel, value)
  if (spec === 'settingsPatch') validateSettingsPatch(channel, value)
  if (spec === 'bugReportPayload') validateBugReportPayload(channel, value)
  if (spec === 'optionalCanvasOpenArgs') validateCanvasOpenArgs(channel, value)
  if (spec === 'optionalCanvasSketchArgs') validateCanvasSketchArgs(channel, value)
  if (spec === 'canvasBounds') validateCanvasBounds(channel, value)
  if (spec === 'stickyAppWatchStash') validateStickyAppWatchStash(channel, value)
}

function validateKnownKeys(
  channel: string,
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${channel} payload contains unknown field ${key}.`)
  }
}

function validateOptionalCanvasChatId(channel: string, value: unknown): void {
  if (value === undefined) return
  assertSafeChatId(value, `${channel} chat id`)
}

function validateCanvasOpenArgs(channel: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (!isRecord(value)) throw new Error(`${channel} payload must be an object.`)
  validateKnownKeys(channel, value, new Set(['url', 'originAllowlist', 'chatId']))
  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || !value.url.trim() || value.url.length > 8_192) {
      throw new Error(`${channel} url must be a non-empty string of at most 8192 characters.`)
    }
  }
  if (value.originAllowlist !== undefined) {
    if (!Array.isArray(value.originAllowlist) || value.originAllowlist.length > 64) {
      throw new Error(`${channel} originAllowlist must be an array of at most 64 strings.`)
    }
    for (const origin of value.originAllowlist) {
      if (typeof origin !== 'string' || !origin.trim() || origin.length > 2_048) {
        throw new Error(`${channel} originAllowlist entries must be non-empty bounded strings.`)
      }
    }
  }
  validateOptionalCanvasChatId(channel, value.chatId)
}

function validateCanvasSketchArgs(channel: string, value: unknown): void {
  if (value === undefined || value === null) return
  if (!isRecord(value)) throw new Error(`${channel} payload must be an object.`)
  validateKnownKeys(channel, value, new Set(['chatId']))
  validateOptionalCanvasChatId(channel, value.chatId)
}

function validateCanvasBounds(channel: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${channel} bounds must be an object.`)
  validateKnownKeys(channel, value, new Set(['x', 'y', 'width', 'height']))
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new Error(`${channel} bounds.${key} must be a finite number.`)
    }
  }
  if ((value.width as number) < 0 || (value.height as number) < 0) {
    throw new Error(`${channel} bounds dimensions must be non-negative.`)
  }
  const coordinateLimit = 1_000_000
  if (
    Math.abs(value.x as number) > coordinateLimit ||
    Math.abs(value.y as number) > coordinateLimit ||
    (value.width as number) > coordinateLimit ||
    (value.height as number) > coordinateLimit
  ) {
    throw new Error(`${channel} bounds exceed the supported range.`)
  }
}

/**
 * Resume hints are intentionally display-only. Keep identity, lease, and
 * consent material out of this renderer-writable IPC boundary even if a
 * caller bypasses preload.
 */
function validateStickyAppWatchStash(channel: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${channel} payload must be an object.`)
  validateKnownKeys(channel, value, new Set(['chatId', 'windowMeta', 'attachedAt', 'wasStreaming']))
  assertSafeChatId(value.chatId, `${channel} chat id`)
  if (!isRecord(value.windowMeta)) {
    throw new Error(`${channel} windowMeta must be an object.`)
  }
  validateKnownKeys(
    `${channel} windowMeta`,
    value.windowMeta,
    new Set(['title', 'bundleID', 'applicationName'])
  )
  let hasDisplayIdentity = false
  for (const [field, maximum] of [
    ['title', 4_096],
    ['bundleID', 512],
    ['applicationName', 512]
  ] as const) {
    const text = value.windowMeta[field]
    if (typeof text !== 'string' || text.length > maximum) {
      throw new Error(`${channel} windowMeta.${field} must be a bounded string.`)
    }
    hasDisplayIdentity ||= Boolean(text.trim())
  }
  if (!hasDisplayIdentity) {
    throw new Error(`${channel} windowMeta must include display identity.`)
  }
  if (
    typeof value.attachedAt !== 'string' ||
    !value.attachedAt.trim() ||
    value.attachedAt.length > 128
  ) {
    throw new Error(`${channel} attachedAt must be a bounded non-empty string.`)
  }
  if (typeof value.wasStreaming !== 'boolean') {
    throw new Error(`${channel} wasStreaming must be a boolean.`)
  }
}

function validateRunPayload(channel: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${channel} payload must be an object.`)
  validateArg(channel, 'provider', value.provider, 0)
  const scope = value.scope === 'global' ? 'global' : 'workspace'
  if (scope === 'global') {
    const chatId = value.appChatId ?? value.chatId
    if (typeof chatId !== 'string' || !chatId.trim()) {
      throw new Error(`${channel} global payload chat id must be a non-empty string.`)
    }
    assertSafeChatId(chatId, `${channel} global payload chat id`)
  } else {
    validateArg(channel, 'workspacePath', value.workspace, 1)
  }
  if (typeof value.prompt !== 'string')
    throw new Error(`${channel} payload prompt must be a string.`)
  if (value.imagePaths !== undefined && !Array.isArray(value.imagePaths))
    throw new Error(`${channel} payload imagePaths must be an array.`)
}

function validateChatRecord(channel: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${channel} chat must be an object.`)
  assertSafeChatId(value.appChatId, `${channel} chat id`)
}

function validateSettingsPatch(channel: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${channel} settings patch must be an object.`)
  if (value.activeProvider !== undefined) validateArg(channel, 'provider', value.activeProvider, 0)
  if (value.funFxEnabled !== undefined) {
    if (typeof value.funFxEnabled !== 'boolean')
      throw new Error(`${channel} funFxEnabled must be a boolean.`)
  }
  if (value.bridgeDaemonEnabled !== undefined) {
    if (typeof value.bridgeDaemonEnabled !== 'boolean')
      throw new Error(`${channel} bridgeDaemonEnabled must be a boolean.`)
  }
  if (value.funFxMode !== undefined) {
    const mode = String(value.funFxMode)
    if (!['off', 'subtle', 'cinematic', 'epic'].includes(mode)) {
      throw new Error(`${channel} funFxMode must be one of off, subtle, cinematic, epic.`)
    }
  }
  if (value.agenticServices !== undefined && !isRecord(value.agenticServices))
    throw new Error(`${channel} agenticServices must be an object.`)
  if (value.dashboardStatPrefs !== undefined && !isRecord(value.dashboardStatPrefs))
    throw new Error(`${channel} dashboardStatPrefs must be an object.`)
  if (value.welcomeHeatmapPrefs !== undefined && !isRecord(value.welcomeHeatmapPrefs))
    throw new Error(`${channel} welcomeHeatmapPrefs must be an object.`)
  if (value.approvalTimeouts !== undefined && !isRecord(value.approvalTimeouts))
    throw new Error(`${channel} approvalTimeouts must be an object.`)
  if (value.auditOrchestration !== undefined && !isRecord(value.auditOrchestration))
    throw new Error(`${channel} auditOrchestration must be an object.`)
  if (value.agenticWorkspaceGrants !== undefined)
    throw new Error(`${channel} cannot update workspace grants directly.`)
}

/** Bug-report payload guard. Keeps the IPC honest: only the four
 * known severities, title required (non-empty after trim), the
 * three free-text fields are strings (possibly empty), and the
 * context block carries the five auto-captured strings. */
function validateBugReportPayload(channel: string, value: unknown): void {
  if (!isRecord(value)) throw new Error(`${channel} bug-report payload must be an object.`)
  if (typeof value.title !== 'string' || !value.title.trim())
    throw new Error(`${channel} bug-report title must be a non-empty string.`)
  if (value.title.length > 280)
    throw new Error(`${channel} bug-report title must be 280 characters or fewer.`)
  if (typeof value.description !== 'string')
    throw new Error(`${channel} bug-report description must be a string.`)
  if (typeof value.expected !== 'string')
    throw new Error(`${channel} bug-report expected must be a string.`)
  if (typeof value.severity !== 'string' || !BUG_REPORT_SEVERITIES.has(value.severity))
    throw new Error(`${channel} bug-report severity must be info, minor, major, or blocking.`)
  if (!isRecord(value.context)) throw new Error(`${channel} bug-report context must be an object.`)
  const ctx = value.context
  for (const key of ['timestamp', 'version', 'provider', 'workspace', 'shell'] as const) {
    if (typeof ctx[key] !== 'string')
      throw new Error(`${channel} bug-report context.${key} must be a string.`)
  }
  for (const key of [
    'surface',
    'chatKind',
    'settingsTab',
    'inspectorTab',
    'theme',
    'promptBubble',
    'ensemble'
  ] as const) {
    if (ctx[key] !== undefined && typeof ctx[key] !== 'string') {
      throw new Error(`${channel} bug-report context.${key} must be a string when provided.`)
    }
  }
}

export function validateIpcArgs(channel: string, args: unknown[]): unknown[] {
  const schema = IPC_ARGUMENT_SCHEMAS[channel]
  if (!schema) {
    throw new Error(`No IPC schema registered for ${channel}.`)
  }
  // Detach is a generation-bound revoke operation, so trailing renderer data
  // must not be silently ignored. Preserve legacy optional-tail behavior for
  // unrelated IPC channels.
  if (channel === 'attach-window:detach' && args.length > schema.length) {
    throw new Error(`${channel} received too many arguments.`)
  }
  schema.forEach((spec, index) => validateArg(channel, spec, args[index], index))
  return args
}

export type IpcInvocationAuthorizer = (channel: string, event: IpcMainInvokeEvent) => void

export function installIpcValidation(
  ipcMain: IpcMain,
  authorizeInvocation?: IpcInvocationAuthorizer
): void {
  const target = ipcMain as IpcMain & { __agentBenchValidationInstalled?: boolean }
  if (target.__agentBenchValidationInstalled) return
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ;(target as any).handle = (channel: string, listener: any) => {
    return originalHandle(channel, (event, ...args) => {
      authorizeInvocation?.(channel, event)
      return listener(event, ...validateIpcArgs(channel, args))
    })
  }
  target.__agentBenchValidationInstalled = true
}
