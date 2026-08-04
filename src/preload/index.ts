import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  GeminiWorktreeLaunchOption,
  BlackboardEntry,
  ChatRecord,
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  ProviderId,
  AgenticWorkspaceGrantProviderId,
  RunAnalystRequest,
  RunAnalystSnapshot,
  CloseoutSummaryRequest,
  CloseoutSummarySnapshot,
  ContinuationProposalRequest,
  ContinuationProposalSnapshot,
  CapabilityLedgerSnapshot,
  EvidencePackRecord,
  RepoConventionIndexSnapshot,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition,
  WorkspaceActivitySnapshot,
  ScheduledTaskCreateInput,
  ScheduledTaskLifecycleUpdate,
  WorkflowDefinitionCreateInput,
  WorkflowDefinitionRendererUpdate
} from '../main/store/types'
import type { PendingEnsembleRosterPresetApply } from '../main/EnsembleRosterPresetApply'
import type { EnsembleUserRosterMutationInput } from '../main/EnsembleUserRosterMutation'
import type { EnsembleUserRosterMutationResult } from '../main/services/EnsembleOrchestrator'
import type { AppShellStatsSnapshot } from '../main/services/AppShellStatsService'
import type { SessionCheckpointRecord } from '../main/checkpoints/SessionCheckpoint'
import type {
  DiscordContextSelection,
  DiscordContextSnapshot
} from '../main/channels/DiscordContextService'
import type {
  GitCiStatusSummary,
  GitPrReadiness,
  GitPrSummary,
  GitRepositorySnapshot,
  GitResult
} from '../main/services/GitService'
import type { GitWorkspaceStats } from '../main/services/GitWorkspaceStats'
import type { WorkProvenanceSnapshot } from '../shared/workProvenance'
import type {
  GitSnapshotChangedPayload,
  GitSnapshotInvalidationReason,
  GitSnapshotSubscribeResult
} from '../main/services/GitSnapshotPublisher'
import type {
  FallbackPromotedSteerInput,
  FallbackPromotedSteerJobResult,
  LeasePromotedSteerInput,
  LeasePromotedSteerJobResult,
  PromoteQueuedJobForSteerInput,
  PromoteQueuedJobForSteerResult
} from '../main/services/RunLifecycleCoordinator'
import { createAntigravityGeminiApiSecretBridge } from './antigravityGeminiApiSecretContract'
import { createPiKeyBridge } from './piKeyContract'
import type {
  ExecutionGraphLayout,
  ExecutionGraphRevision
} from '../main/executionGraph/ExecutionGraphModel'
import type {
  ExecutionRunEvent,
  ExecutionRunProjection
} from '../main/executionGraph/ExecutionGraphRun'
import type { ExecutionGraphChangedNotice } from '../main/services/ExecutionGraphCoordinator'
import type {
  ExecutionGraphDiagnosticsSnapshot,
  ExecutionRunCancelStepCommand,
  ExecutionRunFormalizeCommand,
  ExecutionRunListFilter,
  ExecutionStackAppendCommand
} from '../main/ipc/executionGraphHandlers'
import type {
  TaskWraithPluginCatalogSnapshot,
  TaskWraithPluginActivationSnapshot,
  TaskWraithPluginContributionSnapshot,
  TaskWraithPluginMcpPresetMaterializationResult,
  TaskWraithPluginSecretMutationResult,
  TaskWraithPluginSecretStatusSnapshot
} from '../shared/plugins/PluginTypes'
import type { ContextCompactionProgressEvent } from '../shared/contextCompaction'
import type { WatchPollProgress } from '../shared/watchPrPollCycle'
import type { WatchPrNotifyPayload } from '../main/services/WatchPrPoller'
import type { ParticipantWorkingTelemetryEvent } from '../shared/participantWorkingTelemetry'
import type {
  LicenseNoticeKind,
  LicenseNoticeStatus,
  OpenLicenseNoticeResult
} from '../shared/licenseNotices'
import type {
  NativeWindowCoordinatorPickResult,
  NativeWindowCoordinatorRendererEvent,
  NativeWindowCoordinatorRendererStatus
} from '../main/nativeWindow/NativeWindowCoordinator'
import {
  CHAT_UPDATE_ACK_CHANNEL,
  type ChatUpdateAck,
  type ChatUpdateDelivery
} from '../shared/chatUpdateTransport'
import {
  workLockProjectionUpdateIsStale,
  type WorkLockProjectionChangedEvent,
  type WorkLockProjectionQuery,
  type WorkLockProjectionSnapshot,
  type WorkLockProjectionSubscribeResult,
  type WorkLockProjectionUpdate,
  type WorkLockRecoveryRequest,
  type WorkLockRecoveryResult
} from '../shared/workLockProjection'
import type {
  ChatPopoutRoundExpansionSnapshot,
  ChatPopoutScrollState
} from '../shared/chatPopoutTransfer'
import {
  SerializedChatPersistence,
  type CanonicalChatSaveResult
} from './SerializedChatPersistence'

type ComposerImageAttachment = {
  id?: string
  path?: string
  name?: string
}

const CLIPBOARD_PASTE_INTENT_TTL_MS = 1_500
let pendingClipboardPasteIntent: { token: string; expiresAt: number } | null = null

// Only the isolated preload observes the real DOM event and keeps the opaque
// token. Renderer code can request an image save, but cannot mint or read the
// proof required by main to touch the host clipboard.
window.addEventListener(
  'paste',
  (event) => {
    if (!event.isTrusted) return
    const containsImage = Array.from(event.clipboardData?.items || []).some((item) =>
      item.type.startsWith('image/')
    )
    if (!containsImage) return
    // Sandboxed preloads cannot require Node's `crypto` module. Chromium's
    // Web Crypto implementation is available in this isolated world; fail
    // closed if a future runtime ever removes it rather than minting a weak
    // clipboard capability token.
    const token = globalThis.crypto?.randomUUID?.()
    if (!token) return
    pendingClipboardPasteIntent = {
      token,
      expiresAt: Date.now() + CLIPBOARD_PASTE_INTENT_TTL_MS
    }
    ipcRenderer.send('authorize-clipboard-paste-intent', token)
  },
  true
)

async function saveClipboardImageAttachmentFromTrustedPaste(appChatId: string): Promise<string[]> {
  const intent = pendingClipboardPasteIntent
  pendingClipboardPasteIntent = null
  if (!intent || Date.now() > intent.expiresAt) return []
  return ipcRenderer.invoke('save-clipboard-image-attachment', appChatId, intent.token)
}

const serializedChatPersistence = new SerializedChatPersistence(
  (chat) => ipcRenderer.invoke('save-chat', chat) as Promise<CanonicalChatSaveResult>
)

type NativeWindowRendererVerb = 'observe' | 'inspect' | 'click' | 'fill'
type NativeWindowRendererStreaming = NonNullable<
  NonNullable<NativeWindowCoordinatorRendererStatus['observation']>['streaming']
>
type StickyAppWatchWindowMeta = Readonly<{
  title: string
  bundleID: string
  applicationName: string
}>
type StickyAppWatchSnapshot = Readonly<{
  chatId: string
  windowMeta: StickyAppWatchWindowMeta
  attachedAt: string
  stashedAt: string
  wasStreaming: boolean
}>
type StickyAppWatchStashInput = Readonly<{
  chatId: string
  windowMeta: StickyAppWatchWindowMeta
  attachedAt: string
  wasStreaming: boolean
}>

function nativeWindowRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function nativeWindowString(value: unknown, maximum: number, required = false): string | null {
  if (typeof value !== 'string' || value.length > maximum) return null
  if (required && !value.trim()) return null
  return value
}

function nativeWindowPositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

function nativeWindowNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function nativeWindowFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nativeWindowStreaming(value: unknown): NativeWindowRendererStreaming | null {
  const input = nativeWindowRecord(value)
  if (!input) return null
  const fps = nativeWindowFiniteNumber(input.fps)
  const bufferSeconds = nativeWindowFiniteNumber(input.bufferSeconds)
  const frameCount = nativeWindowNonNegativeInteger(input.frameCount)
  const startedAt = nativeWindowString(input.startedAt, 128, true)
  if (
    fps === null ||
    fps <= 0 ||
    bufferSeconds === null ||
    bufferSeconds <= 0 ||
    frameCount === null ||
    startedAt === null
  ) {
    return null
  }
  return Object.freeze({ fps, bufferSeconds, frameCount, startedAt })
}

function nativeWindowObservation(
  value: unknown
): NativeWindowCoordinatorRendererStatus['observation'] | null | undefined {
  if (value === null) return null
  const input = nativeWindowRecord(value)
  if (!input) return undefined
  const chatId = nativeWindowString(input.chatId, 512, true)
  const generation = nativeWindowPositiveInteger(input.generation)
  const attachedAt = nativeWindowString(input.attachedAt, 128, true)
  const window = nativeWindowRecord(input.window)
  if (!chatId || generation === null || !attachedAt || !window) return undefined
  const title = nativeWindowString(window.title, 4_096)
  const bundleID = nativeWindowString(window.bundleID, 512)
  const applicationName = nativeWindowString(window.applicationName, 512)
  const identityQuality = window.identityQuality
  if (
    title === null ||
    bundleID === null ||
    applicationName === null ||
    (identityQuality !== 'exact' && identityQuality !== 'bestEffort')
  ) {
    return undefined
  }
  let streaming: NativeWindowRendererStreaming | undefined
  if (input.streaming !== undefined) {
    const decodedStreaming = nativeWindowStreaming(input.streaming)
    if (!decodedStreaming) return undefined
    streaming = decodedStreaming
  }
  return Object.freeze({
    chatId,
    generation,
    attachedAt,
    window: Object.freeze({ title, bundleID, applicationName, identityQuality }),
    ...(streaming ? { streaming } : {})
  })
}
function nativeWindowVirtualCursor(
  value: unknown
): NonNullable<NativeWindowCoordinatorRendererStatus['control']>['virtualCursor'] | undefined {
  if (value === null) return null
  const input = nativeWindowRecord(value)
  if (!input) return undefined
  const x = nativeWindowFiniteNumber(input.x)
  const y = nativeWindowFiniteNumber(input.y)
  const label = nativeWindowString(input.label, 300, true)
  const verb = input.verb
  if (
    x === null ||
    y === null ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1 ||
    label === null ||
    (verb !== 'click' && verb !== 'fill')
  ) {
    return undefined
  }
  return Object.freeze({
    x,
    y,
    label,
    verb
  })
}

function nativeWindowControl(
  value: unknown
): NativeWindowCoordinatorRendererStatus['control'] | null | undefined {
  if (value === null) return null
  const input = nativeWindowRecord(value)
  if (!input) return undefined
  const chatId = nativeWindowString(input.chatId, 512, true)
  const runId = nativeWindowString(input.runId, 512, true)
  const provider = nativeWindowString(input.provider, 128, true)
  const launchAttemptId = nativeWindowString(input.launchAttemptId, 512, true)
  const participantId = input.participantId
  const approvedAt = nativeWindowFiniteNumber(input.approvedAt)
  const expiresAt = nativeWindowFiniteNumber(input.expiresAt)
  const stepBudget = nativeWindowPositiveInteger(input.stepBudget)
  const stepsUsed =
    Number.isSafeInteger(input.stepsUsed) && Number(input.stepsUsed) >= 0
      ? Number(input.stepsUsed)
      : null
  const stepsRemaining =
    Number.isSafeInteger(input.stepsRemaining) && Number(input.stepsRemaining) >= 0
      ? Number(input.stepsRemaining)
      : null
  const allowedVerbsInput = input.allowedVerbs
  const lifecycle = input.lifecycle
  const virtualCursor = nativeWindowVirtualCursor(input.virtualCursor)
  if (
    !chatId ||
    !runId ||
    !provider ||
    !launchAttemptId ||
    (participantId !== null && typeof participantId !== 'string') ||
    approvedAt === null ||
    expiresAt === null ||
    stepBudget === null ||
    stepsUsed === null ||
    stepsRemaining === null ||
    input.approvedBy !== 'user' ||
    input.trustState !== 'user-approved' ||
    input.mode !== 'foreground' ||
    (lifecycle !== 'active' && lifecycle !== 'paused' && lifecycle !== 'takeover') ||
    typeof input.canAdmitActions !== 'boolean' ||
    virtualCursor === undefined ||
    !Array.isArray(allowedVerbsInput) ||
    allowedVerbsInput.some(
      (verb) => verb !== 'observe' && verb !== 'inspect' && verb !== 'click' && verb !== 'fill'
    )
  ) {
    return undefined
  }
  const allowedVerbs = allowedVerbsInput as NativeWindowRendererVerb[]
  return Object.freeze({
    chatId,
    runId,
    provider,
    participantId,
    launchAttemptId,
    approvedAt,
    approvedBy: 'user' as const,
    trustState: 'user-approved' as const,
    allowedVerbs: Object.freeze([...allowedVerbs]),
    expiresAt,
    stepBudget,
    stepsUsed,
    stepsRemaining,
    mode: 'foreground' as const,
    lifecycle,
    canAdmitActions: input.canAdmitActions,
    virtualCursor
  })
}

function decodeNativeWindowRendererEvent(
  value: unknown
): NativeWindowCoordinatorRendererEvent | null {
  const input = nativeWindowRecord(value)
  if (!input) return null
  const chatId = nativeWindowString(input.chatId, 512, true)
  const statusInput = nativeWindowRecord(input.status)
  if (!chatId || !statusInput || typeof statusInput.pickerPending !== 'boolean') return null
  const observation = nativeWindowObservation(statusInput.observation)
  const control = nativeWindowControl(statusInput.control)
  const statusWarning =
    statusInput.warning === undefined ? undefined : nativeWindowString(statusInput.warning, 4_096)
  const eventWarning =
    input.warning === undefined ? undefined : nativeWindowString(input.warning, 4_096)
  if (
    observation === undefined ||
    control === undefined ||
    (observation && observation.chatId !== chatId) ||
    (control && control.chatId !== chatId) ||
    (statusInput.warning !== undefined && statusWarning === null) ||
    (input.warning !== undefined && eventWarning === null)
  ) {
    return null
  }
  return Object.freeze({
    chatId,
    status: Object.freeze({
      pickerPending: statusInput.pickerPending,
      observation,
      control,
      ...(statusWarning ? { warning: statusWarning } : {})
    }),
    ...(eventWarning ? { warning: eventWarning } : {})
  })
}

function stickyAppWatchWindowMeta(value: unknown): StickyAppWatchWindowMeta | null {
  const input = nativeWindowRecord(value)
  if (!input) return null
  const title = nativeWindowString(input.title, 4_096)
  const bundleID = nativeWindowString(input.bundleID, 512)
  const applicationName = nativeWindowString(input.applicationName, 512)
  if (title === null || bundleID === null || applicationName === null) return null
  return Object.freeze({ title, bundleID, applicationName })
}

function stickyAppWatchSnapshot(value: unknown): StickyAppWatchSnapshot | null {
  const input = nativeWindowRecord(value)
  if (!input) return null
  const chatId = nativeWindowString(input.chatId, 512, true)
  const windowMeta = stickyAppWatchWindowMeta(input.windowMeta)
  const attachedAt = nativeWindowString(input.attachedAt, 128, true)
  const stashedAt = nativeWindowString(input.stashedAt, 128, true)
  if (
    !chatId ||
    !windowMeta ||
    !attachedAt ||
    !stashedAt ||
    typeof input.wasStreaming !== 'boolean'
  ) {
    return null
  }
  return Object.freeze({
    chatId,
    windowMeta,
    attachedAt,
    stashedAt,
    wasStreaming: input.wasStreaming
  })
}

function stickyAppWatchStashInput(value: unknown): StickyAppWatchStashInput | null {
  const input = nativeWindowRecord(value)
  if (!input) return null
  const chatId = nativeWindowString(input.chatId, 512, true)
  const windowMeta = stickyAppWatchWindowMeta(input.windowMeta)
  const attachedAt = nativeWindowString(input.attachedAt, 128, true)
  if (!chatId || !windowMeta || !attachedAt || typeof input.wasStreaming !== 'boolean') return null
  return Object.freeze({ chatId, windowMeta, attachedAt, wasStreaming: input.wasStreaming })
}

function stickyAppWatchChatId(value: unknown): string {
  const chatId = nativeWindowString(value, 512, true)
  if (!chatId) throw new Error('A canonical chat id is required for Sticky AppWatch.')
  return chatId
}

function stickyAppWatchOk(value: unknown): { ok: boolean } {
  return Object.freeze({ ok: nativeWindowRecord(value)?.ok === true })
}

// Custom APIs for renderer
const api = {
  hostPlatform: process.platform,
  getRuntimeVersions: () => ({ ...(process?.versions || {}) }),
  selectWorkspace: () => ipcRenderer.invoke('select-workspace'),
  selectImageFiles: () => ipcRenderer.invoke('select-image-files'),
  // Electron 32+ removed `File.path`, so a dragged/pasted file's absolute path
  // can only be resolved via webUtils.getPathForFile (which must run in the
  // preload). The renderer's drop/paste collectors call this to restore
  // drag-and-drop attach that regressed on the Electron 39 upgrade. Param type
  // is derived from Electron's own signature so it needs no DOM lib here.
  getPathForFile: (file: Parameters<typeof webUtils.getPathForFile>[0]): string => {
    const filePath = webUtils.getPathForFile(file)
    if (filePath) {
      // The renderer can request authorization only through this preload-owned
      // File capability. It cannot mint an arbitrary local path for a detached
      // chat now that the generic invoke channel is main-renderer-only.
      ipcRenderer.send('authorize-dropped-attachment', filePath)
    }
    return filePath
  },
  saveClipboardImageAttachment: saveClipboardImageAttachmentFromTrustedPaste,
  readImagePreview: (path: string) => ipcRenderer.invoke('read-image-preview', path),
  transcribeComposerAudio: (input: { localeIdentifier?: string; wav: ArrayBuffer }) =>
    ipcRenderer.invoke('composer-audio:transcribe', input) as Promise<
      | {
          ok: true
          text: string
          segments: Array<{ text: string; startMs: number; endMs: number; confidence: number }>
          localeIdentifier: string
          onDevice: boolean
        }
      | { ok: false; error: string }
    >,
  imageGenerationGetStatus: () => ipcRenderer.invoke('image-generation:get-status'),
  imageGenerationSetEnabled: (input: { enabled: boolean; provider?: 'openai' | 'xai' }) =>
    ipcRenderer.invoke('image-generation:set-enabled', input),
  imageGenerationSetKey: (input: { provider: 'openai' | 'xai'; key: string }) =>
    ipcRenderer.invoke('image-generation:set-key', input),
  imageGenerationClearKey: (input: { provider: 'openai' | 'xai' }) =>
    ipcRenderer.invoke('image-generation:clear-key', input),
  getLastSpellcheckContext: (point: { x: number; y: number }) =>
    ipcRenderer.invoke('spellcheck:get-last-context', point),
  replaceMisspelling: (payload: { suggestion: string; point: { x: number; y: number } }) =>
    ipcRenderer.invoke('spellcheck:replace-misspelling', payload),
  addWordToSpellCheckerDictionary: (payload: { point: { x: number; y: number } }) =>
    ipcRenderer.invoke('spellcheck:add-word-to-dictionary', payload),
  onSpellcheckContextMenu: (
    callback: (payload: {
      point: { x: number; y: number }
      spellcheckContext: {
        x: number
        y: number
        misspelledWord: string
        dictionarySuggestions: string[]
        createdAt: number
      } | null
    }) => void
  ) => {
    const wrapped = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload)
    ipcRenderer.on('spellcheck:context-menu', wrapped)
    return () => ipcRenderer.removeListener('spellcheck:context-menu', wrapped)
  },
  sidebarShowWorkspaceInFinder: (workspaceId: string) =>
    ipcRenderer.invoke('sidebar:show-workspace-in-finder', workspaceId),
  sidebarCopyWorkspaceDirectory: (workspaceId: string) =>
    ipcRenderer.invoke('sidebar:copy-workspace-directory', workspaceId),
  sidebarShowChatWorkspaceInFinder: (chatId: string) =>
    ipcRenderer.invoke('sidebar:show-chat-workspace-in-finder', chatId),
  sidebarCopyChatWorkingDirectory: (chatId: string) =>
    ipcRenderer.invoke('sidebar:copy-chat-working-directory', chatId),
  sidebarCopyChatTranscriptPath: (chatId: string) =>
    ipcRenderer.invoke('sidebar:copy-chat-transcript-path', chatId),
  copyChatMarkdownTranscript: (chatId: string) =>
    ipcRenderer.invoke('copy-chat-markdown-transcript', chatId),
  copyChatMessages: (chatId: string) => ipcRenderer.invoke('copy-chat-messages', chatId),
  // Phase J1 (composer unification): the picker is now cross-provider —
  // optional `provider` argument so the main process can stamp the
  // grant with the requesting provider (defaults to 'codex' for
  // back-compat with prior renderers that only sent `access`).
  selectExternalPathGrant: (access: 'read' | 'write' = 'read', provider?: string) =>
    ipcRenderer.invoke('select-external-path-grant', access, provider),
  /**
   * 1.0.5-EW42a — Proactive external-path grant from the composer's
   * workspace switcher. Opens an OS folder picker, then for each
   * unique participant-provider on the chat (or the chat's primary
   * provider for single-provider chats) issues an
   * `ExternalPathGrant` and persists it to the chat's metadata.
   * Broadcasts the updated chat so the renderer's
   * `ExternalPathAboveRow` banner appears immediately.
   *
   * Returns `{ ok: true, grants, path }` on success;
   * `{ ok: false, reason }` for the empty / cancelled / no-chat /
   * no-window cases. The renderer doesn't need the grants payload
   * (the chat-updated event re-renders everything) but it's
   * returned in case a caller wants to surface a toast like
   * "Granted read access to <basename>".
   */
  pickAndPersistExternalPathGrant: (payload: {
    chatId: string
    access?: 'read' | 'write'
    // 1.0.6-EW69 — optional explicit path: when supplied, main skips the
    // OS folder dialog and grants this exact path (composer picker's
    // "attach a known workspace as a secondary" action).
    path?: string
    deferPersist?: boolean
    selectionReceipt?: string
  }): Promise<
    | { ok: true; grants: unknown[]; path: string; selectionReceipt?: string }
    | { ok: false; reason: 'no-chat' | 'cancelled' | 'no-provider' | 'no-window' }
    | { ok: false; reason: 'missing-path'; path: string }
  > => ipcRenderer.invoke('external-path:pick-and-persist', payload),
  revokeExternalPathGrants: (payload: {
    chatId: string
    grantIds: string[]
  }): Promise<
    | { ok: true; grants: unknown[]; revokedGrantIds: string[] }
    | { ok: false; reason: 'no-chat' | 'no-grants' }
  > => ipcRenderer.invoke('external-path:revoke', payload),
  /**
   * Slice 1 of the external-path-redesign arc. Renderer asks main to
   * look at an absolute path and report whether it's a git repo (and
   * what branch is checked out). Used by the new stacked above-rows
   * to label each external-path grant. Returns
   *   { isRepo: true, repoRoot, branch? }
   * for repos, or null when the path doesn't exist / isn't a repo.
   */
  probeExternalPath: (absolutePath: string) =>
    ipcRenderer.invoke('probe-external-path', absolutePath) as Promise<{
      isRepo: boolean
      repoRoot: string
      branch?: string
    } | null>,
  runGemini: (
    workspace: string,
    prompt: string,
    model: string,
    approvalMode: string,
    sessionTrust: boolean = false,
    imagePaths: string[] = [],
    resumeSessionId: string | null = null,
    worktree: GeminiWorktreeLaunchOption = null,
    route: any = null
  ) =>
    ipcRenderer.invoke(
      'run-gemini',
      workspace,
      prompt,
      model,
      approvalMode,
      sessionTrust,
      imagePaths,
      resumeSessionId,
      worktree,
      route
    ),
  cancelGemini: (runId?: string) => ipcRenderer.invoke('cancel-gemini', runId),
  composeRun: (input: any) => ipcRenderer.invoke('compose-run', input),
  runAgent: (payload: any) => ipcRenderer.invoke('run-agent', payload),
  cancelAgentRun: (provider: ProviderId = 'gemini', runId?: string) =>
    ipcRenderer.invoke('cancel-agent-run', provider, runId),
  getAgentStatus: (provider: ProviderId, options?: { refreshAuth?: boolean }) =>
    ipcRenderer.invoke('get-agent-status', provider, options),
  getProviderCapabilities: (provider: ProviderId, workspace?: string, approvalMode?: string) =>
    ipcRenderer.invoke('get-provider-capabilities', provider, workspace, approvalMode),
  getProviderAdapters: () => ipcRenderer.invoke('get-provider-adapters'),
  getConfiguredProviderSnapshot: () =>
    ipcRenderer.invoke('get-configured-provider-snapshot') as Promise<{
      ready: boolean
      providerIds: ProviderId[]
    }>,
  // 1.0.5-EW35 — Currency sub-slice (c): live FX rate snapshot.
  // Renderer hydrates `formatCost`'s in-memory rate table from this
  // on app boot. `refreshFxRates` is reserved for a future explicit
  // "refresh now" button; not wired into any UI yet.
  getFxRates: () =>
    ipcRenderer.invoke('fx-rates:get') as Promise<{
      rates: { USD: 1; GBP: number; EUR: number }
      fetchedAt: string
      source: 'live' | 'cached' | 'fallback'
      errorMessage?: string
    }>,
  refreshFxRates: (force?: boolean) =>
    ipcRenderer.invoke('fx-rates:refresh', force) as Promise<{
      rates: { USD: 1; GBP: number; EUR: number }
      fetchedAt: string
      source: 'live' | 'cached' | 'fallback'
      errorMessage?: string
    }>,
  // 1.0.5-EW38 — Currency sub-slice (d): per-provider rate
  // snapshot. The renderer can read this for future cost-estimation
  // features (pre-flight estimate, per-model price comparison) —
  // not surfaced in any UI yet in 1.0.5. The `probe` field surfaces
  // last best-effort scrape results so a settings UI can warn
  // about possible drift.
  getProviderRates: () => ipcRenderer.invoke('providerRates:get'),
  probeProviderRates: () => ipcRenderer.invoke('providerRates:probe'),
  getAgentModels: (provider: ProviderId) => ipcRenderer.invoke('get-agent-models', provider),
  getAgentRateLimits: (provider: ProviderId, options?: { force?: boolean }) =>
    ipcRenderer.invoke('get-agent-rate-limits', provider, options),
  importCodexUsageCredential: (filePath?: string) =>
    ipcRenderer.invoke('import-codex-usage-credential', filePath),
  clearCodexUsageCredential: () => ipcRenderer.invoke('clear-codex-usage-credential'),
  getCodexUsageSnapshot: (options?: { force?: boolean }) =>
    ipcRenderer.invoke('get-codex-usage-snapshot', options),
  getExternalUsage: (options?: { force?: boolean }) =>
    ipcRenderer.invoke('get-external-usage', options),
  getQuotaSnapshotHook: () => ipcRenderer.invoke('quota-snapshot-hook:get'),
  probeGrokUsage: () => ipcRenderer.invoke('grok-usage:probe'),
  // Mistral's estimated monthly burn. Not a probe and not a vendor figure:
  // Mistral publishes no quota and exposes no usage endpoint, so this reads the
  // locally accumulated cycle. Resolves null until the seat has actually been
  // run, which is what gates the sidebar meter.
  getMistralQuotaEstimate: () => ipcRenderer.invoke('mistral-quota:get'),
  setMistralPlan: (plan: string) => ipcRenderer.invoke('mistral-quota:set-plan', plan),
  // Amounts are USD. The renderer converts from the console's currency using its
  // own live FX table before this crosses IPC, so the main-process model never
  // has to do currency maths — see MistralQuotaEstimate.ts's purity note.
  setMistralQuotaAnchor: (reading: {
    allowanceUsd: number
    spentUsd: number
    cycleResetsAt?: string
    declared?: { allowance: number; spent: number; currency: string }
  }) => ipcRenderer.invoke('mistral-quota:set-anchor', reading),
  clearMistralQuotaAnchor: () => ipcRenderer.invoke('mistral-quota:clear-anchor'),
  // Admin API key: write-only from the renderer's side. The status projection
  // carries a configured boolean and a timestamp, never the key or its bytes.
  getMistralAdminKeyStatus: () => ipcRenderer.invoke('mistral-admin-key:status'),
  setMistralAdminKey: (apiKey: string) => ipcRenderer.invoke('mistral-admin-key:set', apiKey),
  clearMistralAdminKey: () => ipcRenderer.invoke('mistral-admin-key:clear'),
  refreshMistralAdminUsage: () => ipcRenderer.invoke('mistral-quota:refresh-admin'),
  gitSnapshot: (payload: { workspacePath?: string; repoPath?: string; chatId?: string }) =>
    ipcRenderer.invoke('git:snapshot', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitWorkspaceStats: (payload: {
    workspacePath?: string
    repoPath?: string
    worktreePath?: string
    chatId?: string
  }) => ipcRenderer.invoke('git:workspace-stats', payload) as Promise<GitResult<GitWorkspaceStats>>,
  gitWorkProvenance: (payload: {
    workspacePath?: string
    repoPath?: string
    worktreePath?: string
    chatId?: string
  }) =>
    ipcRenderer.invoke('git:work-provenance', payload) as Promise<
      GitResult<WorkProvenanceSnapshot>
    >,
  gitSubscribeSnapshot: (
    payload: { workspacePath?: string; repoPath?: string; chatId?: string },
    callback: (payload: GitSnapshotChangedPayload) => void
  ) => {
    const subscriptionId =
      globalThis.crypto?.randomUUID?.() ||
      `git-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let active = true
    const wrapped = (_event: unknown, update: GitSnapshotChangedPayload): void => {
      if (update?.subscriptionId === subscriptionId) callback(update)
    }
    ipcRenderer.on('git:snapshot-changed', wrapped)
    void ipcRenderer
      .invoke('git:subscribe-snapshot', { ...payload, subscriptionId })
      .then((result: GitSnapshotSubscribeResult) => {
        if (!active || !result?.ok) return
        callback({
          subscriptionId,
          requestedPath: result.data.requestedPath,
          repoRoot: result.data.repoRoot,
          snapshot: result.data.snapshot,
          generation: result.data.generation,
          reason: 'subscribe'
        })
      })
      .catch(() => {})
    return () => {
      active = false
      ipcRenderer.removeListener('git:snapshot-changed', wrapped)
      void ipcRenderer.invoke('git:unsubscribe-snapshot', { subscriptionId }).catch(() => {})
    }
  },
  listWorkLocks: (query: WorkLockProjectionQuery = {}) =>
    ipcRenderer.invoke('work-locks:list', query) as Promise<WorkLockProjectionSnapshot>,
  forceReleaseRecoveryBlockedWorkLock: (request: WorkLockRecoveryRequest) =>
    ipcRenderer.invoke(
      'work-locks:force-release-recovery',
      request
    ) as Promise<WorkLockRecoveryResult>,
  subscribeWorkLocks: (
    query: WorkLockProjectionQuery,
    callback: (update: WorkLockProjectionUpdate) => void
  ) => {
    const subscriptionId =
      globalThis.crypto?.randomUUID?.() ||
      `work-locks-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let active = true
    let latestGeneration = -1
    const deliver = (update: WorkLockProjectionUpdate): void => {
      if (
        !active ||
        workLockProjectionUpdateIsStale(latestGeneration, update.snapshot.generation)
      ) {
        return
      }
      latestGeneration = update.snapshot.generation
      callback(update)
    }
    const wrapped = (_event: unknown, update: WorkLockProjectionChangedEvent): void => {
      if (update?.subscriptionId !== subscriptionId) return
      deliver({ reason: update.reason, snapshot: update.snapshot })
    }
    ipcRenderer.on('work-locks:changed', wrapped)
    void ipcRenderer
      .invoke('work-locks:subscribe', { ...query, subscriptionId })
      .then((result: WorkLockProjectionSubscribeResult) => {
        if (!active || !result?.ok) return
        deliver({ reason: 'initial', snapshot: result.data.snapshot })
      })
      .catch(() => {})
    return () => {
      active = false
      ipcRenderer.removeListener('work-locks:changed', wrapped)
      void ipcRenderer.invoke('work-locks:unsubscribe', { subscriptionId }).catch(() => {})
    }
  },
  gitInvalidateSnapshot: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    reason?: GitSnapshotInvalidationReason
  }) =>
    ipcRenderer.invoke('git:invalidate-snapshot', payload) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  gitStage: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    paths?: string[]
    all?: boolean
    update?: boolean
    patch?: string
  }) => ipcRenderer.invoke('git:stage', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitUnstage: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    paths?: string[]
  }) => ipcRenderer.invoke('git:unstage', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitCommit: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    message: string
  }) => ipcRenderer.invoke('git:commit', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  gitPush: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    setUpstream?: boolean
    remote?: string
  }) => ipcRenderer.invoke('git:push', payload) as Promise<GitResult<GitRepositorySnapshot>>,
  'git:list-branches': (payload: { workspacePath?: string; repoPath?: string; chatId?: string }) =>
    ipcRenderer.invoke('git:list-branches', payload),
  'git:checkout-branch': (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    branch?: string
  }) => ipcRenderer.invoke('git:checkout-branch', payload),
  'git:create-branch': (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    branch?: string
    from?: string
  }) => ipcRenderer.invoke('git:create-branch', payload),
  'git:list-worktrees': (payload: { workspacePath?: string; repoPath?: string; chatId?: string }) =>
    ipcRenderer.invoke('git:list-worktrees', payload),
  'git:create-worktree': (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    name?: string
    branch?: string
    path?: string
  }) => ipcRenderer.invoke('git:create-worktree', payload),
  'git:remove-worktree': (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    path?: string
    force?: boolean
  }) => ipcRenderer.invoke('git:remove-worktree', payload),
  'git:select-worktree': (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    path?: string
  }) => ipcRenderer.invoke('git:select-worktree', payload),
  listFanoutCandidates: (chatId: string) => ipcRenderer.invoke('fanout-candidates:list', chatId),
  fanoutCandidateDiff: (chatId: string, candidateId: string) =>
    ipcRenderer.invoke('fanout-candidates:diff', chatId, candidateId),
  promoteFanoutCandidate: (chatId: string, candidateId: string) =>
    ipcRenderer.invoke('fanout-candidates:promote', chatId, candidateId),
  discardFanoutCandidate: (chatId: string, candidateId: string) =>
    ipcRenderer.invoke('fanout-candidates:discard', chatId, candidateId),
  githubPrStatus: (payload: { workspacePath?: string; repoPath?: string; chatId?: string }) =>
    ipcRenderer.invoke('github:pr-status', payload) as Promise<GitResult<GitPrSummary>>,
  githubPrReadiness: (payload: { workspacePath?: string; repoPath?: string; chatId?: string }) =>
    ipcRenderer.invoke('github:pr-readiness', payload) as Promise<GitResult<GitPrReadiness>>,
  githubCiStatus: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    pr?: string | number
    branch?: string
    commitSha?: string
    includeFailedLogs?: boolean
    maxRuns?: number
    maxFailedLogs?: number
    maxLogChars?: number
  }) => ipcRenderer.invoke('github:ci-status', payload) as Promise<GitResult<GitCiStatusSummary>>,
  // Slice-6 "watch PR" (A1d): the per-chat toggle = the entire opt-in; the host
  // poller asks the renderer to post the thread notify and awaits this ack.
  githubSetWatchedPr: (payload: {
    chatId: string
    watchedPr: { workspacePath: string; owner: string; repo: string; prNumber: number } | null
  }) =>
    ipcRenderer.invoke('github:set-watched-pr', payload) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  githubWatchPrNotifyAck: (payload: {
    chatId: string
    signature: string
    ok: boolean
    error?: string
  }) => ipcRenderer.invoke('github:watch-pr-notify-ack', payload) as Promise<{ ok: true }>,
  // Per-thread git workflow marker (sidebar git icon + "Git" section). Main-owned
  // async patch; null clears the marker ("Remove from Git").
  setChatGitWorkflow: (payload: {
    chatId: string
    gitWorkflow: { state: string; prNumber?: number; prUrl?: string } | null
  }) =>
    ipcRenderer.invoke('set-chat-git-workflow', payload) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  onGitHubWatchPrNotify: (callback: (payload: WatchPrNotifyPayload) => void): (() => void) => {
    const wrapped = (_event: unknown, payload: WatchPrNotifyPayload): void => callback(payload)
    ipcRenderer.on('github:watch-pr-notify', wrapped)
    return () => ipcRenderer.removeListener('github:watch-pr-notify', wrapped)
  },
  onGitHubWatchPrProgress: (callback: (progress: WatchPollProgress) => void): (() => void) => {
    const wrapped = (_event: unknown, progress: WatchPollProgress): void => callback(progress)
    ipcRenderer.on('github:watch-pr-progress', wrapped)
    return () => ipcRenderer.removeListener('github:watch-pr-progress', wrapped)
  },
  createGithubPr: (payload: {
    workspacePath?: string
    repoPath?: string
    chatId?: string
    title?: string
    body?: string
    draft?: boolean
    openInBrowser?: boolean
  }) => ipcRenderer.invoke('create-github-pr', payload),
  getClaudeAuthStatus: () => ipcRenderer.invoke('get-claude-auth-status'),
  storeClaudeApiKey: (key: string) => ipcRenderer.invoke('store-claude-api-key', key),
  clearClaudeApiKey: () => ipcRenderer.invoke('clear-claude-api-key'),
  triggerClaudeLogin: () => ipcRenderer.invoke('trigger-claude-login'),
  getKimiAuthStatus: () => ipcRenderer.invoke('get-kimi-auth-status'),
  storeKimiApiKey: (key: string) => ipcRenderer.invoke('store-kimi-api-key', key),
  clearKimiApiKey: () => ipcRenderer.invoke('clear-kimi-api-key'),
  upgradeKimiCli: () => ipcRenderer.invoke('provider:open-upgrade-terminal', 'kimi'),
  getGeminiAuthStatus: () => ipcRenderer.invoke('get-gemini-auth-status'),
  listGeminiAuthProfiles: () => ipcRenderer.invoke('list-gemini-auth-profiles'),
  saveGeminiAuthProfile: (profile: any) => ipcRenderer.invoke('save-gemini-auth-profile', profile),
  deleteGeminiAuthProfile: (profileId: string) =>
    ipcRenderer.invoke('delete-gemini-auth-profile', profileId),
  setDefaultGeminiAuthProfile: (profileId: string | null) =>
    ipcRenderer.invoke('set-default-gemini-auth-profile', profileId),
  startGeminiOAuthLogin: (input?: any) => ipcRenderer.invoke('start-gemini-oauth-login', input),
  getGeminiOAuthLoginStatus: (profileId?: string | null) =>
    ipcRenderer.invoke('get-gemini-oauth-login-status', profileId),
  cancelGeminiOAuthLogin: (profileId?: string | null) =>
    ipcRenderer.invoke('cancel-gemini-oauth-login', profileId),
  getAgentMcpStatus: (provider: ProviderId) => ipcRenderer.invoke('get-agent-mcp-status', provider),
  listAgentThreads: (provider: ProviderId, params: any = {}) =>
    ipcRenderer.invoke('list-agent-threads', provider, params),
  'fork:get-capability': (provider: ProviderId) =>
    ipcRenderer.invoke('fork:get-capability', provider),
  forkAgentThread: (provider: ProviderId, threadId: string, params: any = {}) =>
    ipcRenderer.invoke('fork-agent-thread', provider, threadId, params),
  rollbackAgentThread: (provider: ProviderId, threadId: string, numTurns: number = 1) =>
    ipcRenderer.invoke('rollback-agent-thread', provider, threadId, numTurns),
  startAgentReview: (provider: ProviderId, threadId: string, params: any = {}) =>
    ipcRenderer.invoke('start-agent-review', provider, threadId, params),
  respondAgentApproval: (
    requestId: string,
    action:
      | 'accept'
      | 'acceptForSession'
      | 'acceptForWorkspace'
      | 'decline'
      | 'cancel'
      | 'grantExternalPathRead'
      | 'grantExternalPathEdit'
      | 'declineExternalPath',
    // Order-4 — optional one-line "why" note. Persisted onto the
    // approval-ledger row's metadata; never required.
    intentNote?: string
  ) => ipcRenderer.invoke('respond-agent-approval', requestId, action, intentNote),
  writeGeminiInput: (data: string) => ipcRenderer.invoke('write-gemini-input', data),
  getDiff: (workspace: string | { workspacePath?: string; repoPath?: string; chatId?: string }) =>
    ipcRenderer.invoke('get-diff', workspace),
  openWorkspacePopout: (
    input:
      | {
          kind: 'file-editor' | 'diff-studio' | 'workbench'
          workspacePath: string
          chatId?: string
          targetPath?: string
          targetView?: 'editor' | 'diff'
        }
      | { kind: 'chat'; chatId: string; workspacePath?: string }
  ) => ipcRenderer.invoke('open-workspace-popout', input) as Promise<{ ok: true }>,
  dockSideChatPopout: (input: {
    chatId: string
    presentation?: 'split' | 'drawer'
    draft?: string
    scrollState?: ChatPopoutScrollState
    roundExpansion?: ChatPopoutRoundExpansionSnapshot
  }) => ipcRenderer.invoke('dock-side-chat-popout', input) as Promise<{ ok: true }>,
  quitApp: () => ipcRenderer.invoke('app:quit') as Promise<boolean>,
  listWorkspaceFiles: (workspace: string) => ipcRenderer.invoke('list-workspace-files', workspace),
  listWorkspaceFilesForEditor: (
    workspace: string,
    options?: { path?: string; query?: string; includeDirectories?: boolean; limit?: number }
  ) => ipcRenderer.invoke('list-workspace-files-for-editor', workspace, options),
  readWorkspaceFile: (workspace: string, path: string) =>
    ipcRenderer.invoke('read-workspace-file', workspace, path),
  writeWorkspaceFile: (
    workspace: string,
    path: string,
    content: string,
    baseEtag?: string | null
  ) => ipcRenderer.invoke('write-workspace-file', workspace, path, content, baseEtag),
  deleteWorkspaceFile: (workspace: string, path: string, baseEtag?: string | null) =>
    ipcRenderer.invoke('delete-workspace-file', workspace, path, baseEtag),
  readOfficeDocument: (workspace: string, path: string) =>
    ipcRenderer.invoke('office:read-document', workspace, path),
  writeOfficeDocument: (
    workspace: string,
    path: string,
    model: unknown,
    baseEtag?: string | null
  ) => ipcRenderer.invoke('office:write-document', workspace, path, model, baseEtag),
  deleteOfficeDocument: (workspace: string, path: string, baseEtag?: string | null) =>
    ipcRenderer.invoke('office:delete-document', workspace, path, baseEtag),
  getOutlookStatus: () => ipcRenderer.invoke('outlook:status'),
  startOutlookSignIn: (payload: {
    clientId: string
    tenant?: string
    scopeMode?: 'read' | 'write'
  }) => ipcRenderer.invoke('outlook:start-sign-in', payload),
  pollOutlookSignIn: () => ipcRenderer.invoke('outlook:poll-sign-in'),
  disconnectOutlook: () => ipcRenderer.invoke('outlook:disconnect'),
  importOfficeDocument: (workspacePath: string, filePath: string, contentBase64: string) =>
    ipcRenderer.invoke('office:import-document', { workspacePath, filePath, contentBase64 }),
  revealOfficeDocument: (target: {
    workspacePath?: string
    filePath?: string
    chatId?: string
    path?: string
  }) => ipcRenderer.invoke('office:reveal-document', target),
  openOfficeDocumentInDefaultApp: (target: {
    workspacePath?: string
    filePath?: string
    chatId?: string
    path?: string
  }) => ipcRenderer.invoke('office:open-document-in-default-app', target),
  readExternalOfficeDocument: (chatId: string, path: string) =>
    ipcRenderer.invoke('office:read-external-document', { chatId, path }),
  writeExternalOfficeDocument: (
    chatId: string,
    path: string,
    model: unknown,
    baseEtag?: string | null
  ) => ipcRenderer.invoke('office:write-external-document', { chatId, path, model, baseEtag }),
  captureSnapshot: (workspace: string) => ipcRenderer.invoke('capture-snapshot', workspace),
  computeRunDiff: (runId: string, preSnapshot: any, postSnapshot: any, changeContext: any = null) =>
    ipcRenderer.invoke('compute-run-diff', runId, preSnapshot, postSnapshot, changeContext),
  getWorkspaceChangeSets: (filter: any = {}) =>
    ipcRenderer.invoke('get-workspace-change-sets', filter),
  getGeminiVersion: () => ipcRenderer.invoke('get-gemini-version'),
  getGeminiCapabilities: (workspace?: string) =>
    ipcRenderer.invoke('get-gemini-capabilities', workspace),
  getGeminiMcpBridgeStatus: () => ipcRenderer.invoke('get-gemini-mcp-bridge-status'),
  installGeminiMcpBridge: () => ipcRenderer.invoke('install-gemini-mcp-bridge'),
  setGeminiMcpBridgeEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-gemini-mcp-bridge-enabled', enabled),
  runApprovedHostCommand: (requestId: string) =>
    ipcRenderer.invoke('run-approved-host-command', requestId),
  listGeminiSessions: () => ipcRenderer.invoke('list-gemini-sessions'),
  getHostWeather: () => ipcRenderer.invoke('get-host-weather'),
  setAppearanceMode: (payload: { mode?: string; reduceTransparency?: boolean } | string) =>
    ipcRenderer.invoke('set-appearance-mode', payload),
  getNativeCapabilities: () =>
    ipcRenderer.invoke('native-capabilities:snapshot') as Promise<{
      platform: string
      arch: string
      osRelease: string
      macosVersion?: string
      bridge: { available: boolean; reason?: string }
      screenWatch: { available: boolean; reason?: string }
      appwatch: { available: boolean; reason?: string }
      ocr: { available: boolean; reason?: string }
      appleEvents: { available: boolean; reason?: string }
      appDrive: { available: boolean; reason?: string }
    }>,

  // Trust and PTY
  checkTrust: (workspacePath: string) => ipcRenderer.invoke('check-trust', workspacePath),
  // One-click persistent workspace trust — writes ~/.gemini/trustedFolders.json (#272).
  trustWorkspace: (workspacePath: string) => ipcRenderer.invoke('trust-workspace', workspacePath),

  // Legacy process-wide YOLO state. Enabling is blocked in main; the read/stop
  // surface remains for old windows and remote-control compatibility.
  agenticYoloGet: () =>
    ipcRenderer.invoke('agentic-yolo-get') as Promise<{
      enabled: boolean
      enabledAt: string | null
    }>,
  agenticYoloSet: (enabled: boolean) =>
    ipcRenderer.invoke('agentic-yolo-set', enabled) as Promise<{
      enabled: boolean
      enabledAt: string | null
    }>,
  onAgenticYoloState: (
    handler: (state: { enabled: boolean; enabledAt: string | null }) => void
  ) => {
    const wrapped = (_event: unknown, state: { enabled: boolean; enabledAt: string | null }) =>
      handler(state)
    ipcRenderer.on('agentic-yolo-state', wrapped)
    return () => ipcRenderer.removeListener('agentic-yolo-state', wrapped)
  },
  trustedSessionGet: (scope: {
    chatId: string
    provider: ProviderId
    workspacePath?: string | null
    ensembleParticipantId?: string | null
    ensembleLaneId?: string | null
    runtimeProfileId?: string | null
  }) => ipcRenderer.invoke('trusted-session-get', scope),
  trustedSessionSet: (
    scope: {
      chatId: string
      provider: ProviderId
      workspacePath?: string | null
      ensembleParticipantId?: string | null
      ensembleLaneId?: string | null
      runtimeProfileId?: string | null
    },
    enabled: boolean
  ) => ipcRenderer.invoke('trusted-session-set', scope, enabled),

  // TaskWraith Canvas renderer-pane (live-embed). The renderer opens an embedded
  // web canvas (a WebContentsView floated over its pane), streams the pane rect
  // via setBounds, and toggles visibility on occlusion. canvas-event is the same
  // audit-event broadcast the main process emits for every canvas action.
  canvas: {
    openWindow: (args: {
      url: string
      originAllowlist?: string[]
      chatId: string
    }): Promise<
      | {
          ok: true
          canvasId: string
          url: string
          title: string
          viewport: { width: number; height: number }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:open-window', args),
    openEmbedded: (args: {
      url: string
      originAllowlist?: string[]
      chatId: string
    }): Promise<
      | {
          ok: true
          canvasId: string
          url: string
          title: string
          viewport: { width: number; height: number }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:open-embedded', args),
    openSketchWindow: (args: {
      chatId: string
    }): Promise<
      | {
          ok: true
          canvasId: string
          url: string
          title: string
          viewport: { width: number; height: number }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:open-sketch-window', args),
    openSketchEmbedded: (args: {
      chatId: string
    }): Promise<
      | {
          ok: true
          canvasId: string
          url: string
          title: string
          viewport: { width: number; height: number }
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:open-sketch-embedded', args),
    // Chat-scoped list/close for the right-dock Canvas panel: covers agent-opened
    // canvases too (redacted summaries, no pixels), unlike `list` which only
    // returns canvases this renderer opened itself.
    listForChat: (chatId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('canvas:list-chat', chatId),
    closeForChat: (chatId: string, canvasId: string): Promise<void> =>
      ipcRenderer.invoke('canvas:close-chat', chatId, canvasId),
    // Browser chrome for the Canvas Browser: navigate any web canvas in the
    // sender's chat (address bar / back / forward / reload / stop).
    navigateForChat: (
      chatId: string,
      canvasId: string,
      input: { url?: string; action?: 'back' | 'forward' | 'reload' | 'stop' }
    ): Promise<
      | {
          ok: true
          url: string
          title: string
          isLoading: boolean
          canGoBack: boolean
          canGoForward: boolean
        }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('canvas:navigate-chat', chatId, canvasId, input),
    setBounds: (
      canvasId: string,
      rect: { x: number; y: number; width: number; height: number }
    ): Promise<void> => ipcRenderer.invoke('canvas:set-bounds', canvasId, rect),
    setVisible: (canvasId: string, visible: boolean): Promise<void> =>
      ipcRenderer.invoke('canvas:set-visible', canvasId, visible),
    close: (canvasId: string): Promise<void> => ipcRenderer.invoke('canvas:close', canvasId),
    list: (): Promise<unknown[]> => ipcRenderer.invoke('canvas:list'),
    onEvent: (handler: (event: unknown) => void) => {
      const wrapped = (_event: unknown, payload: unknown) => handler(payload)
      ipcRenderer.on('canvas-event', wrapped)
      return () => ipcRenderer.removeListener('canvas-event', wrapped)
    },
    // Ephemeral browser-chrome state pushed by main (never persisted): url,
    // title, isLoading, canGoBack, canGoForward per canvasId.
    onNavState: (handler: (payload: unknown) => void) => {
      const wrapped = (_event: unknown, payload: unknown) => handler(payload)
      ipcRenderer.on('canvas-nav-state', wrapped)
      return () => ipcRenderer.removeListener('canvas-nav-state', wrapped)
    }
  },

  // Declarative 3D Mesh Canvas. Main resolves every request through the
  // sender's current chat authority and returns tokenised local asset URLs only
  // in a renderer projection; agents never receive this API or vault tokens.
  meshCanvas: {
    listForChat: (chatId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('mesh-scene:list-chat', chatId),
    view: (chatId: string, sceneId: string): Promise<unknown | null> =>
      ipcRenderer.invoke('mesh-scene:view', chatId, sceneId),
    importUserModel: (chatId: string): Promise<{ canceled: boolean; scene?: unknown }> =>
      ipcRenderer.invoke('mesh-scene:import-user-model', chatId),
    importUserScenePackage: (chatId: string): Promise<{ canceled: boolean; scene?: unknown }> =>
      ipcRenderer.invoke('mesh-scene:import-user-package', chatId),
    closePresentation: (chatId: string, sceneId: string): Promise<unknown> =>
      ipcRenderer.invoke('mesh-scene:close-presentation', chatId, sceneId),
    deleteScene: (chatId: string, sceneId: string): Promise<unknown> =>
      ipcRenderer.invoke('mesh-scene:delete', chatId, sceneId),
    onEvent: (handler: (event: unknown) => void) => {
      const wrapped = (_event: unknown, payload: unknown) => handler(payload)
      ipcRenderer.on('mesh-scene-event', wrapped)
      return () => ipcRenderer.removeListener('mesh-scene-event', wrapped)
    }
  },

  // QMOD (1.0.3) — `ask_user_question` MCP tool bridge. Main fires
  // `agent-question-requested` when an agent calls the tool; renderer
  // responds via `answer-agent-question` (with the user's pick) or
  // `cancel-agent-question` (user dismissed). Main also emits
  // `agent-question-cancelled` if the question times out or the run
  // gets cancelled — renderer uses that to dismiss the modal on its
  // side so we don't leave stale cards in the transcript.
  onAgentQuestionRequested: (
    handler: (request: {
      questionId: string
      appRunId: string
      appChatId: string
      provider?: string | null
      question: string
      options?: string[]
      context?: string
    }) => void
  ) => {
    const wrapped = (_event: unknown, request: Parameters<typeof handler>[0]) => handler(request)
    ipcRenderer.on('agent-question-requested', wrapped)
    return () => ipcRenderer.removeListener('agent-question-requested', wrapped)
  },
  onAgentQuestionCancelled: (
    handler: (info: { questionId: string; appChatId: string; reason: string }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      info: { questionId: string; appChatId: string; reason: string }
    ) => handler(info)
    ipcRenderer.on('agent-question-cancelled', wrapped)
    return () => ipcRenderer.removeListener('agent-question-cancelled', wrapped)
  },
  answerAgentQuestion: (payload: {
    questionId: string
    answer: string
    isCustom?: boolean
    appChatId?: string
    appRunId?: string
    workspaceId?: string | null
  }) =>
    ipcRenderer.invoke('answer-agent-question', payload) as Promise<{
      ok: boolean
      error?: string
    }>,
  cancelAgentQuestion: (payload: {
    questionId: string
    reason?: string
    appChatId?: string
    appRunId?: string
    workspaceId?: string | null
  }) =>
    ipcRenderer.invoke('cancel-agent-question', payload) as Promise<{
      ok: boolean
      error?: string
    }>,
  answerEnsemblePoll: (payload: { appChatId: string; pollId: string; choice: string }) =>
    ipcRenderer.invoke('answer-ensemble-poll', payload) as Promise<{
      ok: boolean
      error?: string
    }>,

  // Peer thread-to-thread messages (S8). All three channels are main-renderer-only
  // by the IPC allowlist's fail-closed default; `thread-message:send` additionally
  // proves main-renderer authority in main, because a send from here is recorded as
  // user-authored and a user-composed message skips the approval prompt.
  threadMessageTargets: (fromChatId: string) =>
    ipcRenderer.invoke('thread-message:targets', fromChatId) as Promise<
      Array<{ chatId: string; title: string; workspaceId: string | null; crossWorkspace: boolean }>
    >,
  threadMessageInbox: (chatId: string) =>
    ipcRenderer.invoke('thread-message:inbox', chatId) as Promise<{
      summary: {
        toChatId: string
        pendingCount: number
        hasWakeRequest: boolean
        oldestPendingAt: number | null
        senders: string[]
      }
      pending: Array<{
        id: string
        fromChatId: string
        fromChatTitle: string
        origin: 'user' | 'agent'
        body: string
        requestedDelivery: 'queue' | 'wake'
        createdAt: number
        truncated?: boolean
      }>
    }>,
  sendThreadMessage: (payload: {
    fromChatId: string
    toChatId: string
    message: string
    wake?: boolean
    idempotencyKey?: string
  }) =>
    ipcRenderer.invoke('thread-message:send', payload) as Promise<{
      ok: boolean
      outcome?: string
      messageId?: string
      error?: string
    }>,

  // Phase K1: open external URLs / file paths from transcript markdown
  // clicks. Replaces the bare `<a href>` flow that would otherwise let
  // Electron navigate the BrowserWindow itself, unloading the bundled
  // renderer and blanking the app. Main validates the scheme and
  // routes to shell.openExternal (http/https/mailto) or shell.openPath
  // (filesystem paths); unknown / unsafe schemes are no-ops.
  openExternalOrPath: (href: string) =>
    ipcRenderer.invoke('shell:open-link', href) as Promise<{ ok: boolean; error?: string }>,
  getLicenseNoticeStatus: () =>
    ipcRenderer.invoke('licenses:get-status') as Promise<LicenseNoticeStatus>,
  openLicenseNotice: (kind: LicenseNoticeKind) =>
    ipcRenderer.invoke('licenses:open-notice', kind) as Promise<OpenLicenseNoticeResult>,
  revealPathInFinder: (path: string) =>
    ipcRenderer.invoke('shell:reveal-in-finder', path) as Promise<{ ok: boolean; error?: string }>,
  // Sha-addressed media-asset actions for generated (path-less) AV/image refs.
  // Main resolves the asset by content hash + mime into a real on-disk file,
  // then reveals / returns / save-as-copies it. Channels are LOCKED — a
  // parallel agent owns the main-side handlers.
  revealMediaAsset: (sha256: string, mimeType: string) =>
    ipcRenderer.invoke('media-asset:reveal', { sha256, mimeType }) as Promise<{ ok: boolean }>,
  getMediaAssetPath: (sha256: string, mimeType: string) =>
    ipcRenderer.invoke('media-asset:get-path', { sha256, mimeType }) as Promise<string | null>,
  saveMediaAssetAs: (sha256: string, mimeType: string, suggestedName: string) =>
    ipcRenderer.invoke('media-asset:save-as', { sha256, mimeType, suggestedName }) as Promise<{
      ok: boolean
      canceled: boolean
    }>,
  getFaviconForUrl: (url: string) =>
    ipcRenderer.invoke('favicon:getForUrl', url) as Promise<
      | {
          ok: true
          origin: string
          host: string
          iconUrl: string
          dataUrl: string
          contentType: string
          source: 'cache' | 'network'
          title?: string
        }
      | { ok: false; origin?: string; host?: string; blocked?: boolean; error: string }
    >,
  // Open a Terminal for provider sign-in. Main rejects historical Cursor
  // requests before resolving a binary or writing a command file. Kimi returns
  // explicit user-owned setup metadata; this handoff is not managed-run
  // qualification.
  openProviderLoginTerminal: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:open-login-terminal', provider) as Promise<{
      ok: boolean
      error?: string
      scope?: 'user-owned-provider-setup'
      managedRunReady?: false
      notice?: string
    }>,
  openProviderLogoutTerminal: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:open-logout-terminal', provider) as Promise<{
      ok: boolean
      error?: string
      scope?: 'user-owned-provider-setup'
      managedRunReady?: false
      notice?: string
    }>,
  openProviderUpgradeTerminal: (provider: ProviderId) =>
    ipcRenderer.invoke('provider:open-upgrade-terminal', provider) as Promise<{
      ok: boolean
      error?: string
      scope?: 'user-owned-provider-setup'
      managedRunReady?: false
      notice?: string
    }>,
  /** Catalog install commands (provider CLIs + Ollama model pulls): opens a
   * Terminal running the official command for this catalog row id. */
  openInstallCommandTerminal: (commandId: string) =>
    ipcRenderer.invoke('install-command:open-terminal', commandId) as Promise<{
      ok: boolean
      error?: string
      command?: string
    }>,
  /** Optional host CLIs (gh) — install when absent, upgrade when present. */
  openHostToolInstallTerminal: (toolId: string) =>
    ipcRenderer.invoke('host-tool:open-install-terminal', toolId) as Promise<{
      ok: boolean
      error?: string
      command?: string
      alreadyInstalled?: boolean
    }>,
  hostToolStatus: (toolId: string) =>
    ipcRenderer.invoke('host-tool:status', toolId) as Promise<{
      id: string
      available: boolean
      path?: string
    }>,
  startPty: (workspacePath: string, sessionId: string = 'default') =>
    ipcRenderer.invoke('start-pty', workspacePath, sessionId),
  stopPty: (sessionId: string = 'default') => ipcRenderer.invoke('stop-pty', sessionId),
  ptyWrite: (data: string, sessionId: string = 'default') =>
    ipcRenderer.invoke('pty-write', data, sessionId),
  ptyResize: (cols: number, rows: number, sessionId: string = 'default') =>
    ipcRenderer.invoke('pty-resize', cols, rows, sessionId),
  startGeminiSession: (
    workspace: string,
    model: string = 'cli-default',
    approvalMode: string = 'default',
    sessionTrust: boolean = false,
    cols: number = 80,
    rows: number = 24,
    resumeSessionId: string | null = null,
    worktree: GeminiWorktreeLaunchOption = null
  ) =>
    ipcRenderer.invoke(
      'start-gemini-session',
      workspace,
      model,
      approvalMode,
      sessionTrust,
      cols,
      rows,
      resumeSessionId,
      worktree
    ),
  stopGeminiSession: () => ipcRenderer.invoke('stop-gemini-session'),
  writeGeminiSession: (data: string) => ipcRenderer.invoke('write-gemini-session', data),
  resizeGeminiSession: (cols: number, rows: number) =>
    ipcRenderer.invoke('resize-gemini-session', cols, rows),
  discoverGeminiCommands: (workspace: string) =>
    ipcRenderer.invoke('discover-gemini-commands', workspace),
  discoverGeminiMemory: (workspace: string) =>
    ipcRenderer.invoke('discover-gemini-memory', workspace),
  getFileIconDataUrl: (path: string) => ipcRenderer.invoke('get-file-icon', path),
  onPtyData: (callback: (data: string, sessionId?: string) => void) => {
    const handler = (_event: unknown, data: string, sessionId?: string) =>
      callback(data, sessionId)
    ipcRenderer.on('pty-data', handler)
    return () => ipcRenderer.removeListener('pty-data', handler)
  },
  onPtyExit: (callback: (code: number | null, sessionId?: string) => void) => {
    const handler = (_event: unknown, code: number | null, sessionId?: string) =>
      callback(code, sessionId)
    ipcRenderer.on('pty-exit', handler)
    return () => ipcRenderer.removeListener('pty-exit', handler)
  },
  removePtyListeners: () => {
    ipcRenderer.removeAllListeners('pty-data')
    ipcRenderer.removeAllListeners('pty-exit')
  },
  onGeminiSessionData: (callback: (data: string) => void) => {
    ipcRenderer.on('gemini-session-data', (_event, data) => callback(data))
  },
  onGeminiSessionExit: (callback: (code: number | null) => void) => {
    ipcRenderer.on('gemini-session-exit', (_event, code) => callback(code))
  },
  removeGeminiSessionListeners: () => {
    ipcRenderer.removeAllListeners('gemini-session-data')
    ipcRenderer.removeAllListeners('gemini-session-exit')
  },

  // Bridge / iOS remote allowlist (Phase C4 admin surface)
  bridgeAllowlistList: () => ipcRenderer.invoke('bridge-allowlist-list'),
  bridgeAllowlistUpsert: (entry: {
    workspaceId: string
    path: string
    mode: 'read-only' | 'read-write'
    capabilities?: string[]
    expiresAt?: number
  }) => ipcRenderer.invoke('bridge-allowlist-upsert', entry),
  bridgeAllowlistRemove: (workspaceId: string) =>
    ipcRenderer.invoke('bridge-allowlist-remove', workspaceId),
  bridgeAllowlistClear: () => ipcRenderer.invoke('bridge-allowlist-clear'),
  bridgeNetworkingStatus: () => ipcRenderer.invoke('bridge-networking-status'),
  setBridgeDaemonEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('set-bridge-daemon-enabled', enabled),
  getIosRemoteConfig: () => ipcRenderer.invoke('get-ios-remote-config'),
  setIosRemoteConfig: (config: {
    enabled?: boolean
    relayUrl?: string
    manualRelayUrl?: string
    openAtLogin?: boolean
  }) => ipcRenderer.invoke('set-ios-remote-config', config),
  iosRemoteTailscaleStatus: () => ipcRenderer.invoke('ios-remote-tailscale-status'),
  iosRemoteTailscaleEnable: () => ipcRenderer.invoke('ios-remote-tailscale-enable'),
  iosRemoteTailscaleTest: () => ipcRenderer.invoke('ios-remote-tailscale-test'),
  iosRemoteTailscaleDisable: () => ipcRenderer.invoke('ios-remote-tailscale-disable'),
  iosRemoteTailscaleLink: (authKey: string) =>
    ipcRenderer.invoke('ios-remote-tailscale-link', authKey),
  iosRemoteTailscaleOAuthSet: (input: { clientId: string; clientSecret: string }) =>
    ipcRenderer.invoke('ios-remote-tailscale-oauth-set', input),
  iosRemoteTailscaleOAuthClear: () => ipcRenderer.invoke('ios-remote-tailscale-oauth-clear'),
  iosRemoteTailscaleOAuthStatus: () => ipcRenderer.invoke('ios-remote-tailscale-oauth-status'),

  // Phase G2: auto-update controls.
  updateSnapshot: () => ipcRenderer.invoke('update-snapshot'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  downloadUpdateAndRestart: () => ipcRenderer.invoke('download-update-and-restart'),
  installUpdateOnQuit: () => ipcRenderer.invoke('install-update-on-quit'),
  installUpdateNow: () => ipcRenderer.invoke('install-update-now'),
  changelogSnapshot: () => ipcRenderer.invoke('changelog-snapshot'),
  markChangelogSeen: (version: string) => ipcRenderer.invoke('mark-changelog-seen', version),
  onUpdateStatusChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot)
    ipcRenderer.on('update-status-changed', listener)
    return () => ipcRenderer.removeListener('update-status-changed', listener)
  },

  // Local Servers — dev servers/watchers running under the user's workspaces.
  localServersSnapshot: () => ipcRenderer.invoke('local-servers-snapshot'),
  localServersRefresh: () => ipcRenderer.invoke('local-servers-refresh'),
  localServersStop: (pid: number) => ipcRenderer.invoke('local-servers-stop', pid),
  localServersStopAll: () => ipcRenderer.invoke('local-servers-stop-all'),
  onLocalServersChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot)
    ipcRenderer.on('local-servers-changed', listener)
    return () => ipcRenderer.removeListener('local-servers-changed', listener)
  },
  launchTargetsSnapshot: (workspacePath: string) =>
    ipcRenderer.invoke('launch-targets-snapshot', workspacePath),
  launchAttemptsSnapshot: () => ipcRenderer.invoke('launch-attempts-snapshot'),
  launchStart: (input: unknown) => ipcRenderer.invoke('launch-start', input),
  launchStop: (input: unknown) => ipcRenderer.invoke('launch-stop', input),
  onLaunchAttemptsChanged: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot)
    ipcRenderer.on('launch-attempts-changed', listener)
    return () => ipcRenderer.removeListener('launch-attempts-changed', listener)
  },
  bridgeFinalizePairing: (sessionID: string, userConfirmed: boolean) =>
    ipcRenderer.invoke('bridge-finalize-pairing', sessionID, userConfirmed),
  bridgeBeginPairing: (displayName?: string, options?: { force?: boolean }) =>
    ipcRenderer.invoke('bridge-begin-pairing', displayName, options),
  bridgeListPairedDevices: () => ipcRenderer.invoke('bridge-list-paired-devices'),
  bridgeUnpairDevice: (iphoneIdentityPubKey: string) =>
    ipcRenderer.invoke('bridge-unpair-device', iphoneIdentityPubKey),

  // Native-window attachment is chat-scoped. The preload exposes only the
  // coordinator's renderer-safe status: no handle, scope, consent, process,
  // bounds, or lease material crosses this boundary.
  attachWindowPick: (chatId: string) =>
    ipcRenderer.invoke('attach-window:pick', chatId) as Promise<NativeWindowCoordinatorPickResult>,
  attachWindowDetach: (chatId: string, generation: number) =>
    ipcRenderer.invoke('attach-window:detach', chatId, generation) as Promise<{
      detached: boolean
      status: NativeWindowCoordinatorRendererStatus
    }>,
  attachWindowControlSession: (chatId: string, action: 'pause' | 'resume' | 'takeover' | 'stop') =>
    ipcRenderer.invoke(
      'attach-window:control-session',
      chatId,
      action
    ) as Promise<NativeWindowCoordinatorRendererStatus>,

  attachWindowStatus: (chatId: string) =>
    ipcRenderer.invoke(
      'attach-window:status',
      chatId
    ) as Promise<NativeWindowCoordinatorRendererStatus>,
  // Sticky AppWatch is a resume hint only. This preload reconstructs an
  // allowlisted display projection and never forwards window IDs, process data,
  // handles, scopes, consent epochs, or lease material.
  stickyAppWatchGet: async (
    chatId: string
  ): Promise<{ snapshot: StickyAppWatchSnapshot | null }> => {
    const canonicalChatId = stickyAppWatchChatId(chatId)
    const response = await ipcRenderer.invoke('sticky-appwatch:get', canonicalChatId)
    const snapshot = stickyAppWatchSnapshot(nativeWindowRecord(response)?.snapshot)
    return Object.freeze({
      snapshot: snapshot?.chatId === canonicalChatId ? snapshot : null
    })
  },
  stickyAppWatchStash: async (input: StickyAppWatchStashInput): Promise<{ ok: boolean }> => {
    const safeInput = stickyAppWatchStashInput(input)
    if (!safeInput)
      throw new Error('Sticky AppWatch data must be a safe chat-scoped display snapshot.')
    return stickyAppWatchOk(await ipcRenderer.invoke('sticky-appwatch:stash', safeInput))
  },
  stickyAppWatchClear: async (chatId: string): Promise<{ ok: boolean }> => {
    const canonicalChatId = stickyAppWatchChatId(chatId)
    return stickyAppWatchOk(await ipcRenderer.invoke('sticky-appwatch:clear', canonicalChatId))
  },
  onAttachedWindowChanged: (callback: (event: NativeWindowCoordinatorRendererEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) => {
      const safeEvent = decodeNativeWindowRendererEvent(event)
      if (safeEvent) callback(safeEvent)
    }
    ipcRenderer.on('attached-window-changed', listener)
    return () => ipcRenderer.removeListener('attached-window-changed', listener)
  },

  // Phase E1: APNs production wiring. The renderer Settings panel uses
  // these to configure the iOS bridge push gateway. The decrypted .p8
  // PEM never crosses this boundary; only the encrypted blob lives in
  // settings, and the IPC handlers in main decrypt via safeStorage.
  getApnsConfig: () => ipcRenderer.invoke('get-apns-config'),
  selectApnsKeyFile: () => ipcRenderer.invoke('select-apns-key-file'),
  setApnsConfig: (input: {
    authKeyPath?: string
    keyId?: string
    teamId?: string
    bundleId?: string
  }) => ipcRenderer.invoke('set-apns-config', input),
  clearApnsConfig: () => ipcRenderer.invoke('clear-apns-config'),
  testApnsPush: () => ipcRenderer.invoke('test-apns-push'),
  onBridgePairingResponseReceived: (callback: (params: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, params: unknown) => callback(params)
    ipcRenderer.on('bridge-pairing-response-received', listener)
    return () => ipcRenderer.removeListener('bridge-pairing-response-received', listener)
  },

  // Store APIs
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (partial: any) => ipcRenderer.invoke('update-settings', partial),
  'prompt-cache:get-policy': () => ipcRenderer.invoke('prompt-cache:get-policy'),
  'prompt-cache:save-policy': (policy: any) =>
    ipcRenderer.invoke('prompt-cache:save-policy', policy),
  'prompt-cache:get-capabilities': () => ipcRenderer.invoke('prompt-cache:get-capabilities'),
  'prompt-cache:get-diagnostics': () => ipcRenderer.invoke('prompt-cache:get-diagnostics'),
  upsertAgenticWorkspaceGrant: (provider: ProviderId, workspacePath: string, service: string) =>
    ipcRenderer.invoke('upsert-agentic-workspace-grant', provider, workspacePath, service),
  removeAgenticWorkspaceGrant: (
    provider: AgenticWorkspaceGrantProviderId,
    workspacePath: string,
    service: string
  ) => ipcRenderer.invoke('remove-agentic-workspace-grant', provider, workspacePath, service),
  getRuntimeProfiles: (provider?: ProviderId) =>
    ipcRenderer.invoke('get-runtime-profiles', provider),
  saveRuntimeProfile: (profile: any, secretValues?: any) =>
    ipcRenderer.invoke('save-runtime-profile', profile, secretValues),
  deleteRuntimeProfile: (id: string) => ipcRenderer.invoke('delete-runtime-profile', id),
  getExtensionSecretStatus: () => ipcRenderer.invoke('get-extension-secret-status'),
  setExtensionSecret: (ref: any, value: string) =>
    ipcRenderer.invoke('set-extension-secret', ref, value),
  clearExtensionSecret: (ref: any) => ipcRenderer.invoke('clear-extension-secret', ref),
  ...createAntigravityGeminiApiSecretBridge(ipcRenderer),
  ...createPiKeyBridge(ipcRenderer),
  getManagedPolicyStatus: () => ipcRenderer.invoke('get-managed-policy-status'),
  getHandoffCards: (filter: any = {}) => ipcRenderer.invoke('get-handoff-cards', filter),
  saveHandoffCard: (card: any) => ipcRenderer.invoke('save-handoff-card', card),
  updateHandoffCard: (id: string, partial: any) =>
    ipcRenderer.invoke('update-handoff-card', id, partial),
  deleteHandoffCard: (id: string) => ipcRenderer.invoke('delete-handoff-card', id),
  getPluginCatalog: () =>
    ipcRenderer.invoke('plugins:get-catalog') as Promise<TaskWraithPluginCatalogSnapshot>,
  getPluginContributions: () =>
    ipcRenderer.invoke(
      'plugins:get-contributions'
    ) as Promise<TaskWraithPluginContributionSnapshot>,
  getPluginActivation: () =>
    ipcRenderer.invoke('plugins:get-activation') as Promise<TaskWraithPluginActivationSnapshot>,
  getPluginSecretStatus: () =>
    ipcRenderer.invoke(
      'plugins:get-secret-status'
    ) as Promise<TaskWraithPluginSecretStatusSnapshot>,
  setPluginSecret: (pluginId: string, secretId: string, value: string) =>
    ipcRenderer.invoke(
      'plugins:set-secret',
      pluginId,
      secretId,
      value
    ) as Promise<TaskWraithPluginSecretMutationResult>,
  clearPluginSecret: (pluginId: string, secretId: string) =>
    ipcRenderer.invoke(
      'plugins:clear-secret',
      pluginId,
      secretId
    ) as Promise<TaskWraithPluginSecretMutationResult>,
  materializePluginMcpPreset: (pluginId: string, presetId: string) =>
    ipcRenderer.invoke(
      'plugins:materialize-mcp-preset',
      pluginId,
      presetId
    ) as Promise<TaskWraithPluginMcpPresetMaterializationResult>,
  installPlugin: (pluginId: string) =>
    ipcRenderer.invoke('plugins:install', pluginId) as Promise<TaskWraithPluginCatalogSnapshot>,
  setPluginEnabled: (pluginId: string, enabled: boolean) =>
    ipcRenderer.invoke(
      'plugins:set-enabled',
      pluginId,
      enabled
    ) as Promise<TaskWraithPluginCatalogSnapshot>,
  updatePlugin: (pluginId: string) =>
    ipcRenderer.invoke('plugins:update', pluginId) as Promise<TaskWraithPluginCatalogSnapshot>,
  uninstallPlugin: (pluginId: string) =>
    ipcRenderer.invoke('plugins:uninstall', pluginId) as Promise<TaskWraithPluginCatalogSnapshot>,
  getWorkspaces: () => ipcRenderer.invoke('get-workspaces'),
  addOrUpdateWorkspace: (path: string, partial: any = {}) =>
    ipcRenderer.invoke('add-or-update-workspace', path, partial),
  removeWorkspace: (id: string) => ipcRenderer.invoke('remove-workspace', id),
  clearWorkspaces: () => ipcRenderer.invoke('clear-workspaces'),
  getProjectsSnapshot: () => ipcRenderer.invoke('projects:snapshot'),
  applyProjectOp: (op: unknown) => ipcRenderer.invoke('projects:apply-op', op),
  setProjectHomeChat: (projectId: string, chatId: string | null) =>
    ipcRenderer.invoke('projects:set-home-chat', projectId, chatId),
  updateProjectWorkProfile: (
    projectId: string,
    patch: { brief?: string | null; preferredWorkspaceId?: string | null }
  ) => ipcRenderer.invoke('projects:update-work-profile', projectId, patch),
  applyProjectReferenceOp: (op: unknown) => ipcRenderer.invoke('projects:reference-op', op),
  applyProjectGraphEdgeOp: (op: unknown) => ipcRenderer.invoke('projects:graph-edge-op', op),
  verifyProjectReference: (id: string) => ipcRenderer.invoke('projects:verify-reference', id),
  pickProjectReferencePath: (mode: 'file' | 'folder') =>
    ipcRenderer.invoke('projects:pick-reference-path', mode),
  importLegacyProjects: (rawJson: string | null) =>
    ipcRenderer.invoke('projects:import-legacy', rawJson),
  listProjectReferenceProposals: (projectId: string) =>
    ipcRenderer.invoke('projects:list-reference-proposals', projectId),
  reviewProjectReferenceProposal: (input: {
    projectId: string
    proposalId: string
    decision: 'approve' | 'reject'
  }) => ipcRenderer.invoke('projects:review-reference-proposal', input),
  getChats: (workspaceId?: string) => ipcRenderer.invoke('get-chats', workspaceId),
  getChatList: (workspaceId?: string) => ipcRenderer.invoke('get-chat-list', workspaceId),
  getPinnedMessages: (workspaceId?: string) =>
    ipcRenderer.invoke('get-pinned-messages', workspaceId),
  getChat: (chatId: string) => ipcRenderer.invoke('get-chat', chatId),
  createChat: (workspaceId: string, workspacePath: string) =>
    ipcRenderer.invoke('create-chat', workspaceId, workspacePath),
  createGlobalChat: () => ipcRenderer.invoke('create-global-chat'),
  createEnsembleChat: (args?: { workspaceId?: string; workspacePath?: string }) =>
    ipcRenderer.invoke('create-ensemble-chat', args),
  postBlackboardEntry: (payload: {
    chatId: string
    key?: string
    value: string
    category?: string
    scope?: string
    ttlMinutes?: number
  }) =>
    ipcRenderer.invoke('post-blackboard-entry', payload) as Promise<{
      ok: true
      entry: BlackboardEntry
    }>,
  deleteBlackboardEntry: (payload: { chatId: string; entryId: string }) =>
    ipcRenderer.invoke('delete-blackboard-entry', payload) as Promise<{
      ok: true
      removed: BlackboardEntry
      remainingCount: number
    }>,
  clearBlackboardEntries: (payload: { chatId: string }) =>
    ipcRenderer.invoke('clear-blackboard-entries', payload) as Promise<{
      ok: true
      removedCount: number
    }>,
  runEnsembleRound: (payload: {
    chatId: string
    prompt: string
    /** When dispatched by a SCHEDULED workflow occurrence, the task id rides
     * through so the main-side round-settle hook can mark the task terminal
     * (scheduled ensemble runs have no per-participant scheduledTaskId, so
     * without this they stay stuck 'running'). */
    scheduledTaskId?: string
    mode?: string
    concurrentMode?: boolean
    fanoutPolicy?: EnsembleFanoutPolicy
    imageAttachments?: ComposerImageAttachment[]
    discordContextSnapshots?: DiscordContextSnapshot[]
    /** Advisory exact target for an explicit participant-chip gesture.
     * MAIN re-resolves prompt mentions against its canonical roster and only
     * accepts this id when the prompt has no participant-routing signal and
     * the seat is current, enabled, and foreground. */
    dmTargetParticipantId?: string
    /** Exact participant selected through the composer @ picker. */
    exactPickerParticipantId?: string
    /** 1.0.4-AT4 — composer-level external path grants applied to
     * every participant's effective permissions for the round.
     * Pre-AT4 these were dropped on the IPC boundary, so file-
     * mention grants the user added in the composer never reached
     * the participants. The orchestrator's
     * `resolveParticipantPermissions` provider-filters so each
     * participant only sees grants tagged for its own provider. */
    externalPathGrants?: Array<{
      provider: string
      path: string
      kind?: string
      grantedAt?: string
    }>
  }) => ipcRenderer.invoke('run-ensemble-round', payload),
  steerQueuedEnsemblePrompt: (payload: {
    chatId: string
    index: number
    textPrefix?: string
    concurrentMode?: boolean
    fanoutPolicy?: EnsembleFanoutPolicy
  }) => ipcRenderer.invoke('steer-queued-ensemble-prompt', payload),
  removeQueuedEnsemblePrompt: (payload: { chatId: string; index: number; textPrefix?: string }) =>
    ipcRenderer.invoke('remove-queued-ensemble-prompt', payload),
  blackboardQueuedEnsemblePrompt: (payload: {
    chatId: string
    index: number
    textPrefix?: string
  }) => ipcRenderer.invoke('blackboard-queued-ensemble-prompt', payload),
  cancelEnsembleRound: (chatId: string) => ipcRenderer.invoke('cancel-ensemble-round', chatId),
  updateLiveEnsembleRoundConfig: (payload: {
    chatId: string
    orchestrationMode?: EnsembleOrchestrationMode
    fanoutPolicy?: EnsembleFanoutPolicy
    maxContinuationHops?: number
  }) =>
    ipcRenderer.invoke('ensemble:update-live-round-config', payload) as Promise<{
      ok: boolean
      orchestrationMode?: EnsembleOrchestrationMode
      fanoutPolicy?: EnsembleFanoutPolicy
      maxContinuationHops?: number
      activeRoundUpdated?: boolean
      error?: string
      message?: string
    }>,
  applyEnsembleRosterPresetAtBoundary: (payload: {
    chatId: string
    plan: PendingEnsembleRosterPresetApply
  }) =>
    ipcRenderer.invoke('ensemble:apply-roster-preset', payload) as Promise<
      | { ok: true; deferred: boolean; chat: ChatRecord; message: string }
      | { ok: false; error: 'invalid_config' | 'not_ensemble'; message: string }
    >,
  requestEnsembleParticipantSeatChange: (payload: {
    chatId: string
    participantId: string
    participant: Record<string, unknown>
    reason?: string
  }) => ipcRenderer.invoke('request-ensemble-participant-seat-change', payload),
  requestEnsembleUserRosterMutation: (payload: EnsembleUserRosterMutationInput) =>
    ipcRenderer.invoke(
      'request-ensemble-user-roster-mutation',
      payload
    ) as Promise<EnsembleUserRosterMutationResult>,
  skipEnsembleParticipant: (chatId: string) =>
    ipcRenderer.invoke('skip-ensemble-participant', chatId),
  skipEnsembleReadFanout: (chatId: string) =>
    ipcRenderer.invoke('skip-ensemble-read-fanout', chatId),
  getLatestSessionCheckpoint: (chatId: string) =>
    ipcRenderer.invoke(
      'session-checkpoints:latest',
      chatId
    ) as Promise<SessionCheckpointRecord | null>,
  acceptSessionCheckpoint: (checkpointId: string) =>
    ipcRenderer.invoke('session-checkpoints:accept', checkpointId) as Promise<
      | { ok: true; checkpoint: SessionCheckpointRecord; resumePrompt: string }
      | { ok: false; error: string }
    >,
  dismissSessionCheckpoint: (checkpointId: string) =>
    ipcRenderer.invoke('session-checkpoints:dismiss', checkpointId) as Promise<
      { ok: true; checkpoint: SessionCheckpointRecord } | { ok: false; error: string }
    >,
  wakeEnsembleParticipantNow: (wakeupId: string) =>
    ipcRenderer.invoke('wake-ensemble-participant-now', wakeupId) as Promise<boolean>,
  // Provider-native "compact now" for a chat's linked provider session
  // (Codex thread/compact/start; solo Claude compacts via a normal `/compact`
  // run instead). With `participantId`, targets one ensemble seat's session
  // (Claude seats use the main-side maintenance lane).
  compactProviderContext: (payload: {
    chatId: string
    provider: string
    providerSessionId?: string
    participantId?: string
  }) =>
    ipcRenderer.invoke('compact-provider-context', payload) as Promise<{
      ok: boolean
      error?: string
    }>,
  cancelEnsembleParticipantWakeup: (wakeupId: string) =>
    ipcRenderer.invoke('cancel-ensemble-participant-wakeup', wakeupId) as Promise<{
      ok: boolean
      error?: string
    }>,
  createSubThread: (args: {
    parentChatId: string
    provider: string
    delegationPrompt: string
    returnResultToParent: boolean
    workspaceId?: string
    workspacePath?: string
  }) => ipcRenderer.invoke('create-sub-thread', args),
  getSubThreads: (parentChatId: string) => ipcRenderer.invoke('get-sub-threads', parentChatId),
  createSideChat: (args: {
    parentChatId: string
    chatKind?: 'single' | 'ensemble'
    provider?: string
    title?: string
    originMessageId?: string
    originRunId?: string
    sideChatMode?: 'ensembleClone' | 'singleProvider' | 'fanOut'
  }) => ipcRenderer.invoke('create-side-chat', args),
  getSideChats: (parentChatId: string) => ipcRenderer.invoke('get-side-chats', parentChatId),
  setChatKind: (args: {
    chatId: string
    targetKind: 'single' | 'ensemble'
    seedParticipant?: unknown
    canonicalProvider?: string
    canonicalProviderMetadata?: Record<string, unknown>
  }) => ipcRenderer.invoke('set-chat-kind', args),
  rebindChatWorkspace: (
    args:
      | { chatId: string; scope: 'global'; deferIfBusy?: boolean }
      | {
          chatId: string
          scope: 'workspace'
          workspaceId: string
          workspacePath: string
          deferIfBusy?: boolean
        }
  ) =>
    ipcRenderer.invoke('rebind-chat-workspace', args) as Promise<{
      chat: ChatRecord
      changed: boolean
      deferred?: boolean
    }>,
  listDiscordContextTargets: () => ipcRenderer.invoke('discord-context:list-targets'),
  readDiscordContext: (selection: DiscordContextSelection) =>
    ipcRenderer.invoke('discord-context:read-channel', selection),
  humanCollaborationCreateShare: (input: {
    chatId: string
    mode?: 'readOnly' | 'comments'
    inviteTtlMs?: number
  }) => ipcRenderer.invoke('human-collaboration:create-share', input),
  humanCollaborationInviteHealth: (chatId: string) =>
    ipcRenderer.invoke('human-collaboration:invite-health', chatId),
  humanCollaborationCopyInvite: (input: { invite: string }) =>
    ipcRenderer.invoke('human-collaboration:copy-invite', input),
  humanCollaborationListShares: (chatId?: string) =>
    ipcRenderer.invoke('human-collaboration:list-shares', chatId),
  humanCollaborationConnectedChatIds: () =>
    ipcRenderer.invoke('human-collaboration:connected-chat-ids'),
  humanCollaborationRevokeShare: (shareId: string) =>
    ipcRenderer.invoke('human-collaboration:revoke-share', shareId),
  humanCollaborationSetHostReview: (input: { shareId: string; requiresHostApproval: boolean }) =>
    ipcRenderer.invoke('human-collaboration:set-host-review', input),
  humanCollaborationSetFullHistory: (input: { shareId: string; fullHistory: boolean }) =>
    ipcRenderer.invoke('human-collaboration:set-full-history', input),
  humanCollaborationListPendingContributions: (chatId: string) =>
    ipcRenderer.invoke('human-collaboration:list-pending-contributions', chatId),
  humanCollaborationApproveContribution: (entryId: string) =>
    ipcRenderer.invoke('human-collaboration:approve-contribution', entryId),
  humanCollaborationDenyContribution: (input: { entryId: string; reason?: string }) =>
    ipcRenderer.invoke('human-collaboration:deny-contribution', input),
  humanCollaborationRevokeParticipant: (input: { shareId: string; collaboratorId: string }) =>
    ipcRenderer.invoke('human-collaboration:revoke-participant', input),
  humanCollaborationConsumeInvite: (input: {
    shareId: string
    inviteToken: string
    displayName: string
    publicKeyId: string
  }) => ipcRenderer.invoke('human-collaboration:consume-invite', input),
  humanCollaborationAppendComment: (input: {
    shareId: string
    chatId: string
    collaboratorId: string
    clientMessageId: string
    content: string
  }) => ipcRenderer.invoke('human-collaboration:append-comment', input),
  humanCollaborationProjection: (input: {
    shareId: string
    chatId: string
    collaboratorId: string
  }) => ipcRenderer.invoke('human-collaboration:projection', input),
  humanCollaborationRuntimeBeginAdmission: (input: {
    shareId: string
    chatId: string
    displayName: string
    inviteToken?: string
    collaboratorId?: string
    collaboratorIdentityPubKeyB64: string
    collaboratorEphemeralPubKeyB64: string
    collaboratorNonceB64: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:begin-admission', input),
  humanCollaborationRuntimeConfirmSas: (input: {
    handshakeId: string
    confirmCode: string
    collaboratorTranscriptSigB64: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:confirm-sas', input),
  humanCollaborationRuntimeSubscribeProjection: (input: { sessionId: string }) =>
    ipcRenderer.invoke('human-collaboration-runtime:subscribe-projection', input),
  humanCollaborationRuntimeAppendComment: (input: {
    sessionId: string
    clientMessageId: string
    content: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:append-comment', input),
  humanCollaborationRuntimeReceiveFrame: (input: {
    t: 'humanCollaboration.enc'
    protocol: string
    sessionId: string
    direction: 'hostToCollaborator' | 'collaboratorToHost'
    seq: number
    nonce: string
    ct: string
    tag: string
  }) => ipcRenderer.invoke('human-collaboration-runtime:receive-frame', input),
  humanCollaborationRuntimeDisconnect: (input: { sessionId: string }) =>
    ipcRenderer.invoke('human-collaboration-runtime:disconnect', input),
  humanCollaborationPromoteComment: (input: { chatId: string; messageId: string }) =>
    ipcRenderer.invoke('human-collaboration:promote-comment', input),
  // P2a — host-only contribution-rules update (preset: readOnly | comments |
  // requestHostAction | autoDraft; the direct tier is rejected main-side).
  humanCollaborationUpdateShareRules: (input: { shareId: string; preset: string }) =>
    ipcRenderer.invoke('human-collaboration:update-share-rules', input),
  // P2a — bounded, newest-first collaboration audit rows.
  humanCollaborationAuditLog: (input?: { chatId?: string; limit?: number }) =>
    ipcRenderer.invoke('human-collaboration:audit-log', input),
  // P2a presence clarity — live per-session summaries (share + collaborator).
  humanCollaborationSessionStatus: () => ipcRenderer.invoke('human-collaboration:session-status'),
  // Collaborator side (this instance joining someone else's shared chat).
  humanCollaborationCollaboratorJoin: (input: {
    shareId: string
    chatId: string
    inviteToken: string
    displayName: string
    mode: 'readOnly' | 'comments'
    relayUrl: string
    relayUrls?: string[]
    roomId: string
    hostIdentityPubKeyB64?: string
  }) => ipcRenderer.invoke('human-collaboration-collaborator:join', input),
  humanCollaborationCollaboratorConfirm: () =>
    ipcRenderer.invoke('human-collaboration-collaborator:confirm'),
  humanCollaborationCollaboratorLoadOlder: (input: { beforeRowId?: string } = {}) =>
    ipcRenderer.invoke('human-collaboration-collaborator:load-older', input),
  humanCollaborationCollaboratorAppendComment: (input: {
    content: string
    clientMessageId?: string
    intent?: 'comment' | 'requestHostAction'
  }) => ipcRenderer.invoke('human-collaboration-collaborator:append-comment', input),
  humanCollaborationCollaboratorLeave: () =>
    ipcRenderer.invoke('human-collaboration-collaborator:leave'),
  // Slice 5 reconnect — pinned-identity re-admission to the last shared chat.
  humanCollaborationCollaboratorLastSession: () =>
    ipcRenderer.invoke('human-collaboration-collaborator:last-session'),
  humanCollaborationCollaboratorReconnect: () =>
    ipcRenderer.invoke('human-collaboration-collaborator:reconnect'),
  saveChat: (chat: ChatRecord) => serializedChatPersistence.save(chat),
  deleteChat: (chatId: string) => ipcRenderer.invoke('delete-chat', chatId),
  reapAbandonedChats: (renderer: {
    protectedChatIds?: string[]
    draftChatIds?: string[]
    keepChatId?: string
  }) => ipcRenderer.invoke('reap-abandoned-chats', renderer),
  /** Slash-picker `/clear` — wipes the chat's messages + runs while
   * leaving the record (and its provider session id) intact. */
  truncateChat: (chatId: string) =>
    serializedChatPersistence.run(
      chatId,
      () => ipcRenderer.invoke('truncate-chat', chatId) as Promise<ChatRecord | null>
    ),
  clearChats: (workspaceId?: string) => ipcRenderer.invoke('clear-chats', workspaceId),
  recordUsage: (usage: any) => ipcRenderer.invoke('record-usage', usage),
  getUsage: (workspaceId?: string, chatId?: string) =>
    ipcRenderer.invoke('get-usage', workspaceId, chatId),
  getWorkspaceActivity: (workspacePath: string, dayCount?: number) =>
    ipcRenderer.invoke(
      'get-workspace-activity',
      workspacePath,
      dayCount
    ) as Promise<WorkspaceActivitySnapshot>,
  getScheduledTasks: (workspaceId?: string) =>
    ipcRenderer.invoke('get-scheduled-tasks', workspaceId),
  // Push the renderer's roster-preset list to main so the bridge can project
  // it to paired iOS devices (the renderer's localStorage is the source of truth).
  syncEnsembleRosterPresets: (presets: unknown[]) =>
    ipcRenderer.invoke('ensemble-roster-presets:sync', presets),
  saveScheduledTask: (task: ScheduledTaskCreateInput) =>
    ipcRenderer.invoke('save-scheduled-task', task),
  updateScheduledTask: (id: string, partial: ScheduledTaskLifecycleUpdate) =>
    ipcRenderer.invoke('update-scheduled-task', id, partial),
  cancelScheduledTask: (id: string, reason?: string) =>
    ipcRenderer.invoke('cancel-scheduled-task', id, reason),
  deleteScheduledTask: (id: string) => ipcRenderer.invoke('delete-scheduled-task', id),
  getWorkflowDefinitions: (workspaceId?: string) =>
    ipcRenderer.invoke('get-workflow-definitions', workspaceId),
  saveWorkflowDefinition: (workflow: WorkflowDefinitionCreateInput) =>
    ipcRenderer.invoke('save-workflow-definition', workflow),
  updateWorkflowDefinition: (id: string, partial: WorkflowDefinitionRendererUpdate) =>
    ipcRenderer.invoke('update-workflow-definition', id, partial),
  deleteWorkflowDefinition: (id: string) => ipcRenderer.invoke('delete-workflow-definition', id),
  getExecutionGraphDiagnostics: () =>
    ipcRenderer.invoke(
      'execution-graphs:diagnostics'
    ) as Promise<ExecutionGraphDiagnosticsSnapshot>,
  listExecutionGraphRevisions: (workspaceId?: string) =>
    ipcRenderer.invoke('execution-graphs:list', workspaceId) as Promise<
      readonly ExecutionGraphRevision[]
    >,
  getExecutionGraphRevision: (graphId: string, revision: number) =>
    ipcRenderer.invoke('execution-graphs:get', {
      graphId,
      revision
    }) as Promise<ExecutionGraphRevision | null>,
  getExecutionGraphLayout: (graphId: string, revision: number) =>
    ipcRenderer.invoke('execution-graphs:get-layout', {
      graphId,
      revision
    }) as Promise<ExecutionGraphLayout | null>,
  listExecutionRuns: (filter: ExecutionRunListFilter = {}) =>
    ipcRenderer.invoke('execution-runs:list', filter) as Promise<readonly ExecutionRunProjection[]>,
  getExecutionRun: (executionId: string) =>
    ipcRenderer.invoke('execution-runs:get', executionId) as Promise<ExecutionRunProjection | null>,
  getExecutionRunEvents: (executionId: string) =>
    ipcRenderer.invoke('execution-runs:events', executionId) as Promise<
      readonly ExecutionRunEvent[]
    >,
  appendExecutionStackStep: (command: ExecutionStackAppendCommand) =>
    ipcRenderer.invoke(
      'execution-runs:append-stack-step',
      command
    ) as Promise<ExecutionRunProjection>,
  cancelExecutionRun: (executionId: string, reason?: string) =>
    ipcRenderer.invoke(
      'execution-runs:cancel',
      executionId,
      reason
    ) as Promise<ExecutionRunProjection | null>,
  cancelExecutionRunStep: (command: ExecutionRunCancelStepCommand) =>
    ipcRenderer.invoke('execution-runs:cancel-step', command) as Promise<ExecutionRunProjection>,
  formalizeExecutionRun: (command: ExecutionRunFormalizeCommand) =>
    ipcRenderer.invoke('execution-runs:formalize', command) as Promise<ExecutionGraphRevision>,
  saveExecutionGraphLayout: (layout: ExecutionGraphLayout) =>
    ipcRenderer.invoke('execution-graphs:save-layout', layout) as Promise<ExecutionGraphLayout>,
  getWorkspaceBoards: (workspaceId?: string) =>
    ipcRenderer.invoke('get-workspace-boards', workspaceId) as Promise<WorkspaceBoardDefinition[]>,
  saveWorkspaceBoard: (board: any) =>
    ipcRenderer.invoke('save-workspace-board', board) as Promise<WorkspaceBoardDefinition>,
  updateWorkspaceBoard: (id: string, partial: any) =>
    ipcRenderer.invoke(
      'update-workspace-board',
      id,
      partial
    ) as Promise<WorkspaceBoardDefinition | null>,
  deleteWorkspaceBoard: (id: string) => ipcRenderer.invoke('delete-workspace-board', id),
  getWorkspaceBoardCards: (boardId?: string) =>
    ipcRenderer.invoke('get-workspace-board-cards', boardId) as Promise<WorkspaceBoardCard[]>,
  saveWorkspaceBoardCard: (card: any) =>
    ipcRenderer.invoke('save-workspace-board-card', card) as Promise<WorkspaceBoardCard>,
  updateWorkspaceBoardCard: (id: string, partial: any) =>
    ipcRenderer.invoke(
      'update-workspace-board-card',
      id,
      partial
    ) as Promise<WorkspaceBoardCard | null>,
  deleteWorkspaceBoardCard: (id: string) => ipcRenderer.invoke('delete-workspace-board-card', id),
  getEvidencePacks: (workspaceId?: string) =>
    ipcRenderer.invoke('get-evidence-packs', workspaceId) as Promise<EvidencePackRecord[]>,
  saveEvidencePack: (pack: Partial<EvidencePackRecord>) =>
    ipcRenderer.invoke('save-evidence-pack', pack) as Promise<EvidencePackRecord>,
  deleteEvidencePack: (id: string) => ipcRenderer.invoke('delete-evidence-pack', id),
  getCapabilityLedgerSnapshot: (workspaceId?: string) =>
    ipcRenderer.invoke(
      'get-capability-ledger-snapshot',
      workspaceId
    ) as Promise<CapabilityLedgerSnapshot>,
  getRepoConventionIndexes: (workspaceId?: string) =>
    ipcRenderer.invoke('get-repo-convention-indexes', workspaceId) as Promise<
      RepoConventionIndexSnapshot[]
    >,
  saveRepoConventionIndex: (snapshot: Partial<RepoConventionIndexSnapshot>) =>
    ipcRenderer.invoke(
      'save-repo-convention-index',
      snapshot
    ) as Promise<RepoConventionIndexSnapshot>,
  runWorkflowNow: (id: string) => ipcRenderer.invoke('run-workflow-now', id),
  setWorkflowUnattendedElevation: (id: string, level: string) =>
    ipcRenderer.invoke('set-workflow-unattended-elevation', id, level),
  getWorkflowRunSummaries: (workflowId?: string) =>
    ipcRenderer.invoke('get-workflow-run-summaries', workflowId),
  getWorkflowRunEvents: (filter: any = {}) => ipcRenderer.invoke('get-workflow-run-events', filter),
  getAgentStatsSummaries: (agentIds: string[]) =>
    ipcRenderer.invoke('get-agent-stats-summaries', agentIds),
  // Audit-run orchestration. startAuditRun resolves with the terminal record;
  // live phase/finding updates arrive via onAuditRunChanged ('audit-run-changed').
  startAuditRun: (input: {
    mode?: string
    chatId: string
    preferredProvider?: ProviderId
    workspacePath: string
    workspaceId?: string
  }) => ipcRenderer.invoke('audit-run:start', input),
  cancelAuditRun: (auditRunId: string) => ipcRenderer.invoke('audit-run:cancel', auditRunId),
  getAuditRun: (auditRunId: string) => ipcRenderer.invoke('get-audit-run', auditRunId),
  getAuditRuns: (workspaceId?: string) => ipcRenderer.invoke('get-audit-runs', workspaceId),
  getRunQueueJobs: (filter: any = {}) => ipcRenderer.invoke('get-run-queue-jobs', filter),
  requestRunQueueJob: (job: any) => ipcRenderer.invoke('request-run-queue-job', job),
  leaseRunQueueJob: (request: any = {}) => ipcRenderer.invoke('lease-run-queue-job', request),
  promoteQueuedJobForSteer: (
    input: PromoteQueuedJobForSteerInput
  ): Promise<PromoteQueuedJobForSteerResult> =>
    ipcRenderer.invoke('promote-queued-job-for-steer', input),
  leasePromotedSteerJob: (input: LeasePromotedSteerInput): Promise<LeasePromotedSteerJobResult> =>
    ipcRenderer.invoke('lease-promoted-steer-job', input),
  fallbackPromotedSteerJob: (
    input: FallbackPromotedSteerInput
  ): Promise<FallbackPromotedSteerJobResult> =>
    ipcRenderer.invoke('fallback-promoted-steer-job', input),
  transitionRunQueueJob: (runIdOrId: string, status: string, partial: any = {}) =>
    ipcRenderer.invoke('transition-run-queue-job', runIdOrId, status, partial),
  getRunRecoveryRecords: (filter: any = {}) =>
    ipcRenderer.invoke('get-run-recovery-records', filter),
  getRunEvents: (filter: any = {}) => ipcRenderer.invoke('get-run-events', filter),
  getRunEventReplay: (runId: string) => ipcRenderer.invoke('get-run-event-replay', runId),
  analyzeRun: (request: RunAnalystRequest) =>
    ipcRenderer.invoke('run-analyst:analyze', request) as Promise<RunAnalystSnapshot>,
  summarizeCloseout: (request: CloseoutSummaryRequest) =>
    ipcRenderer.invoke('closeout:summarize', request) as Promise<CloseoutSummarySnapshot>,
  proposeContinuation: (request: ContinuationProposalRequest) =>
    ipcRenderer.invoke('continuation:propose', request) as Promise<ContinuationProposalSnapshot>,
  getApprovalLedger: (filter: any = {}) => ipcRenderer.invoke('get-approval-ledger', filter),
  recordApprovalElevationAck: (input: {
    provider: string
    workspacePath: string | null
    toMode: string
    tier: number
  }) => ipcRenderer.invoke('record-approval-elevation-ack', input),
  getMemoryProposalPacks: (workspaceId?: string | null) =>
    ipcRenderer.invoke('get-memory-proposal-packs', workspaceId),
  getMemoryProposalPack: (packId: string) => ipcRenderer.invoke('get-memory-proposal-pack', packId),
  updateMemoryProposal: (packId: string, proposalId: string, partial: any) =>
    ipcRenderer.invoke('update-memory-proposal', { packId, proposalId, partial }),
  applyMemoryProposal: (packId: string, proposalId: string) =>
    ipcRenderer.invoke('apply-memory-proposal', { packId, proposalId }),
  runManualIntrospection: (input: {
    windowStart: string
    windowEnd: string
    workspaceId?: string
    workspacePath?: string
  }) => ipcRenderer.invoke('run-manual-introspection', input),
  getIntrospectionSchedule: (workspaceId?: string | null) =>
    ipcRenderer.invoke('get-introspection-schedule', workspaceId),
  updateIntrospectionSchedule: (partial: {
    enabled?: boolean
    workspaceId?: string | null
    lastRunAt?: string | null
    nextRunAt?: string | null
  }) => ipcRenderer.invoke('update-introspection-schedule', partial),
  getProductOperationsStatus: () => ipcRenderer.invoke('get-product-operations-status'),
  getProductCrashes: (filter: any = {}) => ipcRenderer.invoke('get-product-crashes', filter),
  recordProductCrash: (input: any) => ipcRenderer.invoke('record-product-crash', input),
  exportProductDiagnostics: (path?: string) =>
    ipcRenderer.invoke('export-product-diagnostics', path),
  exportProductAuditBundle: (request?: any) =>
    ipcRenderer.invoke('export-product-audit-bundle', request),
  verifyProductAuditBundle: (request?: any) =>
    ipcRenderer.invoke('verify-product-audit-bundle', request),
  purgeProductAuditRetention: (request?: any) =>
    ipcRenderer.invoke('purge-product-audit-retention', request),
  repairProductInstall: () => ipcRenderer.invoke('repair-product-install'),
  getAppShellStats: () =>
    ipcRenderer.invoke('app-shell-stats:snapshot') as Promise<AppShellStatsSnapshot>,
  // Tester-feedback intake (1.0.1). `getAppVersion` lets the bug-report
  // sheet show the same version string that `submit-bug-report` stamps
  // into the file. `submitBugReport` ships the form contents + an
  // auto-captured context block; main appends a Markdown entry to
  // `<userData>/TaskWraith/bug-reports.md`.
  getAppVersion: () => ipcRenderer.invoke('get-app-version') as Promise<string>,
  submitBugReport: (payload: {
    title: string
    description: string
    expected: string
    severity: 'info' | 'minor' | 'major' | 'blocking'
    context: {
      timestamp: string
      version: string
      provider: string
      workspace: string
      shell: string
      surface?: string
      chatKind?: string
      settingsTab?: string
      inspectorTab?: string
      theme?: string
      promptBubble?: string
      ensemble?: string
    }
  }) =>
    ipcRenderer.invoke('submit-bug-report', payload) as Promise<{
      ok: boolean
      path?: string
      error?: string
    }>,

  onGeminiOutput: (callback: (data: any) => void) => {
    const wrapped = (_event: unknown, data: unknown): void => callback(data)
    ipcRenderer.on('gemini-output', wrapped)
    return () => ipcRenderer.removeListener('gemini-output', wrapped)
  },
  onGeminiError: (callback: (error: any) => void) => {
    const wrapped = (_event: unknown, error: unknown): void => callback(error)
    ipcRenderer.on('gemini-error', wrapped)
    return () => ipcRenderer.removeListener('gemini-error', wrapped)
  },
  onGeminiExit: (callback: (code: any) => void) => {
    const wrapped = (_event: unknown, code: unknown): void => callback(code)
    ipcRenderer.on('gemini-exit', wrapped)
    return () => ipcRenderer.removeListener('gemini-exit', wrapped)
  },
  onAgentOutput: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('agent-output', wrapped)
    return () => ipcRenderer.removeListener('agent-output', wrapped)
  },
  onAgentError: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('agent-error', wrapped)
    return () => ipcRenderer.removeListener('agent-error', wrapped)
  },
  onAgentExit: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('agent-exit', wrapped)
    return () => ipcRenderer.removeListener('agent-exit', wrapped)
  },
  onRunQueueChanged: (callback: (jobs: any[]) => void) => {
    const wrapped = (_event: unknown, jobs: any[]): void => callback(jobs)
    ipcRenderer.on('run-queue-changed', wrapped)
    return () => ipcRenderer.removeListener('run-queue-changed', wrapped)
  },
  onRunEventsChanged: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('run-events-changed', wrapped)
    return () => ipcRenderer.removeListener('run-events-changed', wrapped)
  },
  onExecutionGraphChanged: (callback: (notice: ExecutionGraphChangedNotice) => void) => {
    const wrapped = (_event: unknown, notice: ExecutionGraphChangedNotice): void => callback(notice)
    ipcRenderer.on('execution-graph-changed', wrapped)
    return () => ipcRenderer.removeListener('execution-graph-changed', wrapped)
  },
  onAgentApprovalRequest: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('agent-approval-request', wrapped)
    return () => ipcRenderer.removeListener('agent-approval-request', wrapped)
  },
  onAgentApprovalTimeout: (
    callback: (payload: { approvalId: string; appliedMs: number; source: string }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { approvalId: string; appliedMs: number; source: string }
    ): void => callback(payload)
    ipcRenderer.on('agent-approval-timeout', wrapped)
    return () => ipcRenderer.removeListener('agent-approval-timeout', wrapped)
  },
  onAgentApprovalResolved: (
    callback: (payload: {
      approvalId: string
      action?: string
      decisionSource?: string
      provider?: string
      threadId?: string
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
        approvalId: string
        action?: string
        decisionSource?: string
        provider?: string
        threadId?: string
      }
    ): void => callback(payload)
    ipcRenderer.on('agent-approval-resolved', wrapped)
    return () => ipcRenderer.removeListener('agent-approval-resolved', wrapped)
  },
  onScheduledTasksChanged: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('scheduled-tasks-changed', wrapped)
    return () => ipcRenderer.removeListener('scheduled-tasks-changed', wrapped)
  },
  onWorkflowDefinitionsChanged: (callback: (payload: any) => void) => {
    const wrapped = (_event: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('workflow-definitions-changed', wrapped)
    return () => ipcRenderer.removeListener('workflow-definitions-changed', wrapped)
  },
  onWorkspaceBoardsChanged: (
    callback: (payload: { boards: WorkspaceBoardDefinition[]; cards: WorkspaceBoardCard[] }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { boards: WorkspaceBoardDefinition[]; cards: WorkspaceBoardCard[] }
    ): void => callback(payload)
    ipcRenderer.on('workspace-boards-changed', wrapped)
    return () => ipcRenderer.removeListener('workspace-boards-changed', wrapped)
  },
  onEvidencePacksChanged: (
    callback: (payload: { packs: EvidencePackRecord[]; ledger: CapabilityLedgerSnapshot }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { packs: EvidencePackRecord[]; ledger: CapabilityLedgerSnapshot }
    ): void => callback(payload)
    ipcRenderer.on('evidence-packs-changed', wrapped)
    return () => ipcRenderer.removeListener('evidence-packs-changed', wrapped)
  },
  // iOS-triggered roster-preset writes round-tripped back to the renderer (the
  // localStorage source of truth). The renderer persists, which re-syncs the
  // projected list back to the bridge.
  onEnsembleRosterPresetSaveRequested: (
    callback: (payload: { name: string; participants: unknown[] }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { name: string; participants: unknown[] }): void =>
      callback(payload)
    ipcRenderer.on('ensemble-roster-presets:save-requested', wrapped)
    return () => ipcRenderer.removeListener('ensemble-roster-presets:save-requested', wrapped)
  },
  onEnsembleRosterPresetImportRequested: (
    callback: (payload: { requestId: string; json: string; source?: string }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { requestId: string; json: string; source?: string }
    ): void => callback(payload)
    ipcRenderer.on('ensemble-roster-presets:import-requested', wrapped)
    return () => ipcRenderer.removeListener('ensemble-roster-presets:import-requested', wrapped)
  },
  sendEnsembleRosterPresetImportResult: (payload: {
    requestId: string
    ok: boolean
    importedCount?: number
    presetId?: string
    presetName?: string
    error?: string
  }) => ipcRenderer.send('ensemble-roster-presets:import-result', payload),
  onEnsembleAgentPoolRegistrationRequested: (
    callback: (payload: { requestId: string; participant: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { requestId: string; participant: unknown }): void =>
      callback(payload)
    ipcRenderer.on('ensemble-agent-pool:registration-requested', wrapped)
    return () => ipcRenderer.removeListener('ensemble-agent-pool:registration-requested', wrapped)
  },
  sendEnsembleAgentPoolRegistrationResult: (payload: {
    requestId: string
    ok: boolean
    pooledAgentId?: string
    pooledAgentIdentity?: unknown
    mode?: 'created' | 'coalesced' | 'updated'
    error?: string
  }) => ipcRenderer.send('ensemble-agent-pool:registration-result', payload),
  onEnsembleRosterPresetDeleteRequested: (callback: (presetId: string) => void) => {
    const wrapped = (_event: unknown, presetId: string): void => callback(presetId)
    ipcRenderer.on('ensemble-roster-presets:delete-requested', wrapped)
    return () => ipcRenderer.removeListener('ensemble-roster-presets:delete-requested', wrapped)
  },
  onAuditRunChanged: (callback: (run: any) => void) => {
    const wrapped = (_event: unknown, run: unknown): void => callback(run)
    ipcRenderer.on('audit-run-changed', wrapped)
    return () => ipcRenderer.removeListener('audit-run-changed', wrapped)
  },
  onUsageChanged: (callback: () => void) => {
    const wrapped = (): void => callback()
    ipcRenderer.on('usage-changed', wrapped)
    return () => ipcRenderer.removeListener('usage-changed', wrapped)
  },
  onExternalUsageUpdated: (callback: () => void) => {
    const wrapped = (): void => callback()
    ipcRenderer.on('external-usage-updated', wrapped)
    return () => ipcRenderer.removeListener('external-usage-updated', wrapped)
  },
  onWorkspaceActivityUpdated: (
    callback: (payload: { workspacePath: string; dayCount: number }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { workspacePath: string; dayCount: number }): void =>
      callback(payload)
    ipcRenderer.on('workspace-activity-updated', wrapped)
    return () => ipcRenderer.removeListener('workspace-activity-updated', wrapped)
  },
  onChatUpdated: (callback: (delivery: ChatUpdateDelivery) => void) => {
    const wrapped = (_event: unknown, delivery: ChatUpdateDelivery): void => callback(delivery)
    ipcRenderer.on('chat-updated', wrapped)
    return () => ipcRenderer.removeListener('chat-updated', wrapped)
  },
  ackChatUpdated: (ack: ChatUpdateAck) => ipcRenderer.send(CHAT_UPDATE_ACK_CHANNEL, ack),
  /** Agent-set theme tokens changed in main; re-apply without a reload. */
  onAgentThemeTokensChanged: (callback: (tokens: Record<string, string>) => void) => {
    const wrapped = (_event: unknown, tokens: Record<string, string>): void => callback(tokens)
    ipcRenderer.on('agent-theme-tokens-changed', wrapped)
    return () => ipcRenderer.removeListener('agent-theme-tokens-changed', wrapped)
  },
  onProjectsChanged: (callback: (projects: unknown) => void) => {
    const wrapped = (_event: unknown, projects: unknown): void => callback(projects)
    ipcRenderer.on('projects-changed', wrapped)
    return () => ipcRenderer.removeListener('projects-changed', wrapped)
  },
  onProjectReferenceProposalsChanged: (callback: (payload: { projectId: string }) => void) => {
    const wrapped = (_event: unknown, payload: { projectId: string }): void => callback(payload)
    ipcRenderer.on('project-reference-proposals-changed', wrapped)
    return () => ipcRenderer.removeListener('project-reference-proposals-changed', wrapped)
  },
  onContextCompactionProgress: (callback: (event: ContextCompactionProgressEvent) => void) => {
    const wrapped = (_event: unknown, event: ContextCompactionProgressEvent): void =>
      callback(event)
    ipcRenderer.on('context-compaction-progress', wrapped)
    return () => ipcRenderer.removeListener('context-compaction-progress', wrapped)
  },
  onParticipantWorkingTelemetry: (callback: (event: ParticipantWorkingTelemetryEvent) => void) => {
    const wrapped = (_event: unknown, event: ParticipantWorkingTelemetryEvent): void =>
      callback(event)
    ipcRenderer.on('participant-working-telemetry', wrapped)
    return () => ipcRenderer.removeListener('participant-working-telemetry', wrapped)
  },
  onHumanCollaborationUpdated: (callback: (payload: { chatId: string }) => void) => {
    const wrapped = (_event: unknown, payload: { chatId: string }): void => callback(payload)
    ipcRenderer.on('human-collaboration-updated', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-updated', wrapped)
  },
  // P2b auto-draft — the wrapped, provenance-carrying draft for the host
  // composer (display-only; sending stays a host action).
  onHumanCollaborationActionRequest: (
    callback: (payload: { chatId: string; messageId: string; draft: string }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { chatId: string; messageId: string; draft: string }
    ): void => callback(payload)
    ipcRenderer.on('human-collaboration-action-request', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-action-request', wrapped)
  },
  onHumanCollaborationRuntimeProjectionUpdate: (
    callback: (payload: { sessionId: string; projection: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { sessionId: string; projection: unknown }): void =>
      callback(payload)
    ipcRenderer.on('human-collaboration-runtime-projection-update', wrapped)
    return () =>
      ipcRenderer.removeListener('human-collaboration-runtime-projection-update', wrapped)
  },
  onHumanCollaborationRuntimeEncryptedFrame: (
    callback: (payload: { sessionId: string; frame: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { sessionId: string; frame: unknown }): void =>
      callback(payload)
    ipcRenderer.on('human-collaboration-runtime-encrypted-frame', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-runtime-encrypted-frame', wrapped)
  },
  // Host side: a collaborator began admission — surface the 6-digit SAS to compare.
  // mode 'reconnect' = pinned-identity re-admission (no human SAS compare step).
  onHumanCollaborationAdmissionBegan: (
    callback: (payload: {
      handshakeId: string
      chatId: string
      shareId: string
      displayName: string
      confirmCode: string
      mode?: 'admission' | 'reconnect'
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
        handshakeId: string
        chatId: string
        shareId: string
        displayName: string
        confirmCode: string
        mode?: 'admission' | 'reconnect'
      }
    ): void => callback(payload)
    ipcRenderer.on('human-collaboration-admission-began', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-admission-began', wrapped)
  },
  // Collaborator side: live projection updates for the joined shared chat.
  onHumanCollaborationCollaboratorProjection: (
    callback: (payload: { projection: unknown }) => void
  ) => {
    const wrapped = (_event: unknown, payload: { projection: unknown }): void => callback(payload)
    ipcRenderer.on('human-collaboration-collaborator-projection', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-collaborator-projection', wrapped)
  },
  // Collaborator side: connection/error status for the active join.
  onHumanCollaborationCollaboratorStatus: (
    callback: (payload: {
      connected?: boolean
      error?: string
      contributionRejected?: { code: string; message: string; clientMessageId?: string }
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
        connected?: boolean
        error?: string
        contributionRejected?: { code: string; message: string; clientMessageId?: string }
      }
    ): void => callback(payload)
    ipcRenderer.on('human-collaboration-collaborator-status', wrapped)
    return () => ipcRenderer.removeListener('human-collaboration-collaborator-status', wrapped)
  },
  // One backwards page of older transcript rows, answering a loadOlder.
  onHumanCollaborationCollaboratorOlderPage: (
    callback: (payload: {
      sessionId: string
      beforeRowId?: string
      rows: unknown[]
      hasMore: boolean
      oldestRowId?: string
      throttled?: boolean
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
        sessionId: string
        beforeRowId?: string
        rows: unknown[]
        hasMore: boolean
        oldestRowId?: string
        throttled?: boolean
      }
    ): void => callback(payload)
    ipcRenderer.on('human-collaboration-collaborator-older-page', wrapped)
    return () =>
      ipcRenderer.removeListener('human-collaboration-collaborator-older-page', wrapped)
  },
  // Trusted audio/video media refs for a foreground solo run. Main constructs
  // these refs itself and pushes them on this dedicated main-only channel, so
  // the renderer attaches them WITHOUT the image-only RAW-provider sanitizer
  // (a provider's stdout cannot forge this IPC). See applyAssistantMediaRefsToChat.
  onRunTrustedMediaRefs: (
    callback: (payload: { appChatId: string; appRunId: string; mediaRefs: unknown[] }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { appChatId: string; appRunId: string; mediaRefs: unknown[] }
    ): void => callback(payload)
    ipcRenderer.on('run-trusted-media-refs', wrapped)
    return () => ipcRenderer.removeListener('run-trusted-media-refs', wrapped)
  },
  onAppShellStatsChanged: (callback: (snapshot: AppShellStatsSnapshot) => void) => {
    const wrapped = (_event: unknown, snapshot: AppShellStatsSnapshot): void => callback(snapshot)
    ipcRenderer.on('app-shell-stats-changed', wrapped)
    return () => ipcRenderer.removeListener('app-shell-stats-changed', wrapped)
  },
  // 1.0.5-PO2 — Workspace popout live-refresh signal. Main process
  // emits when something in the popout's workspace has changed
  // (chat update, run progress, etc.). The popout debounces a
  // re-fetch on its end. Returns an unsubscribe function so the
  // popout can clean up on unmount.
  onWorkspacePopoutRefresh: (
    callback: (payload: {
      workspacePath: string
      reason: string
      externalWriteAllowed?: boolean
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { workspacePath: string; reason: string; externalWriteAllowed?: boolean }
    ): void => callback(payload)
    ipcRenderer.on('workspace-popout-refresh', wrapped)
    return () => ipcRenderer.removeListener('workspace-popout-refresh', wrapped)
  },
  onWorkspacePopoutOpenFile: (
    callback: (payload: { workspacePath: string; path: string; view?: 'editor' | 'diff' }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: { workspacePath: string; path: string; view?: 'editor' | 'diff' }
    ): void => callback(payload)
    ipcRenderer.on('workspace-popout-open-file', wrapped)
    return () => ipcRenderer.removeListener('workspace-popout-open-file', wrapped)
  },
  onSideChatDockRequest: (
    callback: (payload: {
      chatId: string
      parentChatId: string
      presentation: 'split' | 'drawer'
      draft?: string
      scrollState?: ChatPopoutScrollState
      roundExpansion?: ChatPopoutRoundExpansionSnapshot
    }) => void
  ) => {
    const wrapped = (
      _event: unknown,
      payload: {
        chatId: string
        parentChatId: string
        presentation: 'split' | 'drawer'
        draft?: string
        scrollState?: ChatPopoutScrollState
        roundExpansion?: ChatPopoutRoundExpansionSnapshot
      }
    ): void => callback(payload)
    ipcRenderer.on('side-chat:dock-request', wrapped)
    return () => ipcRenderer.removeListener('side-chat:dock-request', wrapped)
  },
  // Phase K3 — creative-app approval flow. Main process broadcasts
  // pending requests; renderer modal renders + collects decision.
  onCreativeActionRequest: (callback: (payload: unknown) => void) => {
    const wrapped = (_event: unknown, payload: unknown) => callback(payload)
    ipcRenderer.on('creative-action:request', wrapped)
    return () => ipcRenderer.removeListener('creative-action:request', wrapped)
  },
  decideCreativeAction: (
    requestId: string,
    approved: boolean,
    rememberForSession: boolean
  ): void => {
    ipcRenderer.send('creative-action:decide', { requestId, approved, rememberForSession })
  },
  removeListeners: () => {
    ipcRenderer.removeAllListeners('gemini-output')
    ipcRenderer.removeAllListeners('gemini-error')
    ipcRenderer.removeAllListeners('gemini-exit')
    ipcRenderer.removeAllListeners('agent-output')
    ipcRenderer.removeAllListeners('agent-error')
    ipcRenderer.removeAllListeners('agent-exit')
    ipcRenderer.removeAllListeners('run-queue-changed')
    ipcRenderer.removeAllListeners('run-events-changed')
    ipcRenderer.removeAllListeners('execution-graph-changed')
    ipcRenderer.removeAllListeners('work-locks:changed')
    ipcRenderer.removeAllListeners('agent-approval-request')
    ipcRenderer.removeAllListeners('agent-approval-timeout')
    ipcRenderer.removeAllListeners('agent-approval-resolved')
    ipcRenderer.removeAllListeners('spellcheck:context-menu')
    ipcRenderer.removeAllListeners('update-status-changed')
    ipcRenderer.removeAllListeners('scheduled-tasks-changed')
    ipcRenderer.removeAllListeners('workflow-definitions-changed')
    ipcRenderer.removeAllListeners('workspace-boards-changed')
    ipcRenderer.removeAllListeners('audit-run-changed')
    ipcRenderer.removeAllListeners('usage-changed')
    ipcRenderer.removeAllListeners('chat-updated')
    ipcRenderer.removeAllListeners('participant-working-telemetry')
    ipcRenderer.removeAllListeners('human-collaboration-updated')
    ipcRenderer.removeAllListeners('human-collaboration-runtime-projection-update')
    ipcRenderer.removeAllListeners('human-collaboration-runtime-encrypted-frame')
    ipcRenderer.removeAllListeners('human-collaboration-admission-began')
    ipcRenderer.removeAllListeners('human-collaboration-collaborator-projection')
    ipcRenderer.removeAllListeners('human-collaboration-collaborator-status')
    ipcRenderer.removeAllListeners('run-trusted-media-refs')
    ipcRenderer.removeAllListeners('app-shell-stats-changed')
    ipcRenderer.removeAllListeners('workspace-popout-refresh')
    ipcRenderer.removeAllListeners('workspace-popout-open-file')
    ipcRenderer.removeAllListeners('side-chat:dock-request')
    ipcRenderer.removeAllListeners('creative-action:request')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
