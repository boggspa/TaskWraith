/**
 * Per-chat debounce for the fire-and-forget transcript tail lane.
 *
 * The 250 ms persistence flush is the right cadence for journal writes, but it
 * is too slow for streaming text. This scheduler gives the orchestrator a
 * second, faster timer (default 40 ms) that broadcasts only tail frames: the
 * rows are projected from the in-memory timeline without saving, and the
 * canonical save flush + chat-updated lane reconcile whatever the fast lane
 * missed. Same collapse-by-chat semantics as EnsembleChatFlushScheduler, but
 * the callback contract is broadcast-only — it must never persist.
 */

export type EnsembleTailBroadcastSchedulerOptions = {
  delayMs?: number
  onBroadcast: (chatId: string, runIds: string[]) => void
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export class EnsembleTailBroadcastScheduler {
  private readonly delayMs: number
  private readonly onBroadcast: (chatId: string, runIds: string[]) => void
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly pendingByChatId = new Map<string, Set<string>>()
  private readonly timerByChatId = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: EnsembleTailBroadcastSchedulerOptions) {
    this.delayMs = options.delayMs ?? 40
    this.onBroadcast = options.onBroadcast
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  /** Mark a run dirty for the chat's fast tail timer. */
  schedule(chatId: string, runId: string): void {
    if (!chatId || !runId) return
    let pending = this.pendingByChatId.get(chatId)
    if (!pending) {
      pending = new Set()
      this.pendingByChatId.set(chatId, pending)
    }
    pending.add(runId)
    if (this.timerByChatId.has(chatId)) return
    const handle = this.setTimer(() => this.fire(chatId), this.delayMs)
    this.timerByChatId.set(chatId, handle)
  }

  /** Drop one run from the pending set; clears the chat timer when empty. */
  cancelRun(chatId: string, runId: string): void {
    const pending = this.pendingByChatId.get(chatId)
    if (!pending) return
    pending.delete(runId)
    if (pending.size > 0) return
    this.pendingByChatId.delete(chatId)
    this.clearChatTimer(chatId)
  }

  /** Drop every pending run and timer for a chat. */
  cancelChat(chatId: string): void {
    this.pendingByChatId.delete(chatId)
    this.clearChatTimer(chatId)
  }

  /** Test / teardown helper. */
  clearAll(): void {
    for (const chatId of [...this.timerByChatId.keys()]) this.clearChatTimer(chatId)
    this.pendingByChatId.clear()
  }

  pendingRunIds(chatId: string): string[] {
    return [...(this.pendingByChatId.get(chatId) || [])]
  }

  isArmed(chatId: string): boolean {
    return this.timerByChatId.has(chatId)
  }

  private clearChatTimer(chatId: string): void {
    const handle = this.timerByChatId.get(chatId)
    if (handle === undefined) return
    this.clearTimer(handle)
    this.timerByChatId.delete(chatId)
  }

  private fire(chatId: string): void {
    this.timerByChatId.delete(chatId)
    const pending = this.pendingByChatId.get(chatId)
    this.pendingByChatId.delete(chatId)
    if (!pending || pending.size === 0) return
    this.onBroadcast(chatId, [...pending])
  }
}
