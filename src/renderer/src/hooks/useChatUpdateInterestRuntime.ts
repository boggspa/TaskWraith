import {
  useCallback,
  useLayoutEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { ChatListItem, ChatRecord } from '../../../main/store/types'
import {
  createChatUpdateInterestSnapshot,
  normalizeChatUpdateInvalidation,
  type ChatUpdateInterestEntry,
  type ChatUpdateInterestSnapshot,
  type ChatUpdateInvalidation
} from '../../../shared/chatUpdateInterest'
import {
  isTranscriptPagedShell,
  shouldPageTranscriptOnOpen,
  type ChatShell,
  type TranscriptPage,
  type TranscriptPageRequest
} from '../../../shared/transcriptPage'
import { isChatSummaryRecord } from '../lib/chatRecordMerge'
import type { ChatHydrationRuntime } from '../lib/chatHydrationRuntime'
import {
  PagedChatUpdateRefreshCoordinator,
  type PagedChatUpdateRefreshCommit
} from '../lib/PagedChatUpdateRefreshCoordinator'
import { preserveOptimisticEnsembleQueue } from '../lib/queuedMessageRows'
import { projectRendererChatListItem } from '../state/rendererChatListProjection'

interface ChatIdDeleteStore {
  delete(chatId: string): boolean
}

interface PaneScrollRefs {
  autoFollowRef: { current: boolean }
}

export interface ChatUpdateInterestBridge {
  pagedChatLiveUpdatesEnabled?: boolean
  setChatUpdateInterests?: (snapshot: ChatUpdateInterestSnapshot) => void
  onChatUpdateInvalidated?: (callback: (invalidation: ChatUpdateInvalidation) => void) => () => void
  getChatTranscriptPage?: (request: TranscriptPageRequest) => Promise<TranscriptPage | null>
}

export interface ChatUpdateInterestRuntimeState {
  chats: ChatRecord[]
  currentChat: ChatRecord | null
  setChats: Dispatch<SetStateAction<ChatRecord[]>>
  setCurrentChat: Dispatch<SetStateAction<ChatRecord | null>>
  chatByIdRef: MutableRefObject<Map<string, ChatRecord>>
  activeRunChatIdRef: MutableRefObject<string | null>
  activeRunChatSnapshotRef: MutableRefObject<ChatRecord | null>
  clearedChatIdsRef: MutableRefObject<Set<string>>
  pendingMainChatUpdatesRef: MutableRefObject<ChatIdDeleteStore>
  pendingChatFlushRef: MutableRefObject<ChatIdDeleteStore>
  pendingChatRenderReceiptsRef: MutableRefObject<ChatIdDeleteStore>
  hydrationRuntime: ChatHydrationRuntime
  isChatPopoutWindow: boolean
  chatPopoutChatId: string | null
  paneChatIds: readonly (string | null | undefined)[]
  paneScrollRefs: readonly (PaneScrollRefs | null | undefined)[]
  sideChatId: string | null
  currentAutoFollowRef: { current: boolean }
  fullResidencyChatIds: readonly string[]
}

export interface ChatUpdateInterestSurfaceInput {
  chats: readonly ChatRecord[]
  currentChat: ChatRecord | null
  resolveChat: (chatId: string) => ChatRecord | null | undefined
  isPaged: (chatId: string) => boolean
  isChatPopoutWindow: boolean
  chatPopoutChatId: string | null
  paneChatIds: readonly (string | null | undefined)[]
  sideChatId: string | null
  fullResidencyChatIds?: readonly string[]
  pagingAvailable?: boolean
}

function interestSignature(snapshot: ChatUpdateInterestSnapshot): string {
  return JSON.stringify(snapshot.entries)
}

/** Pure surface aggregation; full wins when the same chat owns the side session. */
export function buildChatUpdateInterestSurfaceSnapshot(
  input: ChatUpdateInterestSurfaceInput
): ChatUpdateInterestSnapshot {
  const candidates = new Map<
    string,
    { allowPlannedPaging: boolean; bootstrapPaged: boolean; forceFull: boolean }
  >()
  const add = (
    chatId: string | null | undefined,
    options: {
      allowPlannedPaging?: boolean
      bootstrapPaged?: boolean
      forceFull?: boolean
    } = {}
  ): void => {
    if (!chatId) return
    const previous = candidates.get(chatId)
    candidates.set(chatId, {
      allowPlannedPaging:
        previous?.allowPlannedPaging === true || options.allowPlannedPaging === true,
      bootstrapPaged: previous?.bootstrapPaged === true || options.bootstrapPaged === true,
      forceFull: previous?.forceFull === true || options.forceFull === true
    })
  }

  if (input.isChatPopoutWindow) {
    add(input.chatPopoutChatId, {
      allowPlannedPaging: true,
      bootstrapPaged: input.currentChat?.appChatId !== input.chatPopoutChatId
    })
  } else {
    add(input.currentChat?.appChatId, { allowPlannedPaging: true })
    for (const chatId of input.paneChatIds) add(chatId, { allowPlannedPaging: true })
    // The side session remains mounted while another dock tab covers it.
    add(input.sideChatId, { forceFull: true })
  }
  for (const chatId of input.fullResidencyChatIds ?? []) add(chatId, { forceFull: true })

  const entries: ChatUpdateInterestEntry[] = []
  for (const [chatId, options] of candidates) {
    const record =
      (input.currentChat?.appChatId === chatId ? input.currentChat : null) ||
      input.resolveChat(chatId) ||
      input.chats.find((candidate) => candidate.appChatId === chatId)
    const paged =
      input.pagingAvailable !== false &&
      !options.forceFull &&
      (options.bootstrapPaged ||
        Boolean(
          record &&
          ((isTranscriptPagedShell(record) && input.isPaged(chatId)) ||
            (options.allowPlannedPaging &&
              isChatSummaryRecord(record) &&
              shouldPageTranscriptOnOpen(record)))
        ))
    entries.push({ chatId, mode: paged ? 'paged' : 'full' })
  }
  entries.sort((left, right) => left.chatId.localeCompare(right.chatId))
  return createChatUpdateInterestSnapshot(entries)
}

export class ChatUpdateInterestRuntime {
  private pendingSnapshot = createChatUpdateInterestSnapshot([])
  private desiredModes = new Map<string, ChatUpdateInterestEntry['mode']>()
  private publishedSignature: string | null = null
  private publishedModes = new Map<string, ChatUpdateInterestEntry['mode']>()
  private coordinator: PagedChatUpdateRefreshCoordinator | null = null
  private unsubscribe: (() => void) | null = null
  private readonly deferredPagedInvalidations = new Map<string, ChatUpdateInvalidation>()
  private handshakePublished = false
  private started = false
  private getState: () => ChatUpdateInterestRuntimeState

  constructor(
    private readonly bridge: ChatUpdateInterestBridge,
    state: ChatUpdateInterestRuntimeState | (() => ChatUpdateInterestRuntimeState)
  ) {
    this.getState = typeof state === 'function' ? state : () => state
  }

  setState(state: ChatUpdateInterestRuntimeState): void {
    this.getState = () => state
  }

  setPendingSnapshot(snapshot: ChatUpdateInterestSnapshot): void {
    this.pendingSnapshot = snapshot
    this.desiredModes = new Map(snapshot.entries.map((entry) => [entry.chatId, entry.mode]))
  }

  start(): void {
    if (this.started || !this.bridgeReady()) return
    this.started = true
    this.coordinator = this.pagingAvailable() ? this.createCoordinator() : null
    this.unsubscribe = this.bridge.onChatUpdateInvalidated!((value) =>
      this.handleInvalidation(value)
    )
    this.publishPending()
  }

  publishPending(): void {
    if (!this.started || !this.bridgeReady()) return
    const signature = interestSignature(this.pendingSnapshot)
    if (signature === this.publishedSignature) return
    const nextModes = new Map(
      this.pendingSnapshot.entries.map((entry) => [entry.chatId, entry.mode])
    )
    for (const [chatId, previousMode] of this.publishedModes) {
      if (previousMode === 'paged' && nextModes.get(chatId) !== 'paged') {
        this.coordinator?.cancel(chatId)
        this.deferredPagedInvalidations.delete(chatId)
      }
    }
    this.publishedModes = nextModes
    this.publishedSignature = signature
    this.bridge.setChatUpdateInterests!(this.pendingSnapshot)
    this.handshakePublished = true
  }

  stop(): void {
    if (!this.started) return
    if (this.bridgeReady()) {
      this.bridge.setChatUpdateInterests!(createChatUpdateInterestSnapshot([]))
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    this.coordinator?.dispose()
    this.coordinator = null
    this.deferredPagedInvalidations.clear()
    this.publishedModes.clear()
    this.publishedSignature = null
    this.handshakePublished = false
    this.started = false
  }

  shouldRejectFullDelivery(chatId: string): boolean {
    return this.handshakePublished && this.desiredModes.get(chatId) !== 'full'
  }

  retryDeferredPagedInvalidations(): void {
    for (const [chatId, invalidation] of this.deferredPagedInvalidations) {
      if (this.desiredModes.get(chatId) === 'paged' && this.visiblePagedChatFollowsLatest(chatId)) {
        this.deferredPagedInvalidations.delete(chatId)
        this.coordinator?.invalidate(invalidation)
      }
    }
  }

  private bridgeReady(): boolean {
    return (
      typeof this.bridge.setChatUpdateInterests === 'function' &&
      typeof this.bridge.onChatUpdateInvalidated === 'function' &&
      this.bridge.pagedChatLiveUpdatesEnabled !== false
    )
  }

  private pagingAvailable(): boolean {
    return typeof this.bridge.getChatTranscriptPage === 'function'
  }

  private createCoordinator(): PagedChatUpdateRefreshCoordinator {
    return new PagedChatUpdateRefreshCoordinator({
      fetchPage: (request) =>
        this.bridge.getChatTranscriptPage!({ ...request, includeShell: true }),
      commit: (value) => this.commitPagedRefresh(value)
    })
  }

  private visiblePagedChatFollowsLatest(chatId: string): boolean {
    const state = this.getState()
    const payload = state.hydrationRuntime.transcriptStore.get(chatId)
    if (payload?.hasNewer) return false
    let renderedInPane = false
    for (let index = 0; index < state.paneChatIds.length; index += 1) {
      if (state.paneChatIds[index] !== chatId) continue
      renderedInPane = true
      if (state.paneScrollRefs[index]?.autoFollowRef.current === false) return false
    }
    if (
      !renderedInPane &&
      state.currentChat?.appChatId === chatId &&
      !state.currentAutoFollowRef.current
    ) {
      return false
    }
    return true
  }

  private handleInvalidation(value: unknown): void {
    const invalidation = normalizeChatUpdateInvalidation(value)
    if (!invalidation) return
    const mode = this.desiredModes.get(invalidation.chatId)
    if (mode === 'paged') {
      if (this.visiblePagedChatFollowsLatest(invalidation.chatId)) {
        this.deferredPagedInvalidations.delete(invalidation.chatId)
        this.coordinator?.invalidate(invalidation)
      } else {
        this.deferredPagedInvalidations.set(invalidation.chatId, invalidation)
      }
      return
    }
    if (mode === 'full') return
    this.coordinator?.cancel(invalidation.chatId)
    this.applyBackgroundInvalidation(invalidation.summary)
  }

  private replaceChatRecord(chat: ChatRecord): void {
    const state = this.getState()
    state.chatByIdRef.current.set(chat.appChatId, chat)
    if (state.activeRunChatIdRef.current === chat.appChatId) {
      state.activeRunChatSnapshotRef.current = chat
    }
    state.setChats((previous) => {
      const existing = previous.find((candidate) => candidate.appChatId === chat.appChatId)
      if (existing === chat) return previous
      return [chat, ...previous.filter((candidate) => candidate.appChatId !== chat.appChatId)].sort(
        (left, right) => right.updatedAt - left.updatedAt
      )
    })
  }

  private dropPendingFullAliases(chatId: string): void {
    const state = this.getState()
    state.pendingMainChatUpdatesRef.current.delete(chatId)
    state.pendingChatFlushRef.current.delete(chatId)
    state.pendingChatRenderReceiptsRef.current.delete(chatId)
  }

  private applyBackgroundInvalidation(summary: ChatListItem): void {
    const state = this.getState()
    const chatId = summary.appChatId
    if (state.clearedChatIdsRef.current.has(chatId) && !state.chatByIdRef.current.has(chatId))
      return
    if (state.hydrationRuntime.retention.isPinned(chatId)) return
    const existing =
      state.chatByIdRef.current.get(chatId) ||
      state.chats.find((candidate) => candidate.appChatId === chatId)
    const previousSummary =
      existing && isChatSummaryRecord(existing) && !isTranscriptPagedShell(existing)
        ? existing
        : undefined
    const projected = projectRendererChatListItem(summary, previousSummary)
    this.dropPendingFullAliases(chatId)
    state.hydrationRuntime.retention.drop(chatId)
    this.replaceChatRecord(projected)
  }

  private commitPagedRefresh({ invalidation, page }: PagedChatUpdateRefreshCommit): void {
    if (this.desiredModes.get(invalidation.chatId) !== 'paged') return
    const state = this.getState()
    const chatId = invalidation.chatId
    const current =
      state.chatByIdRef.current.get(chatId) ||
      (state.currentChat?.appChatId === chatId ? state.currentChat : null)
    const alreadyPaged = Boolean(
      current &&
      isTranscriptPagedShell(current) &&
      state.hydrationRuntime.transcriptStore.isPaged(chatId)
    )
    const awaitingFirstPage = Boolean(
      (!current && state.isChatPopoutWindow && state.chatPopoutChatId === chatId) ||
      (current && isChatSummaryRecord(current) && shouldPageTranscriptOnOpen(current))
    )
    if ((!alreadyPaged && !awaitingFirstPage) || !this.visiblePagedChatFollowsLatest(chatId)) {
      this.deferredPagedInvalidations.set(chatId, invalidation)
      return
    }
    if (!page.shell || !isTranscriptPagedShell(page.shell) || page.shell.appChatId !== chatId) {
      return
    }

    const shellWithListMetadata = { ...page.shell } as ChatShell & Record<string, unknown>
    const shellRecord = shellWithListMetadata as Record<string, unknown>
    const summaryRecord = invalidation.summary as unknown as Record<string, unknown>
    for (const key of [
      'runsSummary',
      'searchText',
      'searchPreview',
      'sourceChatMtimeMs',
      'sourceChatSize'
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(invalidation.summary, key)) {
        shellRecord[key] = summaryRecord[key]
      }
    }
    const committed = preserveOptimisticEnsembleQueue(shellWithListMetadata, current)
    this.dropPendingFullAliases(chatId)
    state.hydrationRuntime.retention.dropTransportBaseline(chatId)
    // Presentation arrays live only in the transcript store. The marked shell
    // remains empty and can never be mistaken for a saveable ChatRecord.
    state.hydrationRuntime.transcriptStore.replaceChatTranscriptWindow(page)
    state.hydrationRuntime.byteLru.touch(chatId)
    this.replaceChatRecord(committed)
    state.setCurrentChat((previous) => (previous?.appChatId === chatId ? committed : previous))
  }
}

export interface UseChatUpdateInterestRuntimeOptions extends Omit<
  ChatUpdateInterestRuntimeState,
  'chatPopoutChatId'
> {
  chatPopoutChatId: string | null
  bridge?: ChatUpdateInterestBridge
}

export function useChatUpdateInterestRuntime(options: UseChatUpdateInterestRuntimeOptions): {
  register: () => () => void
  shouldRejectFullDelivery: (chatId: string) => boolean
} {
  const [runtime] = useState(
    () => new ChatUpdateInterestRuntime(options.bridge ?? window.api, options)
  )
  const snapshot = buildChatUpdateInterestSurfaceSnapshot({
    chats: options.chats,
    currentChat: options.currentChat,
    resolveChat: (chatId) => options.chatByIdRef.current.get(chatId),
    isPaged: (chatId) => options.hydrationRuntime.transcriptStore.isPaged(chatId),
    isChatPopoutWindow: options.isChatPopoutWindow,
    chatPopoutChatId: options.chatPopoutChatId,
    paneChatIds: options.paneChatIds,
    sideChatId: options.sideChatId,
    fullResidencyChatIds: options.fullResidencyChatIds,
    pagingAvailable: typeof (options.bridge ?? window.api).getChatTranscriptPage === 'function'
  })
  // IPC must observe committed React state, never a speculative concurrent
  // render. Layout effects update state first, then publish the matching mode
  // snapshot before the browser can deliver another frame.
  useLayoutEffect(() => {
    runtime.setState(options)
  })
  useLayoutEffect(() => {
    runtime.setPendingSnapshot(snapshot)
    runtime.publishPending()
  }, [runtime, snapshot])
  useLayoutEffect(() => {
    runtime.retryDeferredPagedInvalidations()
  })

  const register = useCallback(() => {
    runtime.start()
    return () => runtime.stop()
  }, [runtime])
  const shouldRejectFullDelivery = useCallback(
    (chatId: string) => runtime.shouldRejectFullDelivery(chatId),
    [runtime]
  )
  return { register, shouldRejectFullDelivery }
}
