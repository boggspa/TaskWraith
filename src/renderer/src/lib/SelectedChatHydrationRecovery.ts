export interface SelectedChatHydrationState {
  chatId: string
  phase: 'loading' | 'failed'
}

interface HydrationCycle {
  chatId: string
  attempts: number
  cancelScheduled?: () => void
}

export interface SelectedChatHydrationBindings {
  needsHydration(chatId: string): boolean
  /** The existing paged/full read and commit chain, including its single-flight pool. */
  hydrate(chatId: string): Promise<unknown | null>
  publish(state: SelectedChatHydrationState | null): void
  afterPaint(callback: () => void): () => void
  scheduleRetry(callback: () => void, delayMs: number): () => void
}

const RETRY_DELAYS_MS = [1_000, 3_000] as const

/** Recover a selected summary without polling or discarding valid slow reads. */
export class SelectedChatHydrationRecovery {
  private selectedId: string | null = null
  private cycle: HydrationCycle | null = null
  private state: SelectedChatHydrationState | null = null

  constructor(private readonly bindings: SelectedChatHydrationBindings) {}

  select(chatId: string | null): void {
    if (chatId !== this.selectedId) {
      this.cancelCycle()
      this.selectedId = chatId
    }
    this.reconcile()
  }

  /** A live full record or installed page can finish recovery between attempts. */
  reconcile(): void {
    const chatId = this.selectedId
    if (!chatId || !this.bindings.needsHydration(chatId)) {
      this.cancelCycle()
      this.publish(null)
      return
    }
    // Retain an exhausted cycle until explicit Retry or a new selection.
    if (this.cycle) return
    const cycle: HydrationCycle = { chatId, attempts: 0 }
    this.cycle = cycle
    this.publish({ chatId, phase: 'loading' })
    cycle.cancelScheduled = this.bindings.afterPaint(() => this.attempt(cycle))
  }

  retry(): void {
    if (this.state?.phase !== 'failed') return
    this.cancelCycle()
    this.reconcile()
  }

  dispose(): void {
    this.cancelCycle()
    this.selectedId = null
  }

  private cancelCycle(): void {
    this.cycle?.cancelScheduled?.()
    this.cycle = null
  }

  private publish(state: SelectedChatHydrationState | null): void {
    if (this.state?.chatId === state?.chatId && this.state?.phase === state?.phase) return
    this.state = state
    this.bindings.publish(state)
  }

  private attempt(cycle: HydrationCycle): void {
    cycle.cancelScheduled = undefined
    if (this.cycle !== cycle) return
    if (!this.bindings.needsHydration(cycle.chatId)) {
      this.reconcile()
      return
    }
    cycle.attempts += 1
    void Promise.resolve()
      .then(() => {
        if (this.cycle !== cycle || !this.bindings.needsHydration(cycle.chatId)) return null
        return this.bindings.hydrate(cycle.chatId)
      })
      .then(
        (result) => this.settle(cycle, result != null),
        () => this.settle(cycle, false)
      )
  }

  private settle(cycle: HydrationCycle, succeeded: boolean): void {
    if (this.cycle !== cycle) return
    if (succeeded || !this.bindings.needsHydration(cycle.chatId)) {
      this.cancelCycle()
      this.publish(null)
      return
    }
    const delayMs = RETRY_DELAYS_MS[cycle.attempts - 1]
    if (delayMs === undefined) {
      this.publish({ chatId: cycle.chatId, phase: 'failed' })
      return
    }
    cycle.cancelScheduled = this.bindings.scheduleRetry(() => this.attempt(cycle), delayMs)
  }
}
