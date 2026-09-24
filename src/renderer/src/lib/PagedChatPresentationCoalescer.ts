import type { ChatRecord } from '../../../main/store/types'
import { CHAT_UPDATE_MAX_RENDER_LATENCY_MS } from './chatUpdateRenderUrgency'
import { isChatSummaryRecord } from './chatRecordMerge'
import { shouldRetainReactChatOnFlush } from './chatChromeIdentity'
import { deepEqual } from './messagesRenderEqual'

/*
 * Paged/background live updates used to publish React state per accepted
 * page: every commit replaced the current shell and re-filtered + re-sorted
 * the global chat list, so a burst across several busy panes re-rendered App
 * chrome once per page per chat. This module gives the interest runtime the
 * same presentation contract the full-delivery path already has (App.tsx
 * scheduleCoalescedChatFlush/flushCoalescedChats): canonical refs/stores stay
 * synchronously current at commit time, while React publication is coalesced
 * to one pass per frame (with a hard latency deadline) and object identity is
 * retained when chrome is semantically unchanged.
 */

/**
 * Fields that advance on every accepted page or save without changing what
 * App chrome renders. Mirrors chatChromeIdentity's TRANSCRIPT_STREAM_FIELDS.
 */
const VOLATILE_PRESENTATION_FIELDS = new Set([
  'messages',
  'runs',
  'updatedAt',
  'persistenceRevision'
])

/** Frame fallback when requestAnimationFrame is unavailable (tests, workers). */
export const PRESENTATION_FRAME_FALLBACK_MS = 16

/**
 * Conservative "would chrome render identically" for coalesced publication.
 *
 * Deep comparison is bounded only for summary/shell projections, whose
 * transcript arrays are empty by contract; anything else falls back to the
 * cheap reference-walk predicate (shouldRetainReactChatOnFlush), which
 * conservatively publishes when IPC delivered fresh sub-objects. False
 * negatives cost one redundant render; a false positive would freeze chrome,
 * so every structural difference publishes.
 */
export function pagedChatChromeRenderEqual(
  previous: ChatRecord | null | undefined,
  next: ChatRecord | null | undefined
): boolean {
  if (!previous || !next) return false
  if (previous === next) return true
  if (previous.appChatId !== next.appChatId) return false
  if (!isChatSummaryRecord(previous) || !isChatSummaryRecord(next)) {
    return shouldRetainReactChatOnFlush(previous, next)
  }
  if ((previous.messages?.length ?? 0) !== (next.messages?.length ?? 0)) return false
  const previousRecord = previous as unknown as Record<string, unknown>
  const nextRecord = next as unknown as Record<string, unknown>
  const seen = new Set<string>()
  for (const key of Object.keys(previousRecord)) {
    seen.add(key)
    if (VOLATILE_PRESENTATION_FIELDS.has(key)) continue
    if (!deepEqual(previousRecord[key], nextRecord[key])) return false
  }
  for (const key of Object.keys(nextRecord)) {
    if (seen.has(key) || VOLATILE_PRESENTATION_FIELDS.has(key)) continue
    if (!deepEqual(previousRecord[key], nextRecord[key])) return false
  }
  return true
}

/**
 * One coalesced chat-list publication. Reads canonical records at flush time
 * (never a stale commit-time snapshot), retains element identity for
 * semantically unchanged chrome, skips ids whose canonical record vanished
 * (deletion race — a late page must not resurrect a removed chat), and keeps
 * the paged path's updatedAt-descending order whenever anything publishes.
 */
export function publishCoalescedChatList(
  previous: ChatRecord[],
  dirtyChatIds: ReadonlySet<string>,
  resolveCanonical: (chatId: string) => ChatRecord | undefined
): ChatRecord[] {
  let changed = false
  const seen = new Set<string>()
  const mapped = previous.map((chat) => {
    if (!dirtyChatIds.has(chat.appChatId)) return chat
    seen.add(chat.appChatId)
    const canonical = resolveCanonical(chat.appChatId)
    if (!canonical || canonical === chat) return chat
    if (pagedChatChromeRenderEqual(chat, canonical)) return chat
    changed = true
    return canonical
  })
  const inserts: ChatRecord[] = []
  for (const chatId of dirtyChatIds) {
    if (seen.has(chatId)) continue
    const canonical = resolveCanonical(chatId)
    if (canonical) inserts.push(canonical)
  }
  if (!changed && inserts.length === 0) return previous
  return [...inserts, ...mapped].sort((left, right) => right.updatedAt - left.updatedAt)
}

/** Coalesced current-chat publication with the same retention/deletion rules. */
export function publishCoalescedCurrentChat(
  previous: ChatRecord | null,
  dirtyChatIds: ReadonlySet<string>,
  resolveCanonical: (chatId: string) => ChatRecord | undefined
): ChatRecord | null {
  if (!previous || !dirtyChatIds.has(previous.appChatId)) return previous
  const canonical = resolveCanonical(previous.appChatId)
  if (!canonical || canonical === previous) return previous
  return pagedChatChromeRenderEqual(previous, canonical) ? previous : canonical
}

export interface PagedChatPresentationScheduling {
  /** Frame scheduler; defaults to requestAnimationFrame with a timer fallback. */
  scheduleFrame?: (callback: () => void) => unknown
  cancelFrame?: (handle: unknown) => void
  /** Deadline timer; defaults to setTimeout. */
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  /** Hard latency bound for when frames are starved (hidden/occluded windows). */
  maxLatencyMs?: number
}

/**
 * Frame-coalesced publication scheduler mirroring App.tsx's full-path
 * scheduleCoalescedChatFlush: one frame callback per burst plus a
 * CHAT_UPDATE_MAX_RENDER_LATENCY_MS deadline so a throttled frame cannot
 * defer presentation indefinitely. flushNow drains synchronously (stop /
 * unmount) and firing either timer disarms the other.
 */
export class PagedChatPresentationCoalescer {
  private readonly pending = new Set<string>()
  private readonly scheduleFrame: (callback: () => void) => unknown
  private readonly cancelFrame: (handle: unknown) => void
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly maxLatencyMs: number
  private frameHandle: unknown = null
  private frameArmed = false
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly flush: (chatIds: ReadonlySet<string>) => void,
    scheduling?: PagedChatPresentationScheduling
  ) {
    const hasFrame = typeof requestAnimationFrame === 'function'
    this.scheduleFrame =
      scheduling?.scheduleFrame ??
      (hasFrame
        ? (callback) => requestAnimationFrame(() => callback())
        : (callback) => setTimeout(callback, PRESENTATION_FRAME_FALLBACK_MS))
    this.cancelFrame =
      scheduling?.cancelFrame ??
      (hasFrame
        ? (handle) => cancelAnimationFrame(handle as number)
        : (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.setTimer = scheduling?.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = scheduling?.clearTimer ?? ((timer) => clearTimeout(timer))
    this.maxLatencyMs = boundedLatency(scheduling?.maxLatencyMs)
  }

  schedule(chatId: string): void {
    this.pending.add(chatId)
    if (!this.frameArmed) {
      this.frameArmed = true
      this.frameHandle = this.scheduleFrame(() => {
        this.frameArmed = false
        this.frameHandle = null
        this.flushNow()
      })
    }
    if (this.deadlineTimer === null) {
      this.deadlineTimer = this.setTimer(() => {
        this.deadlineTimer = null
        this.flushNow()
      }, this.maxLatencyMs)
    }
  }

  /** Cancel timers and drain synchronously. No-op when nothing is pending. */
  flushNow(): void {
    this.disarm()
    if (this.pending.size === 0) return
    const batch = new Set(this.pending)
    this.pending.clear()
    this.flush(batch)
  }

  /** Cancel timers without publishing (pending ids survive for a later flush). */
  disarm(): void {
    if (this.frameArmed) {
      this.frameArmed = false
      if (this.frameHandle !== null) this.cancelFrame(this.frameHandle)
      this.frameHandle = null
    }
    if (this.deadlineTimer !== null) {
      this.clearTimer(this.deadlineTimer)
      this.deadlineTimer = null
    }
  }

  stats(): { pending: number; armed: boolean } {
    return { pending: this.pending.size, armed: this.frameArmed || this.deadlineTimer !== null }
  }
}

function boundedLatency(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return CHAT_UPDATE_MAX_RENDER_LATENCY_MS
  }
  return Math.min(5_000, Math.max(1, Math.floor(value)))
}
