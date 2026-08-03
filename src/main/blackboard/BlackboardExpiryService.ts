import type { ChatRecord } from '../store/types'
import { nextBlackboardExpiryAt, pruneExpiredBlackboardEntries } from './Blackboard'

export const BLACKBOARD_EXPIRY_RETRY_MS = 1_000

export interface BlackboardExpiryServiceDeps {
  listChats: () => ChatRecord[]
  getChat: (chatId: string) => ChatRecord | null
  saveChat: (chat: ChatRecord) => ChatRecord
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => unknown
  clearTimeout?: (handle: unknown) => void
  onError?: (error: unknown, chatId?: string) => void
}

/**
 * One main-process timer for every expiring Blackboard entry.
 *
 * The service keeps only the nearest expiry per chat, refreshes that index from
 * every ordinary chat save, and removes due entries through the same canonical
 * save/broadcast path as other Blackboard mutations. Startup recovery is
 * deferred to a zero-delay timer so loading old ephemeral notes cannot delay
 * app readiness. A failed persist retries with backoff and never treats the
 * entry as deleted.
 */
export class BlackboardExpiryService {
  private readonly listChats: () => ChatRecord[]
  private readonly getChat: (chatId: string) => ChatRecord | null
  private readonly saveChat: (chat: ChatRecord) => ChatRecord
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly onError: (error: unknown, chatId?: string) => void
  private readonly expiryByChatId = new Map<string, number>()
  private timer: unknown = null
  private started = false
  private sweeping = false
  private retryNotBefore = 0

  constructor(deps: BlackboardExpiryServiceDeps) {
    this.listChats = deps.listChats
    this.getChat = deps.getChat
    this.saveChat = deps.saveChat
    this.now = deps.now || Date.now
    this.setTimer = deps.setTimeout || ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer =
      deps.clearTimeout || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.onError =
      deps.onError ||
      ((error, chatId) => {
        console.warn(
          `[blackboard-expiry] Failed to remove expired entries${chatId ? ` for ${chatId}` : ''}:`,
          error
        )
      })
  }

  start(): void {
    if (this.started) return
    this.started = true
    try {
      for (const chat of this.listChats()) this.indexChat(chat)
    } catch (error) {
      this.reportError(error)
      this.retryNotBefore = this.now() + BLACKBOARD_EXPIRY_RETRY_MS
    }
    this.rearm()
  }

  /** Observe the canonical record returned by an ordinary chat save. */
  observeChat(chat: ChatRecord): void {
    const changed = this.indexChat(chat)
    if (changed && this.started && !this.sweeping) this.rearm()
  }

  stop(): void {
    this.started = false
    this.sweeping = false
    this.retryNotBefore = 0
    this.expiryByChatId.clear()
    this.clearArmedTimer()
  }

  private indexChat(chat: ChatRecord): boolean {
    const nextExpiry = nextBlackboardExpiryAt(chat.ensemble?.blackboard || [])
    const currentExpiry = this.expiryByChatId.get(chat.appChatId) ?? null
    if (currentExpiry === nextExpiry) return false
    if (nextExpiry === null) this.expiryByChatId.delete(chat.appChatId)
    else this.expiryByChatId.set(chat.appChatId, nextExpiry)
    return true
  }

  private clearArmedTimer(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private rearm(): void {
    this.clearArmedTimer()
    if (!this.started || this.sweeping || this.expiryByChatId.size === 0) return
    let earliest = Number.POSITIVE_INFINITY
    for (const expiryMs of this.expiryByChatId.values()) earliest = Math.min(earliest, expiryMs)
    const target = Math.max(earliest, this.retryNotBefore)
    const delayMs = Math.max(0, target - this.now())
    const handle = this.setTimer(() => {
      this.timer = null
      this.sweepDue()
    }, delayMs)
    this.timer = handle
    ;(handle as { unref?: () => void })?.unref?.()
  }

  private sweepDue(): void {
    if (!this.started || this.sweeping) return
    this.sweeping = true
    const nowMs = this.now()
    let failed = false
    try {
      for (const [chatId, expiryMs] of [...this.expiryByChatId]) {
        if (expiryMs > nowMs) continue
        const chat = this.getChat(chatId)
        if (!chat) {
          this.expiryByChatId.delete(chatId)
          continue
        }
        const current = chat.ensemble?.blackboard || []
        const next = pruneExpiredBlackboardEntries(current, nowMs)
        if (next === current) {
          this.indexChat(chat)
          continue
        }
        try {
          const nowIso = new Date(nowMs).toISOString()
          const saved = this.saveChat({
            ...chat,
            ensemble: {
              ...chat.ensemble!,
              blackboard: next,
              updatedAt: nowIso
            },
            updatedAt: nowMs
          })
          this.indexChat(saved)
        } catch (error) {
          failed = true
          this.reportError(error, chatId)
        }
      }
    } finally {
      this.retryNotBefore = failed ? nowMs + BLACKBOARD_EXPIRY_RETRY_MS : 0
      this.sweeping = false
      this.rearm()
    }
  }

  private reportError(error: unknown, chatId?: string): void {
    try {
      this.onError(error, chatId)
    } catch (reportError) {
      console.error(
        '[blackboard-expiry] Error reporter failed:',
        new AggregateError([error, reportError], 'Blackboard expiry and reporter both failed.')
      )
    }
  }
}
