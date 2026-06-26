import type { IpcMain } from 'electron'
import { assertSafeChatId } from './ChatPath'

type ArgSpec =
  | 'any'
  | 'string'
  | 'nonEmptyString'
  | 'optionalString'
  | 'number'
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
  | 'filePath'
  | 'runId'
  | 'chatId'
  | 'externalPathGrantAccess'
  | 'runQueueStatus'
  | 'bugReportPayload'

// Grok + Cursor are first-class providers; no eligibility gate (see ProviderId).
const PROVIDERS = new Set(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
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
  'get-chats': ['optionalString'],
  'get-chat-list': ['optionalString'],
  'get-pinned-messages': ['optionalString'],
  'get-chat': ['chatId'],
  'create-chat': ['string', 'workspacePath'],
  'create-global-chat': [],
  'create-ensemble-chat': ['optionalObject'],
  'run-ensemble-round': ['object'],
  'steer-queued-ensemble-prompt': ['object'],
  'remove-queued-ensemble-prompt': ['object'],
  'cancel-ensemble-round': ['chatId'],
  'skip-ensemble-participant': ['chatId'],
  'session-checkpoints:latest': ['chatId'],
  'session-checkpoints:accept': ['nonEmptyString'],
  'session-checkpoints:dismiss': ['nonEmptyString'],
  'create-sub-thread': ['object'],
  'get-sub-threads': ['chatId'],
  'create-side-chat': ['object'],
  'get-side-chats': ['chatId'],
  'set-guest-participant': ['object'],
  'remove-guest-participant': ['chatId'],
  'save-chat': ['chatRecord'],
  'delete-chat': ['chatId'],
  // Human collaboration (shared chat: host + up to 2 human collaborators). These
  // MUST be registered — installIpcValidation throws "No IPC schema registered"
  // for any unregistered ipcMain.handle channel, so their absence bricks the whole
  // feature at runtime AND turns the invariant test (below) red. The object-shaped
  // channels carry collaborator-DERIVED payloads; their handlers do deep field
  // validation downstream (requireSafeChatId / requireBoundedText(8000) /
  // requireNonEmptyString), so the coarse 'object' spec here matches the existing
  // 'compose-run' / 'create-sub-thread' precedent and is the IPC-boundary shape gate.
  'human-collaboration:create-share': ['object'],
  'human-collaboration:list-shares': ['optionalString'],
  'human-collaboration:connected-chat-ids': [],
  'human-collaboration:revoke-share': ['nonEmptyString'],
  'human-collaboration:revoke-participant': ['object'],
  'human-collaboration:consume-invite': ['object'],
  'human-collaboration:append-comment': ['object'],
  'human-collaboration:projection': ['object'],
  'human-collaboration:promote-comment': ['object'],
  'human-collaboration-runtime:begin-admission': ['object'],
  'human-collaboration-runtime:confirm-sas': ['object'],
  'human-collaboration-runtime:subscribe-projection': ['object'],
  'human-collaboration-runtime:append-comment': ['object'],
  'human-collaboration-runtime:receive-frame': ['object'],
  'human-collaboration-runtime:disconnect': ['object'],
  // Collaborator side (this instance joining someone else's shared chat).
  'human-collaboration-collaborator:join': ['object'],
  'human-collaboration-collaborator:confirm': [],
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
  'delete-scheduled-task': ['string'],
  'get-workflow-definitions': ['optionalString'],
  'save-workflow-definition': ['object'],
  'update-workflow-definition': ['string', 'object'],
  'delete-workflow-definition': ['string'],
  'set-workflow-unattended-elevation': ['string', 'string'],
  'run-workflow-now': ['string'],
  // Stage 1 slice 4 — durable run-ledger read queries.
  'get-workflow-run-summaries': ['optionalString'],
  'get-workflow-run-events': ['optionalObject'],
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
  'get-approval-ledger': ['optionalObject'],
  'record-approval-elevation-ack': ['object'],
  'get-product-operations-status': [],
  'get-product-crashes': ['optionalObject'],
  'record-product-crash': ['object'],
  'export-product-diagnostics': ['optionalString'],
  'repair-product-install': [],
  'app-shell-stats:snapshot': [],
  'set-appearance-mode': ['any'],
  'get-host-weather': [],
  'native-capabilities:snapshot': [],
  'fx-rates:get': [],
  'fx-rates:refresh': ['optionalBoolean'],
  'providerRates:get': [],
  'providerRates:probe': [],
  // 1.0.6-CRUX42 — open a Terminal running a provider's interactive CLI login.
  'provider:open-login-terminal': ['provider'],
  'provider:open-logout-terminal': ['provider'],
  'provider:open-upgrade-terminal': ['provider'],
  'app:quit': [],
  // Auto-update service (no-arg snapshot/control channels).
  'update-snapshot': [],
  'check-for-updates': [],
  'download-update': [],
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
  'git:stage': ['optionalObject'],
  'git:unstage': ['optionalObject'],
  'git:commit': ['optionalObject'],
  'git:push': ['optionalObject'],
  'github:pr-status': ['optionalObject'],
  'github:pr-readiness': ['optionalObject'],
  'create-github-pr': ['optionalObject'],
  'agentic-yolo-get': [],
  'agentic-yolo-set': ['boolean'],
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
  'save-clipboard-image-attachment': [],
  'authorize-image-preview': ['array'],
  'read-image-preview': ['string'],
  'image-generation:get-status': [],
  'image-generation:set-enabled': ['object'],
  'image-generation:set-key': ['object'],
  'image-generation:clear-key': ['object'],
  'spellcheck:get-last-context': ['object'],
  'spellcheck:replace-misspelling': ['object'],
  'spellcheck:add-word-to-dictionary': ['object'],
  'copy-chat-markdown-transcript': ['chatId'],
  'select-external-path-grant': ['externalPathGrantAccess'],
  // 1.0.6-EW69 — the composer workspace manager's add flows (proactive
  // read/write folder grant + attach-known-workspace-as-secondary) all
  // go through this one channel with a single `{ chatId, access?, path? }`
  // payload. (`['object']` mirrors `compose-run`; the handler does its own
  // field validation via optionalString/getChat.) This was previously
  // missing from the registry, so installIpcValidation threw
  // "No IPC schema registered" the moment any add flow fired.
  'external-path:pick-and-persist': ['object'],
  'probe-external-path': ['nonEmptyString'],
  'list-workspace-files': ['workspacePath'],
  'list-workspace-files-for-editor': ['workspacePath', 'optionalObject'],
  'read-workspace-file': ['workspacePath', 'filePath'],
  'discover-gemini-commands': ['workspacePath'],
  'discover-gemini-memory': ['workspacePath'],
  'write-workspace-file': ['workspacePath', 'filePath', 'string', 'optionalString'],
  'delete-workspace-file': ['workspacePath', 'filePath'],
  'get-agent-status': ['provider'],
  'get-agent-rate-limits': ['provider'],
  'import-codex-usage-credential': ['optionalString'],
  'clear-codex-usage-credential': [],
  'get-codex-usage-snapshot': [],
  'get-external-usage': ['optionalObject'],
  'get-workspace-activity': ['workspacePath', 'optionalNumber'],
  'grok-usage:probe': [],
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
  'get-runtime-profiles': ['optionalProvider'],
  'get-handoff-cards': ['optionalObject'],
  'list-agent-threads': ['provider', 'optionalObject'],
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
  'get-diff': ['workspacePath'],
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
  'message-channels:list-bindings': [],
  'message-channels:list-adapters': [],
  'message-channels:upsert-binding': ['object'],
  'message-channels:archive-binding': ['nonEmptyString'],
  'message-channels:send-test': ['nonEmptyString'],
  'message-channels:poll-binding': ['nonEmptyString'],
  'message-channels:peek-binding': ['nonEmptyString'],
  'message-channels:list-cursors': [],
  'message-channels:clear-cursors': [],
  'message-channels:clear-binding-cursor': ['nonEmptyString'],
  'message-channels:list-audit': ['optionalNumber'],
  'message-channels:poll-once': ['optionalObject'],
  'message-channels:submit-web-message': ['object'],
  'message-channels:drain-web-outbox': ['optionalObject'],
  'discord-context:list-targets': [],
  'discord-context:read-channel': ['object'],
  'messages-bridge:status': [],
  'messages-bridge:open-permission-helper': [],
  'messages-bridge:reveal-permission-helper-app': [],
  'messages-bridge:list-conversations': ['optionalObject'],
  'bridge-finalize-pairing': ['nonEmptyString', 'boolean'],
  'bridge-begin-pairing': ['optionalString'],
  'bridge-list-paired-devices': [],
  'bridge-unpair-device': ['nonEmptyString'],
  // Attached-window picker — all three handlers are no-arg; pick reads
  // the daemon's response, detach/status read main-side state. The
  // daemon-side validation (handleID format etc.) lives in the Swift
  // dispatcher's Decodable params.
  'attach-window:pick': [],
  'attach-window:detach': [],
  'attach-window:status': [],
  // M11 (1.0.7) — sticky AppWatch per-chat attachment snapshots.
  'sticky-appwatch:get': ['chatId'],
  'sticky-appwatch:stash': ['object'],
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
    (spec === 'workspacePath' || spec === 'filePath' || spec === 'runId' || spec === 'chatId') &&
    (typeof value !== 'string' || !value.trim())
  )
    throw new Error(`${label} must be a non-empty string.`)
  if (spec === 'chatId') assertSafeChatId(value, label)
  if (spec === 'workspacePath' && !/^([/\\~]|[A-Za-z]:[\\/])/.test(value as string))
    throw new Error(`${label} must be an absolute workspace path.`)
  if (spec === 'filePath' && /\0/.test(value as string))
    throw new Error(`${label} must not contain null bytes.`)
  if (
    (spec === 'number' || spec === 'optionalNumber') &&
    (typeof value !== 'number' || !Number.isFinite(value))
  )
    throw new Error(`${label} must be a finite number.`)
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
  schema.forEach((spec, index) => validateArg(channel, spec, args[index], index))
  return args
}

export function installIpcValidation(ipcMain: IpcMain): void {
  const target = ipcMain as IpcMain & { __agentBenchValidationInstalled?: boolean }
  if (target.__agentBenchValidationInstalled) return
  const originalHandle = ipcMain.handle.bind(ipcMain)
  ;(target as any).handle = (channel: string, listener: any) => {
    return originalHandle(channel, (event, ...args) =>
      listener(event, ...validateIpcArgs(channel, args))
    )
  }
  target.__agentBenchValidationInstalled = true
}
