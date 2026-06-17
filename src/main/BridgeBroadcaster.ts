import type { ChatRecord, ProviderId, WorkspaceRecord } from './store/types'
import type { AllowlistDecision, PrepareStartTurnEvaluation } from './RemoteWorkspaceAllowlist'
import {
  capabilitiesForRemoteWorkspaceEntry,
  GLOBAL_REMOTE_SCOPE
} from './RemoteWorkspaceAllowlist'
import type { RemoteProjectionEnvelope, RemoteTaskCapabilities } from './RemoteTaskProjection'

/**
 * BridgeBroadcaster — pushes workspace + thread summaries from the
 * Electron main process to the TaskWraithBridge daemon over JSON-RPC,
 * which then forwards them to paired iOS companion clients.
 *
 * Why this exists
 * ---------------
 * The iOS companion previously had nothing to render: the daemon
 * forwarded raw run events (`bridge.runEvent`) and pairing acks, but
 * never told iOS *which workspaces exist* or *which chats are open*.
 * Without that data the companion shows empty states on first connect
 * and stays empty until a desktop user happens to start a run.
 *
 * This class fills that gap. It owns four notifications — list+update
 * for both workspaces and threads — and a `broadcastSnapshot()` helper
 * the main process calls when the daemon reports a new iOS subscriber.
 * Each notification carries a minimal, version-tolerant summary
 * (additive fields only — older clients silently drop unknown keys).
 *
 * Coordination
 * ------------
 * The daemon-side handler for these methods + the iOS-side consumer
 * land in parallel commits. Until both land this side is a no-op:
 * the daemon receives the notifications and routes them to zero
 * subscribers. Adding the broadcaster early lets the other two slices
 * land independently and verify the wire shape in isolation.
 *
 * Throttling
 * ----------
 * Run events fire fast (often several per second during an active
 * run). Without throttling we'd re-send the entire workspace+thread
 * lists on every single message. The broadcaster coalesces calls per
 * method name within a configurable window (default 1s). Single
 * `broadcastWorkspaceUpdated(id)` / `broadcastThreadUpdated(id)` calls
 * each have their own throttle slot so two updates for different
 * chats in the same tick both fire — only redundant calls for the
 * *same* method+id collapse.
 */

/** Minimal projection of `WorkspaceRecord` for iOS rendering. */
export interface WorkspaceSummary {
  workspaceId: string
  displayName: string
  path: string
  chatCount: number
  runningChatCount: number
  /** ISO8601. Omitted when AppStore has no timestamp for the row. */
  lastActivityAt?: string
  pinned?: boolean
  capabilities?: RemoteTaskCapabilities
}

export type ThreadSummaryStatus = 'idle' | 'running' | 'failed' | 'success'

/** Minimal projection of `ChatRecord` for iOS rendering. */
export interface ThreadSummary {
  chatId: string
  title: string
  /** Null for global (non-workspace) chats. */
  workspaceId: string | null
  provider: ProviderId
  status: ThreadSummaryStatus
  /** ISO8601. Omitted when AppStore has no timestamp. */
  lastMessageAt?: string
  parentChatId?: string
  pinned?: boolean
  runId?: string
  runStartedAt?: string
}

/** Narrowed view of `AppStore` the broadcaster needs. Using an
 * interface instead of `typeof AppStore` lets tests pass an in-memory
 * fixture without mocking the electron module. */
export interface BridgeBroadcasterAppStore {
  getWorkspaces(): WorkspaceRecord[]
  getChats(workspaceId?: string): ChatRecord[]
  getChat(chatId: string): ChatRecord | null
}

export interface BridgeBroadcasterDaemon {
  notify(method: string, params?: unknown): void
}

export interface BridgeBroadcasterAllowlist {
  evaluate(check: PrepareStartTurnEvaluation): AllowlistDecision
}

export interface BridgeBroadcasterProjectionSource {
  listRemoteProjectionEnvelopes(): RemoteProjectionEnvelope[]
}

export interface BridgeBroadcasterOptions {
  daemon: BridgeBroadcasterDaemon
  appStore: BridgeBroadcasterAppStore
  allowlist?: BridgeBroadcasterAllowlist
  projectionSource?: BridgeBroadcasterProjectionSource
  log?: (line: string) => void
  /** Throttle: at most one broadcast per method-name within this window.
   * Per-id updates throttle separately (method + ":" + id). Default 1000ms. */
  throttleMs?: number
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Resolver for legacy chat workspace ids (see WorkspaceIdentity.ts):
   * chat records may carry display-name ids ("Test 3") instead of the
   * workspace uuid. When provided, every chat read is canonicalized
   * before visibility checks / counts / summaries — otherwise those
   * chats silently vanish from allowlisted workspaces. Returns null
   * when unresolvable (the chat keeps its raw id and stays invisible).
   */
  canonicalChatWorkspaceId?: (workspaceId: string | null | undefined) => string | null
}

export interface ProviderModelOption {
  id: string
  label: string
  isDefault?: boolean
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>
  defaultReasoningEffort?: string | null
}

/** Per-provider model catalogs — drives the remote client's hierarchical
 * provider→model picker. Assembled by the caller (live CLI/daemon queries
 * + static fallbacks); the broadcaster only ships it. */
export interface ProviderModelsMessage {
  providers: Array<{ provider: string; models: ProviderModelOption[] }>
}

export const BRIDGE_BROADCAST_METHODS = {
  providerModels: 'bridge.broadcastProviderModels',
  workspaceList: 'bridge.broadcastWorkspaceList',
  threadList: 'bridge.broadcastThreadList',
  workspaceUpdated: 'bridge.broadcastWorkspaceUpdated',
  threadUpdated: 'bridge.broadcastThreadUpdated',
  remoteProjection: 'bridge.broadcastRemoteProjection',
  remoteProjectionSnapshot: 'bridge.broadcastRemoteProjectionSnapshot',
  usageRollup: 'bridge.broadcastUsageRollup',
  modelUsage: 'bridge.broadcastModelUsage',
  welcomeDashboard: 'bridge.broadcastWelcomeDashboard'
} as const

/** Convert a `WorkspaceRecord` plus the chats living inside it to the
 * minimal summary shape. Pure — exported separately so tests don't
 * need to instantiate the broadcaster to verify the projection. */
export function workspaceRecordToSummary(
  workspace: WorkspaceRecord,
  chats: ChatRecord[],
  capabilities?: RemoteTaskCapabilities
): WorkspaceSummary {
  const scopedChats = chats.filter((chat) => chat.workspaceId === workspace.id)
  const runningChatCount = scopedChats.filter(isChatRunning).length
  // `lastOpenedAt` is the closest proxy AppStore exposes to "last
  // activity in this workspace". `updatedAt` on chats also moves but
  // is per-chat; the workspace row's own number wins for display.
  const lastActivityAt = msToIsoOrUndefined(workspace.lastOpenedAt)
  const summary: WorkspaceSummary = {
    workspaceId: workspace.id,
    displayName: workspace.displayName || workspace.path,
    path: workspace.path,
    chatCount: scopedChats.length,
    runningChatCount,
    pinned: Boolean(workspace.pinned)
  }
  if (capabilities !== undefined) {
    summary.capabilities = capabilities
  }
  if (lastActivityAt !== undefined) {
    summary.lastActivityAt = lastActivityAt
  }
  return summary
}

/** Convert a `ChatRecord` to the iOS-facing summary. Defaults
 * (`provider: 'gemini'` when missing, `status: 'idle'` when no runs)
 * mirror the desktop sidebar's behavior for legacy records. */
export function chatRecordToSummary(chat: ChatRecord): ThreadSummary {
  const provider: ProviderId = chat.provider ?? 'gemini'
  const status = deriveThreadStatus(chat)
  const runningRun = latestRunningRun(chat)
  const lastMessageAt = msToIsoOrUndefined(chat.updatedAt)
  // `scope: 'global'` is the canonical signal but for the iOS contract
  // we collapse "no workspace id" → null regardless, which catches both
  // explicit global chats and any legacy record missing `workspaceId`.
  const workspaceId = chat.workspaceId && chat.workspaceId.length > 0 ? chat.workspaceId : null
  const summary: ThreadSummary = {
    chatId: chat.appChatId,
    title: chat.title || 'Untitled chat',
    workspaceId,
    provider,
    status,
    pinned: Boolean(chat.pinned)
  }
  if (chat.parentChatId) {
    summary.parentChatId = chat.parentChatId
  }
  if (runningRun?.runId) {
    summary.runId = runningRun.runId
    const runStartedAt = isoOrUndefined(runningRun.startedAt)
    if (runStartedAt !== undefined) {
      summary.runStartedAt = runStartedAt
    }
  }
  if (lastMessageAt !== undefined) {
    summary.lastMessageAt = lastMessageAt
  }
  return summary
}

/** Status derivation rules:
 *   - If any run on the chat is still `running` → `running`.
 *   - Else, if the most recently started run is `failed` or `cancelled`
 *     → `failed`.
 *   - Else, if the most recently started run is `success` or
 *     `success_with_warnings` → `success`.
 *   - Else (no runs, or an unrecognized status string) → `idle`. */
function deriveThreadStatus(chat: ChatRecord): ThreadSummaryStatus {
  const runs = chat.runs ?? []
  if (runs.length === 0) return 'idle'
  if (runs.some((run) => run.status === 'running')) return 'running'
  // Pick the run with the most recent startedAt as the canonical
  // "latest". `runs` is loosely ordered (appended on each new run)
  // but we don't rely on append order.
  const latest = runs.slice().sort((a, b) => {
    const aTime = Date.parse(a.startedAt || '') || 0
    const bTime = Date.parse(b.startedAt || '') || 0
    return bTime - aTime
  })[0]
  switch (latest.status) {
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'success':
    case 'success_with_warnings':
      return 'success'
    default:
      return 'idle'
  }
}

function isChatRunning(chat: ChatRecord): boolean {
  return (chat.runs ?? []).some((run) => run.status === 'running')
}

function latestRunningRun(chat: ChatRecord): ChatRecord['runs'][number] | undefined {
  return (chat.runs ?? [])
    .filter((run) => run.status === 'running')
    .slice()
    .sort((a, b) => {
      const aTime = Date.parse(a.startedAt || '') || 0
      const bTime = Date.parse(b.startedAt || '') || 0
      return bTime - aTime
    })[0]
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
  return new Date(timestamp).toISOString()
}

function msToIsoOrUndefined(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  try {
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

export class BridgeBroadcaster {
  private readonly daemon: BridgeBroadcasterDaemon
  private readonly appStore: BridgeBroadcasterAppStore
  private readonly allowlist?: BridgeBroadcasterAllowlist
  private readonly projectionSource?: BridgeBroadcasterProjectionSource
  private readonly log?: (line: string) => void
  private readonly throttleMs: number
  private readonly now: () => number
  private readonly canonicalChatWorkspaceId?: (
    workspaceId: string | null | undefined
  ) => string | null
  /** Per-throttle-key timestamp of the last successful emit. List
   * methods key on the bare method name; updated methods key on
   * `method:id` so two different chats can update in the same tick. */
  private readonly lastEmitMs = new Map<string, number>()

  constructor(options: BridgeBroadcasterOptions) {
    this.daemon = options.daemon
    this.appStore = options.appStore
    this.allowlist = options.allowlist
    this.projectionSource = options.projectionSource
    this.log = options.log
    this.throttleMs = options.throttleMs ?? 1000
    this.now = options.now ?? Date.now
    this.canonicalChatWorkspaceId = options.canonicalChatWorkspaceId
  }

  private canonicalizeChat(chat: ChatRecord): ChatRecord {
    const resolve = this.canonicalChatWorkspaceId
    if (!resolve || !chat.workspaceId) return chat
    const canonical = resolve(chat.workspaceId)
    if (!canonical || canonical === chat.workspaceId) return chat
    return { ...chat, workspaceId: canonical }
  }

  private canonicalizeChats(chats: ChatRecord[]): ChatRecord[] {
    if (!this.canonicalChatWorkspaceId) return chats
    return chats.map((chat) => this.canonicalizeChat(chat))
  }

  /** Per-provider quota windows for the remote Usage tab (Model Usage
   * sidebar parity). Bounded at source — a few KB, well under the relay
   * frame cap. */
  broadcastModelUsage(message: Record<string, unknown>): void {
    const method = BRIDGE_BROADCAST_METHODS.modelUsage
    if (!this.shouldEmit(method)) return
    this.sendNotify(method, message)
  }

  /** Token totals for the remote heatmap chips (24h/7d/90d, per provider). */
  broadcastUsageRollup(message: Record<string, unknown>): void {
    const method = BRIDGE_BROADCAST_METHODS.usageRollup
    if (!this.shouldEmit(method)) return
    this.sendNotify(method, message)
  }

  /** The Electron welcome stats dashboard, projected for paired devices
   * (see RemoteWelcomeDashboard / Swift WelcomeDashboard). */
  broadcastWelcomeDashboard(message: Record<string, unknown>): void {
    const method = BRIDGE_BROADCAST_METHODS.welcomeDashboard
    if (!this.shouldEmit(method)) return
    this.sendNotify(method, message)
  }

  /** Ship the per-provider model catalogs (see ProviderModelsMessage). */
  broadcastProviderModels(message: ProviderModelsMessage): void {
    const method = BRIDGE_BROADCAST_METHODS.providerModels
    if (!this.shouldEmit(method)) return
    this.sendNotify(method, message)
  }

  /** Build a current snapshot from AppStore + emit
   * `bridge.broadcastWorkspaceList`. */
  broadcastWorkspaceList(): void {
    const method = BRIDGE_BROADCAST_METHODS.workspaceList
    if (!this.shouldEmit(method)) return
    let chats: ChatRecord[]
    let workspaces: WorkspaceRecord[]
    try {
      workspaces = this.appStore.getWorkspaces()
      chats = this.canonicalizeChats(this.appStore.getChats())
    } catch (err) {
      this.logErr(`failed to load workspaces/chats for ${method}`, err)
      return
    }
    const visibleWorkspaces = this.visibleWorkspaces(workspaces)
    const visibleWorkspaceIds = new Set(visibleWorkspaces.map((ws) => ws.id))
    const visibleChats = this.visibleChats(chats, visibleWorkspaceIds)
    const summaries = visibleWorkspaces.map((ws) => this.workspaceRecordToSummary(ws, visibleChats))
    this.sendNotify(method, { workspaces: summaries })
  }

  /** Build a current snapshot from AppStore + emit
   * `bridge.broadcastThreadList`. */
  broadcastThreadList(): void {
    const method = BRIDGE_BROADCAST_METHODS.threadList
    if (!this.shouldEmit(method)) return
    let chats: ChatRecord[]
    try {
      chats = this.canonicalizeChats(this.appStore.getChats())
    } catch (err) {
      this.logErr(`failed to load chats for ${method}`, err)
      return
    }
    const visibleWorkspaceIds = this.visibleWorkspaceIdsFromChats(chats)
    const threads = this.visibleChats(chats, visibleWorkspaceIds).map(chatRecordToSummary)
    this.sendNotify(method, { threads })
  }

  /** Emit `bridge.broadcastWorkspaceUpdated` for a single workspace.
   * Silently no-ops when the workspace isn't found (it may have just
   * been deleted — the deletion path triggers a list broadcast). */
  broadcastWorkspaceUpdated(workspaceId: string): void {
    const method = BRIDGE_BROADCAST_METHODS.workspaceUpdated
    const throttleKey = `${method}:${workspaceId}`
    if (!this.shouldEmit(throttleKey)) return
    let workspaces: WorkspaceRecord[]
    let chats: ChatRecord[]
    try {
      workspaces = this.appStore.getWorkspaces()
      chats = this.canonicalizeChats(this.appStore.getChats())
    } catch (err) {
      this.logErr(`failed to load workspace ${workspaceId} for ${method}`, err)
      return
    }
    const workspace = workspaces.find((w) => w.id === workspaceId)
    if (!workspace) {
      this.log?.(`[BridgeBroadcaster] ${method} skipped — workspace ${workspaceId} not found`)
      return
    }
    if (!this.isWorkspaceVisible(workspace.id)) {
      this.log?.(`[BridgeBroadcaster] ${method} skipped — workspace ${workspaceId} not allowed`)
      return
    }
    const summary = this.workspaceRecordToSummary(workspace, chats)
    this.sendNotify(method, { workspace: summary })
  }

  /** Emit `bridge.broadcastThreadUpdated` for a single chat. */
  broadcastThreadUpdated(chatId: string): void {
    const method = BRIDGE_BROADCAST_METHODS.threadUpdated
    const throttleKey = `${method}:${chatId}`
    if (!this.shouldEmit(throttleKey)) return
    let chat: ChatRecord | null
    try {
      chat = this.appStore.getChat(chatId)
    } catch (err) {
      this.logErr(`failed to load chat ${chatId} for ${method}`, err)
      return
    }
    if (!chat) {
      this.log?.(`[BridgeBroadcaster] ${method} skipped — chat ${chatId} not found`)
      return
    }
    chat = this.canonicalizeChat(chat)
    if (!this.isChatVisible(chat)) {
      this.log?.(`[BridgeBroadcaster] ${method} skipped — chat ${chatId} not allowed`)
      return
    }
    const summary = chatRecordToSummary(chat)
    this.sendNotify(method, { thread: summary })
  }

  /** Emit one Mac-authored remote projection envelope. This is used for
   * low-latency question/approval card changes without requiring the
   * daemon to infer state from raw run events. */
  broadcastRemoteProjection(envelope: RemoteProjectionEnvelope): void {
    this.sendNotify(BRIDGE_BROADCAST_METHODS.remoteProjection, { envelope })
  }

  /** Emit a current set of remote projection envelopes. Called on
   * subscribe so a new iOS client receives task-feed/question state
   * immediately, and by main-process hooks after task-affecting
   * mutations. */
  broadcastRemoteProjectionSnapshot(): void {
    const method = BRIDGE_BROADCAST_METHODS.remoteProjectionSnapshot
    if (!this.projectionSource) return
    if (!this.shouldEmit(method)) return
    let projections: RemoteProjectionEnvelope[]
    try {
      projections = this.projectionSource.listRemoteProjectionEnvelopes()
    } catch (err) {
      this.logErr(`failed to load remote projections for ${method}`, err)
      return
    }
    this.sendNotify(method, { projections })
  }

  /** Fire both full-list broadcasts. Called when a new iOS client
   * subscribes (so it sees the current world rather than waiting for
   * the next mutation). */
  broadcastSnapshot(): void {
    this.resetThrottle()
    this.broadcastWorkspaceList()
    this.broadcastThreadList()
    this.broadcastRemoteProjectionSnapshot()
  }

  /** Reset throttle state. Useful for tests or when the daemon
   * reconnects and we want a fresh snapshot to land immediately. */
  resetThrottle(): void {
    this.lastEmitMs.clear()
  }

  private shouldEmit(throttleKey: string): boolean {
    const last = this.lastEmitMs.get(throttleKey)
    const now = this.now()
    if (last !== undefined && now - last < this.throttleMs) {
      this.log?.(
        `[BridgeBroadcaster] throttled ${throttleKey} (${now - last}ms < ${this.throttleMs}ms)`
      )
      return false
    }
    this.lastEmitMs.set(throttleKey, now)
    return true
  }

  private visibleWorkspaces(workspaces: WorkspaceRecord[]): WorkspaceRecord[] {
    if (!this.allowlist) return workspaces
    return workspaces.filter((workspace) => this.isWorkspaceVisible(workspace.id))
  }

  private visibleWorkspaceIdsFromChats(chats: ChatRecord[]): Set<string> {
    if (!this.allowlist) {
      return new Set(
        chats
          .map((chat) => chat.workspaceId)
          .filter((workspaceId): workspaceId is string => Boolean(workspaceId))
      )
    }
    return new Set(
      chats
        .map((chat) => chat.workspaceId)
        .filter((workspaceId): workspaceId is string => Boolean(workspaceId))
        .filter((workspaceId) => this.isWorkspaceVisible(workspaceId))
    )
  }

  private visibleChats(chats: ChatRecord[], visibleWorkspaceIds: Set<string>): ChatRecord[] {
    if (!this.allowlist) return chats
    // T71 — scope-global chats (no workspaceId) pass through READ-ONLY when
    // the synthetic global scope is live (≥1 real workspace allowlisted).
    // The allowlist's virtual entry grants only `monitor`, so every action
    // beyond viewing stays denied at the router.
    const globalVisible = this.isWorkspaceVisible(GLOBAL_REMOTE_SCOPE)
    return chats.filter((chat) =>
      chat.workspaceId && chat.workspaceId.length > 0
        ? visibleWorkspaceIds.has(chat.workspaceId)
        : globalVisible
    )
  }

  private isChatVisible(chat: ChatRecord): boolean {
    if (!this.allowlist) return true
    return chat.workspaceId && chat.workspaceId.length > 0
      ? this.isWorkspaceVisible(chat.workspaceId)
      : this.isWorkspaceVisible(GLOBAL_REMOTE_SCOPE)
  }

  private isWorkspaceVisible(workspaceId: string): boolean {
    return this.allowlist?.evaluate({ workspaceId }).allowed ?? true
  }

  private workspaceRecordToSummary(workspace: WorkspaceRecord, chats: ChatRecord[]): WorkspaceSummary {
    return workspaceRecordToSummary(workspace, chats, this.remoteCapabilitiesForWorkspace(workspace.id))
  }

  private remoteCapabilitiesForWorkspace(workspaceId: string): RemoteTaskCapabilities | undefined {
    if (!this.allowlist) return undefined
    const decision = this.allowlist.evaluate({ workspaceId, capability: 'monitor' })
    if (!decision.allowed) return undefined
    const capabilities = new Set(capabilitiesForRemoteWorkspaceEntry(decision.entry))
    return {
      monitor: capabilities.has('monitor'),
      approve: capabilities.has('approve'),
      answer: capabilities.has('answer'),
      cancel: capabilities.has('cancel'),
      startTurn: capabilities.has('startTurn'),
      diffReview: capabilities.has('diffReview'),
      steer: capabilities.has('steer'),
      fileBrowse: capabilities.has('fileBrowse'),
      fileRead: capabilities.has('fileRead'),
      fileWrite: capabilities.has('fileWrite'),
      pin: capabilities.has('pin'),
      yolo: capabilities.has('yolo')
    }
  }

  private sendNotify(method: string, params: unknown): void {
    try {
      this.daemon.notify(method, params)
    } catch (err) {
      // Best-effort delivery — a dead daemon shouldn't crash the host.
      // Roll back the throttle stamp so the next attempt isn't gated.
      const throttleKeys = Array.from(this.lastEmitMs.keys()).filter(
        (key) => key === method || key.startsWith(`${method}:`)
      )
      for (const key of throttleKeys) {
        this.lastEmitMs.delete(key)
      }
      this.logErr(`notify failed for ${method}`, err)
    }
  }

  private logErr(message: string, err: unknown): void {
    const detail = err instanceof Error ? err.message : String(err)
    this.log?.(`[BridgeBroadcaster] ${message}: ${detail}`)
  }
}
