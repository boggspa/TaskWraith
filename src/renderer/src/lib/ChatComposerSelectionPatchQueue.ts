import type {
  ChatComposerSelectionPatchRequest,
  ChatComposerSelectionPatchResult
} from '../../../shared/chatComposerSelectionPatch'

type TimerHandle = unknown

export interface ChatComposerSelectionPatchQueueOptions {
  persist: (request: ChatComposerSelectionPatchRequest) => Promise<ChatComposerSelectionPatchResult>
  onError?: (chatId: string, error: unknown) => void
  delayMs?: number
  schedule?: (callback: () => void, delayMs: number) => TimerHandle
  cancel?: (handle: TimerHandle) => void
}

interface PendingPatch {
  request: ChatComposerSelectionPatchRequest
  timer: TimerHandle
}

const DEFAULT_DELAY_MS = 200

export class ChatComposerSelectionPatchQueue {
  private readonly pendingByChatId = new Map<string, PendingPatch>()
  private readonly inFlightByChatId = new Map<string, Promise<void>>()
  private readonly delayMs: number
  private readonly schedule: (callback: () => void, delayMs: number) => TimerHandle
  private readonly cancel: (handle: TimerHandle) => void
  private disposed = false

  constructor(private readonly options: ChatComposerSelectionPatchQueueOptions) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS
    this.schedule =
      options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
    this.cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle as number))
  }

  enqueue(request: ChatComposerSelectionPatchRequest): void {
    if (this.disposed) return
    let existing = this.pendingByChatId.get(request.chatId)
    if (existing && existing.request.deferProviderScoped !== request.deferProviderScoped) {
      // Immediate permission/workflow edits and busy-run provider edits have
      // different replay semantics. Preserve their boundary instead of OR-ing
      // them into one request that would incorrectly defer both.
      void this.flush(request.chatId)
      existing = undefined
    }
    if (existing) this.cancel(existing.timer)
    const mergedRequest: ChatComposerSelectionPatchRequest = existing
      ? {
          ...request,
          patch: { ...existing.request.patch, ...request.patch },
          deferProviderScoped: existing.request.deferProviderScoped || request.deferProviderScoped,
          queuedAt: existing.request.queuedAt || request.queuedAt
        }
      : request
    const timer = this.schedule(() => {
      void this.flush(request.chatId)
    }, this.delayMs)
    this.pendingByChatId.set(request.chatId, { request: mergedRequest, timer })
  }

  flush(chatId: string): Promise<void> {
    const pending = this.pendingByChatId.get(chatId)
    if (!pending) return this.inFlightByChatId.get(chatId) ?? Promise.resolve()
    this.pendingByChatId.delete(chatId)
    this.cancel(pending.timer)
    const previous = this.inFlightByChatId.get(chatId) ?? Promise.resolve()
    const task = previous
      .catch(() => undefined)
      .then(() => this.options.persist(pending.request))
      .then(() => undefined)
      .catch((error) => {
        this.options.onError?.(chatId, error)
      })
      .finally(() => {
        if (this.inFlightByChatId.get(chatId) === task) {
          this.inFlightByChatId.delete(chatId)
        }
      })
    this.inFlightByChatId.set(chatId, task)
    return task
  }

  async flushAll(): Promise<void> {
    const chatIds = [...this.pendingByChatId.keys()]
    await Promise.all(chatIds.map((chatId) => this.flush(chatId)))
    await Promise.all(this.inFlightByChatId.values())
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.pendingByChatId.values()) this.cancel(pending.timer)
    this.pendingByChatId.clear()
  }
}
