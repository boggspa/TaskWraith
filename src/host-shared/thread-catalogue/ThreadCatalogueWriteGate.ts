export class ThreadCatalogueBusyError extends Error {
  constructor() {
    super('This chat has a history update in progress. Retry when it finishes.')
    this.name = 'ThreadCatalogueBusyError'
  }
}

/** Process-local admission; a recovery never races a new provider admission on this process. */
export class ThreadCatalogueWriteGate {
  private readonly holds = new Map<string, { promise: Promise<void>; release(): void }>()
  private readonly admissions = new Map<string, number>()

  async wait(chatId: string): Promise<void> {
    while (this.holds.has(chatId)) await this.holds.get(chatId)!.promise
  }

  assertAvailable(chatId: string): void {
    if (this.holds.has(chatId)) throw new ThreadCatalogueBusyError()
  }
  isHeld(chatId: string): boolean {
    return this.holds.has(chatId)
  }

  async admit<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    while (this.holds.has(chatId)) await this.holds.get(chatId)!.promise
    this.admissions.set(chatId, (this.admissions.get(chatId) ?? 0) + 1)
    try {
      return await work()
    } finally {
      const count = (this.admissions.get(chatId) ?? 1) - 1
      if (count) this.admissions.set(chatId, count)
      else this.admissions.delete(chatId)
    }
  }

  /**
   * Bounded-wait admission for writes that answer to a shorter caller-side
   * lease (the composer-selection picker's 15 s claim behind
   * `persistChatComposerSelection`). A catalogue recovery hold can park an
   * `admit` waiter for minutes with no rejection, which reads to the caller as
   * a silent revert. This variant waits for a held gate only up to `waitMs`
   * and then rejects with ThreadCatalogueBusyError, so the write lands or
   * visibly fails inside the caller's own window. Admission and work semantics
   * are identical to `admit`; only the hold wait is bounded.
   */
  async admitBounded<T>(chatId: string, waitMs: number, work: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + Math.max(0, waitMs)
    while (this.holds.has(chatId)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new ThreadCatalogueBusyError()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.holds.get(chatId)!.promise,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining)
          })
        ])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    this.admissions.set(chatId, (this.admissions.get(chatId) ?? 0) + 1)
    try {
      return await work()
    } finally {
      const count = (this.admissions.get(chatId) ?? 1) - 1
      if (count) this.admissions.set(chatId, count)
      else this.admissions.delete(chatId)
    }
  }

  hold(chatId: string): (() => void) | null {
    if (this.holds.has(chatId) || this.admissions.has(chatId)) return null
    let resolve!: () => void
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    const entry = { promise, release: resolve }
    this.holds.set(chatId, entry)
    return () => {
      if (this.holds.get(chatId) !== entry) return
      this.holds.delete(chatId)
      entry.release()
    }
  }
}

export const threadCatalogueWriteGate = new ThreadCatalogueWriteGate()

export function gateThreadDispatch<TArgs extends unknown[], TResult>(
  dispatch: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  return (...args) => {
    const payload = args[0] as { appChatId?: unknown } | undefined
    const id = typeof payload?.appChatId === 'string' ? payload.appChatId : ''
    return id ? threadCatalogueWriteGate.admit(id, () => dispatch(...args)) : dispatch(...args)
  }
}
