/**
 * Pane-local approval projection for independently mounted chat surfaces.
 *
 * A Multiview pane must never inherit the focused chat's approval card: that
 * would make a valid action apply from the wrong transcript. It must also not
 * hide its own card merely because another pane owns the legacy App composer.
 * Keep both the visible head and its queue scoped to the pane's chat id.
 */
export interface ChatSurfacePendingApprovals<T> {
  pendingAgentApproval: T | null
  pendingApprovalQueueByChatId: Record<string, readonly T[]>
}

export interface RoutedPendingApproval<T> {
  chatId: string
  approval: T
}

export interface ChatSurfacePendingApprovalState<T> {
  approvalHeadByChatId: Record<string, T | null>
  approvalQueueByChatId: Record<string, T[]>
}

export function projectChatSurfacePendingApprovals<T>(
  chatId: string,
  approvalHeadByChatId: Readonly<Record<string, T | null | undefined>>,
  approvalQueueByChatId: Readonly<Record<string, readonly T[] | undefined>>
): ChatSurfacePendingApprovals<T> {
  const pendingAgentApproval = approvalHeadByChatId[chatId] ?? null
  const queue = approvalQueueByChatId[chatId]
  return {
    pendingAgentApproval,
    pendingApprovalQueueByChatId: queue ? { [chatId]: queue } : {}
  }
}

/**
 * Merge an authoritative recovery snapshot with events already received by the
 * rebuilt renderer. Recovered requests lead because they were pending before
 * the snapshot read; live events append, with approval id deduplication across
 * both delivery paths.
 */
export function mergeRecoveredPendingApprovals<T extends { id: string }>(
  recovered: readonly RoutedPendingApproval<T>[],
  approvalHeadByChatId: Readonly<Record<string, T | null | undefined>>,
  approvalQueueByChatId: Readonly<Record<string, readonly T[] | undefined>>,
  excludedApprovalIds: ReadonlySet<string> = new Set()
): ChatSurfacePendingApprovalState<T> {
  const orderedByChatId = new Map<string, T[]>()
  const seenByChatId = new Map<string, Set<string>>()
  const append = (chatId: string, approval: T | null | undefined): void => {
    if (!chatId || !approval?.id || excludedApprovalIds.has(approval.id)) return
    const seen = seenByChatId.get(chatId) ?? new Set<string>()
    if (seen.has(approval.id)) return
    seen.add(approval.id)
    seenByChatId.set(chatId, seen)
    const ordered = orderedByChatId.get(chatId) ?? []
    ordered.push(approval)
    orderedByChatId.set(chatId, ordered)
  }

  for (const entry of recovered) append(entry.chatId, entry.approval)
  const existingChatIds = new Set([
    ...Object.keys(approvalHeadByChatId),
    ...Object.keys(approvalQueueByChatId)
  ])
  for (const chatId of existingChatIds) {
    append(chatId, approvalHeadByChatId[chatId])
    for (const approval of approvalQueueByChatId[chatId] ?? []) append(chatId, approval)
  }

  const nextHeads: Record<string, T | null> = {}
  const nextQueues: Record<string, T[]> = {}
  for (const chatId of new Set([...existingChatIds, ...orderedByChatId.keys()])) {
    const ordered = orderedByChatId.get(chatId) ?? []
    nextHeads[chatId] = ordered[0] ?? null
    if (ordered.length > 1) nextQueues[chatId] = ordered.slice(1)
  }
  return {
    approvalHeadByChatId: nextHeads,
    approvalQueueByChatId: nextQueues
  }
}

/**
 * Coordinates the short race window between subscribing to live approval IPC
 * and receiving the authoritative recovery snapshot.
 */
export class PendingApprovalRecoveryWindow<T extends { id: string }> {
  private pending = true
  private cancelled = false
  private readonly settledIds = new Set<string>()
  private readonly liveRequests: RoutedPendingApproval<T>[] = []

  recordLive(request: RoutedPendingApproval<T>): void {
    if (!this.pending || this.cancelled) return
    this.liveRequests.push(request)
  }

  recordSettled(approvalId: string): void {
    if (!this.pending || this.cancelled || !approvalId) return
    this.settledIds.add(approvalId)
  }

  reconcile(
    recovered: readonly RoutedPendingApproval<T>[]
  ): ChatSurfacePendingApprovalState<T> | null {
    if (!this.pending || this.cancelled) return null
    return mergeRecoveredPendingApprovals(
      [...recovered, ...this.liveRequests],
      {},
      {},
      this.settledIds
    )
  }

  finish(): void {
    this.pending = false
    this.settledIds.clear()
    this.liveRequests.length = 0
  }

  cancel(): void {
    this.cancelled = true
    this.finish()
  }
}
