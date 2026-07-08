import type { ChatRecord, ProviderId, WorkspaceRecord } from './store/types'
import { normalizeThreadTitle } from '../shared/threadTitles'
import type { AllowlistDecision, PrepareStartTurnEvaluation } from './RemoteWorkspaceAllowlist'
import {
  capabilitiesForRemoteWorkspaceEntry,
  GLOBAL_REMOTE_SCOPE
} from './RemoteWorkspaceAllowlist'
import type { RemoteProjectionEnvelope, RemoteTaskCapabilities, RemoteTaskStatus } from './RemoteTaskProjection'
import {
  deriveRemoteTaskStatusForChat,
  latestChatRun,
  projectChatKind
} from './RemoteTaskProjection'

const DEFAULT_REMOTE_PROJECTION_SNAPSHOT_MAX_BYTES = 700_000
const DEFAULT_REMOTE_PROJECTION_ENVELOPE_MAX_BYTES = 700_000

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
  /** Solo vs Ensemble classification — mirrors desktop `chatKind`. */
  chatKind: 'single' | 'ensemble'
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
  /** Throttle window for full remote projection snapshots. Defaults to
   * `throttleMs`; callers may return a longer window while runs are streaming. */
  remoteProjectionSnapshotThrottleMs?: number | (() => number)
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
  /**
   * Maximum UTF-8 JSON bytes for one bulk remote projection snapshot.
   * Larger snapshots are fanned out as single projection envelopes so
   * mobile clients still hydrate when the full workspace projection is
   * near the relay frame budget.
   */
  remoteProjectionSnapshotMaxBytes?: number
  /** Maximum UTF-8 JSON bytes for one single-envelope remote projection. */
  remoteProjectionEnvelopeMaxBytes?: number
}

export interface ProviderModelOption {
  id: string
  label: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    description?: string
    disabled?: boolean
    disabledReason?: string
  }>
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
  welcomeDashboard: 'bridge.broadcastWelcomeDashboard',
  firstLaunchState: 'bridge.broadcastFirstLaunchState'
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
  const runningRun =
    status === 'running' ? latestRunningRun(chat) ?? latestChatRun(chat) : undefined
  const lastMessageAt = msToIsoOrUndefined(chat.updatedAt)
  // `scope: 'global'` is the canonical signal but for the iOS contract
  // we collapse "no workspace id" → null regardless, which catches both
  // explicit global chats and any legacy record missing `workspaceId`.
  const workspaceId = chat.workspaceId && chat.workspaceId.length > 0 ? chat.workspaceId : null
  const summary: ThreadSummary = {
    chatId: chat.appChatId,
    title: normalizeThreadTitle(chat.title, 'Untitled chat'),
    workspaceId,
    provider,
    chatKind: projectChatKind(chat),
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

/** Mirrors `deriveRemoteTaskStatusForChat` / task-card projection so thread-list
 * summaries and fallback cards agree with authoritative remote task cards. */
function deriveThreadStatus(chat: ChatRecord): ThreadSummaryStatus {
  return threadSummaryStatusFromRemoteTaskStatus(deriveRemoteTaskStatusForChat(chat))
}

function threadSummaryStatusFromRemoteTaskStatus(status: RemoteTaskStatus): ThreadSummaryStatus {
  switch (status) {
    case 'running':
    case 'queued':
    case 'awaitingApproval':
    case 'awaitingQuestion':
      return 'running'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'success':
      return 'success'
    default:
      return 'idle'
  }
}

function isChatRunning(chat: ChatRecord): boolean {
  return deriveThreadStatus(chat) === 'running'
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
  private readonly remoteProjectionSnapshotThrottleMs: number | (() => number)
  private readonly now: () => number
  private readonly remoteProjectionSnapshotMaxBytes: number
  private readonly remoteProjectionEnvelopeMaxBytes: number
  private readonly canonicalChatWorkspaceId?: (
    workspaceId: string | null | undefined
  ) => string | null
  /** Per-throttle-key timestamp of the last successful emit. List
   * methods key on the bare method name; updated methods key on
   * `method:id` so two different chats can update in the same tick. */
  private readonly lastEmitMs = new Map<string, number>()
  private remoteProjectionSnapshotTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: BridgeBroadcasterOptions) {
    this.daemon = options.daemon
    this.appStore = options.appStore
    this.allowlist = options.allowlist
    this.projectionSource = options.projectionSource
    this.log = options.log
    this.throttleMs = options.throttleMs ?? 1000
    this.remoteProjectionSnapshotThrottleMs =
      options.remoteProjectionSnapshotThrottleMs ?? this.throttleMs
    this.now = options.now ?? Date.now
    this.remoteProjectionSnapshotMaxBytes =
      options.remoteProjectionSnapshotMaxBytes ?? DEFAULT_REMOTE_PROJECTION_SNAPSHOT_MAX_BYTES
    this.remoteProjectionEnvelopeMaxBytes =
      options.remoteProjectionEnvelopeMaxBytes ?? DEFAULT_REMOTE_PROJECTION_ENVELOPE_MAX_BYTES
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

  /** Redacted first-launch orientation state for paired iOS clients. */
  broadcastFirstLaunchState(message: Record<string, unknown>): void {
    const method = BRIDGE_BROADCAST_METHODS.firstLaunchState
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
    // shouldEmit STAMPS lastEmitMs first (throttle) — then build; a build that
    // returns null on a load failure leaves the stamp in place, preserving the
    // throttle-stamped-even-on-load-failure behavior.
    if (!this.shouldEmit(method)) return
    const params = this.buildWorkspaceListParams()
    if (!params) return
    this.sendNotify(method, params)
  }

  /** Build a current snapshot from AppStore + emit
   * `bridge.broadcastThreadList`. */
  broadcastThreadList(): void {
    const method = BRIDGE_BROADCAST_METHODS.threadList
    if (!this.shouldEmit(method)) return
    const params = this.buildThreadListParams()
    if (!params) return
    this.sendNotify(method, params)
  }

  /** Pure builder for the workspace-list broadcast payload. Returns null on a
   * load failure (the caller already stamped the throttle). Shared by the
   * throttled broadcast and the targeted `emitSnapshotTo` resync. */
  private buildWorkspaceListParams(): { workspaces: WorkspaceSummary[] } | null {
    const method = BRIDGE_BROADCAST_METHODS.workspaceList
    let chats: ChatRecord[]
    let workspaces: WorkspaceRecord[]
    try {
      workspaces = this.appStore.getWorkspaces()
      chats = this.canonicalizeChats(this.appStore.getChats())
    } catch (err) {
      this.logErr(`failed to load workspaces/chats for ${method}`, err)
      return null
    }
    const visibleWorkspaces = this.visibleWorkspaces(workspaces)
    const visibleWorkspaceIds = new Set(visibleWorkspaces.map((ws) => ws.id))
    const visibleChats = this.visibleChats(chats, visibleWorkspaceIds)
    const summaries = visibleWorkspaces.map((ws) => this.workspaceRecordToSummary(ws, visibleChats))
    return { workspaces: summaries }
  }

  /** Pure builder for the thread-list broadcast payload. Returns null on load
   * failure. Shared by the throttled broadcast and `emitSnapshotTo`. */
  private buildThreadListParams(): { threads: ReturnType<typeof chatRecordToSummary>[] } | null {
    const method = BRIDGE_BROADCAST_METHODS.threadList
    let chats: ChatRecord[]
    try {
      chats = this.canonicalizeChats(this.appStore.getChats())
    } catch (err) {
      this.logErr(`failed to load chats for ${method}`, err)
      return null
    }
    const visibleWorkspaceIds = this.visibleWorkspaceIdsFromChats(chats)
    const threads = this.visibleChats(chats, visibleWorkspaceIds).map(chatRecordToSummary)
    return { threads }
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
  broadcastRemoteProjection(envelope: RemoteProjectionEnvelope): boolean {
    const method = BRIDGE_BROADCAST_METHODS.remoteProjection
    const params = { envelope }
    const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8')
    if (bytes > this.remoteProjectionEnvelopeMaxBytes) {
      this.log?.(
        `[BridgeBroadcaster] ${method} ${bytes}B exceeds ${this.remoteProjectionEnvelopeMaxBytes}B; skipped ${envelope.kind} envelope ${envelope.envelopeId}`
      )
      return false
    }
    this.sendNotify(method, params)
    return true
  }

  /** Emit a current set of remote projection envelopes. Called on
   * subscribe so a new iOS client receives task-feed/question state
   * immediately, and by main-process hooks after task-affecting
   * mutations. */
  broadcastRemoteProjectionSnapshot(): void {
    const method = BRIDGE_BROADCAST_METHODS.remoteProjectionSnapshot
    if (!this.projectionSource) return
    const remaining = this.remoteProjectionSnapshotThrottleRemaining(method)
    if (remaining > 0) {
      this.scheduleRemoteProjectionSnapshotTrailing(method, remaining)
      return
    }
    this.lastEmitMs.set(method, this.now())
    this.sendRemoteProjectionSnapshot(method)
  }

  private sendRemoteProjectionSnapshot(method: string): void {
    const built = this.buildRemoteProjectionSnapshotParams()
    if (!built) return
    const params = { projections: built.projections }
    const maxBytes = this.remoteProjectionSnapshotMaxBytes
    const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8')
    if (bytes <= maxBytes) {
      this.sendNotify(method, params)
      return
    }

    this.log?.(
      `[BridgeBroadcaster] ${method} ${bytes}B exceeds ${maxBytes}B; sending ${built.projections.length} single projection envelopes`
    )
    for (const envelope of built.projections) {
      this.broadcastRemoteProjection(envelope)
    }
  }

  /** Pure builder for the remote-projection-snapshot payload. Returns null
   * when no projection source is wired or the load fails. Does NOT touch the
   * throttle (the throttled entry `broadcastRemoteProjectionSnapshot` owns
   * that). Shared by the throttled broadcast and `emitSnapshotTo`. */
  private buildRemoteProjectionSnapshotParams(): { projections: RemoteProjectionEnvelope[] } | null {
    const projectionSource = this.projectionSource
    if (!projectionSource) return null
    let projections: RemoteProjectionEnvelope[]
    try {
      projections = projectionSource.listRemoteProjectionEnvelopes()
    } catch (err) {
      this.logErr(
        `failed to load remote projections for ${BRIDGE_BROADCAST_METHODS.remoteProjectionSnapshot}`,
        err
      )
      return null
    }
    return { projections }
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

  /** Targeted, un-throttled full-projection re-push to a SINGLE device sink.
   * Reuses the same visibility-filtered builders as the periodic broadcasts,
   * but never touches the shared throttle (`lastEmitMs`), never calls
   * `resetThrottle`, and never hits `this.daemon` — the sink targets exactly
   * one device's session. Used by the client-initiated `fullProjectionResync`
   * (Slice 1) and the replay-gap resync (Slice 7). Snapshots are idempotent by
   * envelopeId, so a redundant push is harmless. Returns the number of frames
   * sent. */
  emitSnapshotTo(sink: (method: string, params: unknown) => void): { sentEnvelopes: number } {
    let sentEnvelopes = 0
    const workspaceParams = this.buildWorkspaceListParams()
    if (workspaceParams) {
      sink(BRIDGE_BROADCAST_METHODS.workspaceList, workspaceParams)
      sentEnvelopes += 1
    }
    const threadParams = this.buildThreadListParams()
    if (threadParams) {
      sink(BRIDGE_BROADCAST_METHODS.threadList, threadParams)
      sentEnvelopes += 1
    }
    const projectionBuilt = this.buildRemoteProjectionSnapshotParams()
    if (projectionBuilt) {
      const method = BRIDGE_BROADCAST_METHODS.remoteProjectionSnapshot
      const params = { projections: projectionBuilt.projections }
      const bytes = Buffer.byteLength(JSON.stringify(params), 'utf8')
      if (bytes <= this.remoteProjectionSnapshotMaxBytes) {
        sink(method, params)
        sentEnvelopes += 1
      } else {
        // Oversized: fan EACH envelope to the SINK (never broadcastRemoteProjection,
        // which hits the daemon / all devices). Per-envelope guard mirrors
        // broadcastRemoteProjection's size check.
        const remoteMethod = BRIDGE_BROADCAST_METHODS.remoteProjection
        for (const envelope of projectionBuilt.projections) {
          const envParams = { envelope }
          const envBytes = Buffer.byteLength(JSON.stringify(envParams), 'utf8')
          if (envBytes > this.remoteProjectionEnvelopeMaxBytes) {
            this.log?.(
              `[BridgeBroadcaster] emitSnapshotTo skipped oversized ${envelope.kind} envelope ${envelope.envelopeId}`
            )
            continue
          }
          sink(remoteMethod, envParams)
          sentEnvelopes += 1
        }
      }
    }
    return { sentEnvelopes }
  }

  /** Reset throttle state. Useful for tests or when the daemon
   * reconnects and we want a fresh snapshot to land immediately. */
  resetThrottle(): void {
    this.lastEmitMs.clear()
    this.clearRemoteProjectionSnapshotTrailing()
  }

  private remoteProjectionSnapshotThrottleWindow(): number {
    const raw =
      typeof this.remoteProjectionSnapshotThrottleMs === 'function'
        ? this.remoteProjectionSnapshotThrottleMs()
        : this.remoteProjectionSnapshotThrottleMs
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : this.throttleMs
  }

  private remoteProjectionSnapshotThrottleRemaining(throttleKey: string): number {
    const last = this.lastEmitMs.get(throttleKey)
    if (last === undefined) return 0
    const now = this.now()
    const throttleMs = this.remoteProjectionSnapshotThrottleWindow()
    const elapsed = now - last
    if (elapsed >= throttleMs) return 0
    this.log?.(
      `[BridgeBroadcaster] throttled ${throttleKey} (${elapsed}ms < ${throttleMs}ms); scheduling trailing flush`
    )
    return throttleMs - elapsed
  }

  private scheduleRemoteProjectionSnapshotTrailing(method: string, delayMs: number): void {
    if (this.remoteProjectionSnapshotTimer) return
    this.remoteProjectionSnapshotTimer = setTimeout(() => {
      this.remoteProjectionSnapshotTimer = null
      if (!this.projectionSource) return
      this.lastEmitMs.set(method, this.now())
      this.sendRemoteProjectionSnapshot(method)
    }, Math.max(0, delayMs))
    this.remoteProjectionSnapshotTimer.unref?.()
  }

  private clearRemoteProjectionSnapshotTrailing(): void {
    if (!this.remoteProjectionSnapshotTimer) return
    clearTimeout(this.remoteProjectionSnapshotTimer)
    this.remoteProjectionSnapshotTimer = null
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
      externalPublish: capabilities.has('externalPublish'),
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
