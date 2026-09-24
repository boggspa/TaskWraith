/**
 * messageActivityAggregate.ts — the chat-side facts behind the welcome
 * dashboard, as a bounded aggregate instead of full chat records.
 *
 * The dashboard aggregator (`src/renderer/src/lib/welcomeUsageDashboard.ts`)
 * used to walk every message of every chat for five facts: which local days
 * saw a message (streaks), which of those fall inside the selected range
 * (active days), which chats had an in-range message (sessions, in union with
 * usage records), how many in-range messages there were, and whether any chat
 * holds a message at all. This module names those facts so a backend that
 * keeps only per-message timestamps — the thread catalogue — can answer
 * without loading a transcript. `messageActivityFromChats` is the reference
 * implementation over full records; every backend must agree with it.
 *
 * Day keys are local calendar days (`YYYY-MM-DD`) in the timezone of the
 * process that builds the aggregate, exactly as the dashboard buckets usage
 * records. The catalogue worker runs on the same machine as the dashboard, so
 * the two agree; a backend on another host would have to bucket with this
 * host's offset.
 */

/** Both cutoffs are epoch milliseconds; `0` means "no cutoff". */
export interface MessageActivityRequest {
  /**
   * The dashboard's global stat reset. A message before it is dropped before
   * anything is counted, so every fact below reads as if history began here.
   */
  resetAt: number
  /**
   * Start of the selected range (`now - 30d` for the remote dashboard). Only
   * the `range*` facts apply it; the lifetime facts ignore it.
   */
  rangeStart: number
}

/**
 * Every array is sorted ascending and free of duplicates, so two backends
 * answering the same request produce byte-identical aggregates.
 */
export interface MessageActivityAggregate {
  /**
   * Distinct local day keys of every post-reset message whose timestamp
   * parses. Feeds the lifetime calendar behind current and longest streak.
   */
  lifetimeDayKeys: string[]
  /** Post-reset messages whose timestamp parses and is at or after `rangeStart`. */
  rangeMessageCount: number
  /** Distinct local day keys of those in-range messages. */
  rangeDayKeys: string[]
  /** Distinct chat ids (`appChatId`) with at least one in-range message. */
  rangeChatIds: string[]
  /**
   * Whether any chat holds a message at all. For a full record that is a
   * message surviving the reset cutoff — and, with no reset set, any message
   * even without a parseable timestamp. A summary-only list row cannot apply
   * the reset and counts when its `messageCount` is positive.
   */
  hasAnyMessage: boolean
}

/** Async so the answer can come from a worker or a database, not the main thread. */
export type MessageActivityProvider = (
  request: MessageActivityRequest
) => Promise<MessageActivityAggregate>

/**
 * What the reference implementation reads from a chat: a full record's
 * messages, or the `messageCount` a summary-only list row carries instead.
 */
export interface MessageActivitySource {
  appChatId: string
  messages?: ReadonlyArray<{ timestamp?: string }>
  summaryOnly?: boolean
  messageCount?: number
}

/** Local calendar day of a timestamp, `YYYY-MM-DD`. */
export const messageActivityDayKey = (timestamp: number): string => {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const emptyMessageActivity = (): MessageActivityAggregate => ({
  lifetimeDayKeys: [],
  rangeMessageCount: 0,
  rangeDayKeys: [],
  rangeChatIds: [],
  hasAnyMessage: false
})

const cutoffOf = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

/** The dashboard's own parse: an absent or malformed timestamp is `NaN`. */
const messageTimestamp = (message: { timestamp?: string }): number =>
  new Date(message.timestamp || '').getTime()

/**
 * Reference implementation over full records (and summary-only rows, which
 * contribute only to `hasAnyMessage`). This is the walk the dashboard used to
 * do inline; a catalogue backend must return the same aggregate for the same
 * request.
 */
export function messageActivityFromChats(
  chats: ReadonlyArray<MessageActivitySource>,
  request: MessageActivityRequest
): MessageActivityAggregate {
  const resetAt = cutoffOf(request.resetAt)
  const rangeStart = cutoffOf(request.rangeStart)
  const lifetimeDayKeys = new Set<string>()
  const rangeDayKeys = new Set<string>()
  const rangeChatIds = new Set<string>()
  let rangeMessageCount = 0
  let hasAnyMessage = false
  for (const chat of chats) {
    if (chat.summaryOnly === true) {
      if ((chat.messageCount ?? 0) > 0) hasAnyMessage = true
      continue
    }
    const messages = chat.messages || []
    if (resetAt === 0 && messages.length > 0) hasAnyMessage = true
    for (const message of messages) {
      const timestamp = messageTimestamp(message)
      if (!Number.isFinite(timestamp)) continue
      if (resetAt > 0 && timestamp < resetAt) continue
      hasAnyMessage = true
      lifetimeDayKeys.add(messageActivityDayKey(timestamp))
      if (timestamp < rangeStart) continue
      rangeMessageCount += 1
      rangeDayKeys.add(messageActivityDayKey(timestamp))
      rangeChatIds.add(chat.appChatId)
    }
  }
  return {
    lifetimeDayKeys: [...lifetimeDayKeys].sort(),
    rangeMessageCount,
    rangeDayKeys: [...rangeDayKeys].sort(),
    rangeChatIds: [...rangeChatIds].sort(),
    hasAnyMessage
  }
}
