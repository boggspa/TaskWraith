/**
 * Per-chat debounce for ensemble transcript flushes.
 *
 * Fan-out used to arm one 250ms timer per ActiveParticipantRun. N parallel
 * lanes therefore produced N flushRun → saveChat calls even when every lane
 * belonged to the same chat. This scheduler collapses those requests onto a
 * single chat-keyed timer and delivers the pending run ids together so the
 * orchestrator can apply every lane's deltas and persist once.
 */

export type EnsembleChatFlushSchedulerOptions = {
  delayMs?: number
  onFlush: (chatId: string, runIds: string[]) => void
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export class EnsembleChatFlushScheduler {
  private readonly delayMs: number
  private readonly onFlush: (chatId: string, runIds: string[]) => void
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly pendingByChatId = new Map<string, Set<string>>()
  private readonly timerByChatId = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(options: EnsembleChatFlushSchedulerOptions) {
    this.delayMs = options.delayMs ?? 250
    this.onFlush = options.onFlush
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  /** Mark a run dirty and arm (or keep) the chat's single debounce timer. */
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

  /**
   * Drop one run from the pending set (e.g. an immediate flushRun already
   * persisted it). Clears the chat timer when nothing remains.
   */
  cancelRun(chatId: string, runId: string): void {
    const pending = this.pendingByChatId.get(chatId)
    if (!pending) return
    pending.delete(runId)
    if (pending.size > 0) return
    this.pendingByChatId.delete(chatId)
    this.clearChatTimer(chatId)
  }

  /** Drop every pending run and timer for a chat (cancel / history fence). */
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
    this.onFlush(chatId, [...pending])
  }
}
