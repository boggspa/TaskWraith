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
