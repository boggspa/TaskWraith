import {
  CHAT_UPDATE_INVALIDATION_CHANNEL,
  buildChatUpdateInvalidation,
  normalizeChatUpdateInterestChatId,
  type ChatUpdateInterestMode,
  type ChatUpdateInterestSnapshot
} from '../shared/chatUpdateInterest'
import type { ChatListItem, ChatRecord, ChatRun, EnsembleConfig } from './store/types'
import { projectThreadRunWallMs } from '../shared/threadRunWallTime'
import {
  ChatUpdateInterestRegistry,
  type ChatUpdateInterestRegistryOptions
} from './ChatUpdateInterestRegistry'
import type {
  ChatUpdateDeliveryCoordinator,
  ChatUpdateDeliveryTarget
} from './ChatUpdateDeliveryCoordinator'

export const PAGED_CHAT_LIVE_UPDATES_ENV = 'TASKWRAITH_PAGED_CHAT_LIVE_UPDATES'
export const MAX_COMPACT_CHAT_UPDATE_PROJECTIONS = 256

const PRESERVED_COMPACT_CHAT_LIST_FIELDS = [
  'runsSummary',
  'searchText',
  'searchPreview',
  'sourceChatMtimeMs',
  'sourceChatSize'
] as const satisfies readonly (keyof ChatListItem)[]

export interface ChatUpdateProjectionStore {
  toChatListItem(chat: ChatRecord): ChatListItem
  toChatListEnsembleProjection(ensemble: EnsembleConfig): EnsembleConfig
}

export type ChatUpdateDeliveryPort = Pick<
  ChatUpdateDeliveryCoordinator,
  | 'enqueue'
  | 'reseed'
  | 'clearTarget'
  | 'clearChat'
  | 'clearChatEverywhere'
  | 'adoptRendererMutation'
>

export interface ChatUpdateWebContentsTarget extends ChatUpdateDeliveryTarget {
  isDestroyed: () => boolean
}

/** Structural BrowserWindow seam; keeps Electron out of this hot-path module. */
export interface ChatUpdateWindowTarget {
  isDestroyed: () => boolean
  webContents: ChatUpdateWebContentsTarget
}

export type ChatUpdateRouteTarget = ChatUpdateDeliveryTarget | ChatUpdateWindowTarget
export type ChatListItemResolver = () => ChatListItem
export type ChatUpdateRoutingResult = 'full' | 'compact' | 'ignored'

export interface ChatUpdateInterestRouterOptions extends ChatUpdateInterestRegistryOptions {
  delivery: ChatUpdateDeliveryPort
  store: ChatUpdateProjectionStore
  /** Explicit feature-flag seam. Omit to read TASKWRAITH_PAGED_CHAT_LIVE_UPDATES. */
  enabled?: boolean
  /** Test/embedding seam for reading an environment value without mutating process.env. */
  envValue?: string
  /** May lower, but never raise, the hard cache bound. */
  maxCompactProjections?: number
  interestRegistry?: ChatUpdateInterestRegistry
}

export interface ClearedChatUpdateState {
  projection: boolean
  interestTargets: number
  deliveryTargets: number
}

function validTargetId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function boundedProjectionLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_COMPACT_CHAT_UPDATE_PROJECTIONS
  }
  return Math.min(MAX_COMPACT_CHAT_UPDATE_PROJECTIONS, Math.max(1, Math.floor(value)))
}

export function resolvePagedChatLiveUpdatesEnabled(
  value: string | undefined = process.env[PAGED_CHAT_LIVE_UPDATES_ENV]
): boolean {
  return value?.trim() !== '0'
}

function compactLastRun(run: ChatRun | undefined): ChatRun | undefined {
  if (!run) return undefined
  return {
    runId: run.runId,
    provider: run.provider,
    providerRunId: run.providerRunId,
    providerThreadId: run.providerThreadId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    requestedModel: run.requestedModel,
    actualModel: run.actualModel,
    approvalMode: run.approvalMode,
    workflowMode: run.workflowMode,
    status: run.status,
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    runtimeProfileId: run.runtimeProfileId,
    geminiAuthProfileId: run.geminiAuthProfileId,
    ensembleRoundId: run.ensembleRoundId,
    ensembleParticipantId: run.ensembleParticipantId,
    ensembleLaneId: run.ensembleLaneId,
    ensembleRole: run.ensembleRole,
    ensembleStageRole: run.ensembleStageRole,
    ensembleOrder: run.ensembleOrder
  }
}

/**
 * Routes main-owned chat updates according to each renderer document's
 * replacement interest snapshot.
 *
 * A target that has not handshaken remains a legacy full-record subscriber.
 * After its first handshake, both `paged` and an absent chat id receive the
 * compact summary invalidation. Absence is deliberately not silence: sidebar
 * chrome must remain live even when no transcript surface is mounted.
 */
export class ChatUpdateInterestRouter {
  readonly enabled: boolean

  private readonly delivery: ChatUpdateDeliveryPort
  private readonly store: ChatUpdateProjectionStore
  private readonly interests: ChatUpdateInterestRegistry
  private readonly maxCompactProjections: number
  private readonly compactProjectionByChatId = new Map<string, ChatListItem>()

  constructor(options: ChatUpdateInterestRouterOptions) {
    this.delivery = options.delivery
    this.store = options.store
    this.enabled = options.enabled ?? resolvePagedChatLiveUpdatesEnabled(options.envValue)
    this.maxCompactProjections = boundedProjectionLimit(options.maxCompactProjections)
    this.interests =
      options.interestRegistry ??
      new ChatUpdateInterestRegistry({ maxEntriesPerTarget: options.maxEntriesPerTarget })
  }

  hasHandshake(targetId: number): boolean {
    return this.interests.hasHandshake(targetId)
  }

  snapshotForTarget(targetId: number): ChatUpdateInterestSnapshot | null {
    return this.interests.snapshotForTarget(targetId)
  }

  /** The IPC layer supplies an already authorization-filtered replacement. */
  replaceTargetSnapshot(targetId: number, value: unknown): ChatUpdateInterestSnapshot | null {
    if (!this.enabled) return null
    return this.interests.replaceTargetSnapshot(targetId, value)
  }

  modeFor(targetId: number, chatIdValue: unknown): ChatUpdateInterestMode | undefined {
    const chatId = normalizeChatUpdateInterestChatId(chatIdValue)
    if (!validTargetId(targetId) || !chatId) return undefined
    return this.enabled ? this.interests.modeFor(targetId, chatId) : 'full'
  }

  /**
   * Clear one renderer document completely. Projection rows are shared across
   * documents, so target cleanup never evicts them.
   */
  clearTarget(targetId: number): boolean {
    if (!validTargetId(targetId)) return false
    const clearedInterest = this.interests.clearTarget(targetId)
    this.delivery.clearTarget(targetId)
    return clearedInterest
  }

  /** Clear only legacy/full delivery state while preserving the new handshake. */
  clearFullDeliveryTarget(targetId: number): void {
    if (!validTargetId(targetId)) return
    this.delivery.clearTarget(targetId)
  }

  /** Clear one target/chat full-record baseline while preserving other chats. */
  clearFullDeliveryChat(targetId: number, chatIdValue: unknown): boolean {
    const chatId = normalizeChatUpdateInterestChatId(chatIdValue)
    if (!validTargetId(targetId) || !chatId) return false
    return this.delivery.clearChat(targetId, chatId)
  }

  /** Release a deleted chat's cache, interests, and full baselines everywhere. */
  clearChat(chatIdValue: unknown): ClearedChatUpdateState {
    const chatId = normalizeChatUpdateInterestChatId(chatIdValue)
    if (!chatId) {
      return { projection: false, interestTargets: 0, deliveryTargets: 0 }
    }
    return {
      projection: this.compactProjectionByChatId.delete(chatId),
      interestTargets: this.interests.clearChat(chatId),
      deliveryTargets: this.delivery.clearChatEverywhere(chatId)
    }
  }

  /**
   * Lazily computes at most one compact row for a broadcast spanning several
   * renderer targets. Full subscribers do not pay projection cost.
   */
  createBroadcastProjectionResolver(chat: ChatRecord): ChatListItemResolver {
    let projection: ChatListItem | undefined
    return () => (projection ??= this.projectCompactChat(chat))
  }

  /**
   * One cold authoritative list projection, followed by an O(top-level chrome
   * + participants) update. The warm path never scans messages or all runs.
   */
  projectCompactChat(chat: ChatRecord): ChatListItem {
    const chatId = normalizeChatUpdateInterestChatId(chat?.appChatId)
    if (!chatId) throw new Error('Cannot project a chat without a valid appChatId.')

    const previous = this.compactProjectionByChatId.get(chatId)
    if (!previous) {
      const seeded =
        (chat as Partial<ChatListItem>).summaryOnly === true
          ? (chat as ChatListItem)
          : this.store.toChatListItem(chat)
      this.rememberProjection(chatId, seeded)
      return seeded
    }

    const source = chat as ChatRecord &
      Partial<ChatListItem> & {
        transcriptPaged?: unknown
      }
    const {
      messages,
      runs,
      ensemble,
      ollamaSessionMemory: _ollamaSessionMemory,
      ollamaSessionMemories: _ollamaSessionMemories,
      summaryOnly: _summaryOnly,
      transcriptPaged: _transcriptPaged,
      messageCount: _messageCount,
      runCount: _runCount,
      runWallMs: _runWallMs,
      lastRun: _lastRun,
      runsSummary: _runsSummary,
      searchText: _searchText,
      searchPreview: _searchPreview,
      sourceChatMtimeMs: _sourceChatMtimeMs,
      sourceChatSize: _sourceChatSize,
      ...chrome
    } = source
    const sourceWasSummary = source.summaryOnly === true
    const messageList = Array.isArray(messages) ? messages : []
    const runList = Array.isArray(runs) ? runs : []
    const lastRun = compactLastRun(sourceWasSummary ? source.lastRun : runList[runList.length - 1])
    const next = {
      ...chrome,
      ...(ensemble ? { ensemble: this.store.toChatListEnsembleProjection(ensemble) } : {}),
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: sourceWasSummary ? (source.messageCount ?? 0) : messageList.length,
      runCount: sourceWasSummary ? (source.runCount ?? 0) : runList.length,
      // Same rule as runCount: measured from the array being stripped, or
      // carried forward when the source already had none to measure.
      ...(sourceWasSummary
        ? source.runWallMs === undefined
          ? previous.runWallMs === undefined
            ? {}
            : { runWallMs: previous.runWallMs }
          : { runWallMs: source.runWallMs }
        : { runWallMs: projectThreadRunWallMs(runList) }),
      ...(lastRun ? { lastRun } : {})
    } as ChatListItem

    const nextRecord = next as unknown as Record<string, unknown>
    const previousRecord = previous as unknown as Record<string, unknown>
    for (const key of PRESERVED_COMPACT_CHAT_LIST_FIELDS) {
      if (sourceWasSummary && Object.prototype.hasOwnProperty.call(source, key)) {
        nextRecord[key] = (source as unknown as Record<string, unknown>)[key]
      } else if (Object.prototype.hasOwnProperty.call(previous, key)) {
        nextRecord[key] = previousRecord[key]
      }
    }

    this.rememberProjection(chatId, next)
    return next
  }

  cachedProjectionCount(): number {
    return this.compactProjectionByChatId.size
  }

  enqueue(
    target: ChatUpdateRouteTarget | null | undefined,
    chat: ChatRecord,
    resolveCompactProjection?: ChatListItemResolver
  ): ChatUpdateRoutingResult {
    const deliveryTarget = this.resolveTarget(target)
    if (!deliveryTarget || !chat?.appChatId) return 'ignored'
    return this.route(deliveryTarget, chat, resolveCompactProjection, false)
  }

  reseed(
    target: ChatUpdateRouteTarget | null | undefined,
    chat: ChatRecord,
    resolveCompactProjection?: ChatListItemResolver
  ): ChatUpdateRoutingResult {
    const deliveryTarget = this.resolveTarget(target)
    if (!deliveryTarget || !chat?.appChatId) return 'ignored'
    return this.route(deliveryTarget, chat, resolveCompactProjection, true)
  }

  /**
   * A paged/summary-only renderer already owns its invoke/reply mutation, so
   * there is no full transport baseline to advance or echo.
   */
  adoptRendererMutation(
    targetId: number,
    chat: ChatRecord,
    basePersistenceRevision: number
  ): boolean {
    if (this.modeFor(targetId, chat?.appChatId) !== 'full') return true
    return this.delivery.adoptRendererMutation(targetId, chat, basePersistenceRevision)
  }

  private route(
    target: ChatUpdateDeliveryTarget,
    chat: ChatRecord,
    resolveCompactProjection: ChatListItemResolver | undefined,
    reseed: boolean
  ): ChatUpdateRoutingResult {
    if (this.modeFor(target.id, chat.appChatId) === 'full') {
      if (reseed) this.delivery.reseed(target, chat)
      else this.delivery.enqueue(target, chat)
      return 'full'
    }

    // `paged` and absent-after-handshake both use the compact invalidation.
    this.delivery.clearChat(target.id, chat.appChatId)
    const summary = resolveCompactProjection?.() ?? this.projectCompactChat(chat)
    if (summary.appChatId !== chat.appChatId) return 'ignored'
    const invalidation = buildChatUpdateInvalidation(summary)
    if (!invalidation) return 'ignored'
    try {
      target.send(CHAT_UPDATE_INVALIDATION_CHANNEL, invalidation)
      return 'compact'
    } catch {
      this.clearTarget(target.id)
      return 'ignored'
    }
  }

  private resolveTarget(
    target: ChatUpdateRouteTarget | null | undefined
  ): ChatUpdateDeliveryTarget | null {
    if (!target) return null
    if ('webContents' in target) {
      const webContents = target.webContents
      if (!webContents || !validTargetId(webContents.id)) return null
      if (target.isDestroyed() || webContents.isDestroyed()) {
        this.clearTarget(webContents.id)
        return null
      }
      return {
        id: webContents.id,
        isDestroyed: () => target.isDestroyed() || webContents.isDestroyed(),
        send: (channel, payload) => webContents.send(channel, payload)
      }
    }
    if (!validTargetId(target.id)) return null
    if (target.isDestroyed()) {
      this.clearTarget(target.id)
      return null
    }
    return target
  }

  private rememberProjection(chatId: string, projection: ChatListItem): void {
    this.compactProjectionByChatId.delete(chatId)
    this.compactProjectionByChatId.set(chatId, projection)
    while (this.compactProjectionByChatId.size > this.maxCompactProjections) {
      const oldest = this.compactProjectionByChatId.keys().next().value
      if (typeof oldest !== 'string') break
      this.compactProjectionByChatId.delete(oldest)
    }
  }
}
