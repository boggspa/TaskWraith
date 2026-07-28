/**
 * Versioned local-control contract shared by Electron main and the terminal
 * sidecar. The transport is newline-delimited JSON over a same-user local
 * socket; this file deliberately contains no Node/Electron imports so clients
 * can compile it independently.
 */

export const TASKWRAITH_CONTROL_PROTOCOL_VERSION = 1 as const
export const TASKWRAITH_CONTROL_CLIENT_NAME = 'taskwraith-tui' as const
export const TASKWRAITH_CONTROL_MAX_LINE_BYTES = 1_000_000

export type TaskWraithControlCapability =
  | 'snapshot'
  | 'transcript'
  | 'compose'
  | 'cancel'
  | 'ensemble'
  | 'provider-presentation'
  | 'configure'

export interface TaskWraithControlWorkspace {
  id: string
  name: string
  path: string
  pinned: boolean
  updatedAt: number
}

export type TaskWraithControlThreadStatus =
  | 'idle'
  | 'working'
  | 'needs-input'
  | 'queued'
  | 'failed'
  | 'cancelled'
  | 'complete'

export interface TaskWraithControlProviderPresentation {
  runtimeProvider: string
  displayProvider: string
  hueKey: string
  accent: string
  model?: string
  modelLabel?: string
  shortCode: string
}

export interface TaskWraithControlParticipant {
  id: string
  provider: string
  displayProvider: string
  hueKey: string
  accent: string
  shortCode: string
  role: string
  model?: string
  reasoning?: string
  order: number
  stage?: 'scout' | 'worker' | 'reviewer' | 'background'
  status?: string
  active: boolean
  next: boolean
  enabled: boolean
}

export interface TaskWraithControlEnsembleSummary {
  preset: string
  mode: string
  fanout: string
  continuationHops: number
  maxContinuationHops: number
  backgroundCount: number
  participants: TaskWraithControlParticipant[]
}

export interface TaskWraithControlThread {
  id: string
  workspaceId: string | null
  parentThreadId?: string
  title: string
  provider: TaskWraithControlProviderPresentation
  reasoning?: string
  status: TaskWraithControlThreadStatus
  chatKind: 'single' | 'ensemble'
  archived: boolean
  pinned: boolean
  updatedAt: number
  messageCount: number
  wallTimeMs?: number
  tokenEstimate?: number
  costText?: string
  ensemble?: TaskWraithControlEnsembleSummary
}

export interface TaskWraithControlSnapshot {
  generatedAt: string
  sequence: number
  workspaces: TaskWraithControlWorkspace[]
  threads: TaskWraithControlThread[]
}

export interface TaskWraithControlToolEntry {
  name: string
  category: 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'
  status: 'running' | 'success' | 'error'
  detail?: string
  file?: string
  additions?: number
  deletions?: number
}

export interface TaskWraithControlTranscriptRow {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error'
  kind: string
  speaker: string
  provider?: TaskWraithControlProviderPresentation
  text: string
  timestamp: string
  truncated: boolean
  tools?: TaskWraithControlToolEntry[]
  thinking?: {
    title: string
    text: string
    status?: 'running' | 'success' | 'error'
  }
}

export interface TaskWraithControlWorkspaceContext {
  id: string
  name: string
  path: string
  access: 'read' | 'write'
  primary: boolean
}

export interface TaskWraithControlThreadContext {
  workspaces: TaskWraithControlWorkspaceContext[]
  provider: TaskWraithControlProviderPresentation
  reasoning?: string
  permission?: string
  wallTimeMs?: number
  tokenEstimate?: number
  costText?: string
  ensemble?: TaskWraithControlEnsembleSummary
}

export interface TaskWraithControlThreadSnapshot {
  generatedAt: string
  sequence: number
  thread: TaskWraithControlThread
  rows: TaskWraithControlTranscriptRow[]
  totalRows: number
  hasMoreAbove: boolean
  context: TaskWraithControlThreadContext
}

export interface TaskWraithControlReasoningOffer {
  id: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
}

export interface TaskWraithControlModelOffer {
  id: string
  label?: string
  isDefault?: boolean
  /** Matches the thread's current model (facade-derived, never client-set). */
  current?: boolean
  disabled?: boolean
  disabledReason?: string
  /** ISO date the provider retires this model, when known. */
  retiresAt?: string
  reasoningEfforts: TaskWraithControlReasoningOffer[]
  defaultReasoningEffort?: string
}

/**
 * The host-projected picker for one thread. Offers are derived main-side from
 * the same curated catalogue the App picker falls back to; the client may only
 * choose among them and can never synthesize an offer locally. A `locked`
 * reason means the thread has no terminal-switchable models (ensemble threads,
 * machine-dependent catalogues, retired providers) and selection must happen
 * in the App.
 */
export interface TaskWraithControlThreadOffers {
  threadId: string
  provider: TaskWraithControlProviderPresentation
  currentModel?: string
  currentReasoningEffort?: string
  models: TaskWraithControlModelOffer[]
  source: 'curated'
  locked?: string
}

export type TaskWraithControlRequest =
  | {
      type: 'request'
      id: string
      method: 'snapshot.get'
      params?: Record<string, never>
    }
  | {
      type: 'request'
      id: string
      method: 'thread.select'
      params: { threadId: string; limit?: number }
    }
  | {
      type: 'request'
      id: string
      method: 'composer.send'
      /** `model`/`reasoningEffort` may only name ids from `thread.offers` for
       * the same thread; the facade validates and refuses anything else. */
      params: { threadId: string; text: string; model?: string; reasoningEffort?: string }
    }
  | {
      type: 'request'
      id: string
      method: 'run.cancel'
      params: { threadId: string }
    }
  | {
      type: 'request'
      id: string
      method: 'thread.offers'
      params: { threadId: string }
    }
  | {
      type: 'request'
      id: string
      method: 'ensemble.seat.toggle'
      /** Enable/disable one EXISTING seat by id. The client can never compose
       * roster entries; the facade replays the canonical roster with only this
       * flag flipped through the same main-owned roster action iOS uses. */
      params: { threadId: string; participantId: string; enabled: boolean }
    }
  | {
      type: 'request'
      id: string
      method: 'ping'
      params?: Record<string, never>
    }

export interface TaskWraithControlHello {
  type: 'hello'
  protocolVersion: typeof TASKWRAITH_CONTROL_PROTOCOL_VERSION
  client: typeof TASKWRAITH_CONTROL_CLIENT_NAME
  clientVersion: string
  token: string
  capabilities: TaskWraithControlCapability[]
}

export type TaskWraithControlClientMessage = TaskWraithControlHello | TaskWraithControlRequest

export interface TaskWraithControlWelcome {
  type: 'welcome'
  protocolVersion: typeof TASKWRAITH_CONTROL_PROTOCOL_VERSION
  hostVersion: string
  sessionId: string
  capabilities: TaskWraithControlCapability[]
}

export interface TaskWraithControlResponse {
  type: 'response'
  id: string
  ok: true
  result: unknown
}

export interface TaskWraithControlErrorResponse {
  type: 'response'
  id: string
  ok: false
  error: {
    code: string
    message: string
  }
}

export interface TaskWraithControlEvent {
  type: 'event'
  event: 'snapshot.changed' | 'thread.changed' | 'host.closing'
  sequence: number
  payload?: unknown
}

export type TaskWraithControlHostMessage =
  | TaskWraithControlWelcome
  | TaskWraithControlResponse
  | TaskWraithControlErrorResponse
  | TaskWraithControlEvent

export interface TaskWraithControlDiscovery {
  protocolVersion: typeof TASKWRAITH_CONTROL_PROTOCOL_VERSION
  socketPath: string
  tokenPath: string
  pid: number
  startedAt: string
}

export type TaskWraithControlDecodeResult =
  | { ok: true; message: TaskWraithControlClientMessage }
  | { ok: false; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max = 16_000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function decodeTaskWraithControlClientMessage(
  value: unknown
): TaskWraithControlDecodeResult {
  if (!isRecord(value)) return { ok: false, error: 'message must be an object' }

  if (value.type === 'hello') {
    if (value.protocolVersion !== TASKWRAITH_CONTROL_PROTOCOL_VERSION) {
      return { ok: false, error: 'unsupported protocol version' }
    }
    if (value.client !== TASKWRAITH_CONTROL_CLIENT_NAME) {
      return { ok: false, error: 'unsupported client' }
    }
    if (!isNonEmptyString(value.clientVersion, 80)) {
      return { ok: false, error: 'clientVersion is required' }
    }
    if (!isNonEmptyString(value.token, 512)) {
      return { ok: false, error: 'token is required' }
    }
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 32) {
      return { ok: false, error: 'capabilities must be a bounded array' }
    }
    return { ok: true, message: value as unknown as TaskWraithControlHello }
  }

  if (value.type !== 'request' || !isNonEmptyString(value.id, 160)) {
    return { ok: false, error: 'request id is required' }
  }
  if (!isNonEmptyString(value.method, 80)) {
    return { ok: false, error: 'request method is required' }
  }
  if (
    ![
      'snapshot.get',
      'thread.select',
      'composer.send',
      'run.cancel',
      'thread.offers',
      'ensemble.seat.toggle',
      'ping'
    ].includes(value.method)
  ) {
    return { ok: false, error: 'unknown request method' }
  }
  const params = isRecord(value.params) ? value.params : {}
  if (value.method === 'thread.select') {
    if (!isNonEmptyString(params.threadId, 512)) {
      return { ok: false, error: 'threadId is required' }
    }
    if (
      params.limit !== undefined &&
      (typeof params.limit !== 'number' ||
        !Number.isInteger(params.limit) ||
        params.limit < 1 ||
        params.limit > 200)
    ) {
      return { ok: false, error: 'limit must be an integer from 1 to 200' }
    }
  }
  if (value.method === 'composer.send') {
    if (!isNonEmptyString(params.threadId, 512)) {
      return { ok: false, error: 'threadId is required' }
    }
    if (!isNonEmptyString(params.text, 12_000) || !params.text.trim()) {
      return { ok: false, error: 'composer text is required' }
    }
    if (params.model !== undefined && !isNonEmptyString(params.model, 200)) {
      return { ok: false, error: 'model must be a bounded string' }
    }
    if (params.reasoningEffort !== undefined && !isNonEmptyString(params.reasoningEffort, 40)) {
      return { ok: false, error: 'reasoningEffort must be a bounded string' }
    }
  }
  if (value.method === 'run.cancel' && !isNonEmptyString(params.threadId, 512)) {
    return { ok: false, error: 'threadId is required' }
  }
  if (value.method === 'thread.offers' && !isNonEmptyString(params.threadId, 512)) {
    return { ok: false, error: 'threadId is required' }
  }
  if (value.method === 'ensemble.seat.toggle') {
    if (!isNonEmptyString(params.threadId, 512)) {
      return { ok: false, error: 'threadId is required' }
    }
    if (!isNonEmptyString(params.participantId, 200)) {
      return { ok: false, error: 'participantId is required' }
    }
    if (typeof params.enabled !== 'boolean') {
      return { ok: false, error: 'enabled must be a boolean' }
    }
  }
  return { ok: true, message: value as unknown as TaskWraithControlRequest }
}
