import { describe, expect, it } from 'vitest'
import {
  emptyMessageActivity,
  messageActivityDayKey,
  messageActivityFromChats,
  type MessageActivityAggregate,
  type MessageActivityRequest,
  type MessageActivitySource
} from './messageActivityAggregate'

const NOW = new Date(2026, 4, 22, 12, 0).getTime()
const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const chat = (appChatId: string, timestamps: string[]): MessageActivitySource => ({
  appChatId,
  messages: timestamps.map((timestamp) => ({ timestamp }))
})
const summaryRow = (appChatId: string, messageCount: number): MessageActivitySource => ({
  appChatId,
  summaryOnly: true,
  messageCount,
  messages: []
})

/**
 * The walk `buildWelcomeUsageDashboardData` did over full records before the
 * aggregate existed — reset map, message events, lifetime loop and the
 * `lifetimeHasActivity` predicate — copied verbatim. The reference
 * implementation must agree with it on every input.
 */
const legacyWalk = (
  chats: MessageActivitySource[],
  request: MessageActivityRequest
): MessageActivityAggregate => {
  const startOfLocalDay = (timestamp: number): number => {
    const date = new Date(timestamp)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const dayKeyFromTimestamp = (timestamp: number): string => {
    const date = new Date(startOfLocalDay(timestamp))
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }
  const cutoff =
    Number.isFinite(request.rangeStart) && request.rangeStart > 0 ? request.rangeStart : 0
  const resetCutoff = Number.isFinite(request.resetAt) && request.resetAt > 0 ? request.resetAt : 0
  const chatsAfterReset =
    resetCutoff > 0
      ? chats.map((entry) => ({
          ...entry,
          messages: (entry.messages || []).filter((message) => {
            const ts = new Date(message.timestamp || '').getTime()
            return Number.isFinite(ts) && ts >= resetCutoff
          })
        }))
      : chats
  const messageEvents = chatsAfterReset.flatMap((entry) =>
    (entry.messages || [])
      .map((message) => ({
        chatId: entry.appChatId,
        timestamp: new Date(message.timestamp || '').getTime()
      }))
      .filter((event) => Number.isFinite(event.timestamp) && event.timestamp >= cutoff)
  )
  const lifetimeActiveDayKeys = new Set<string>()
  for (const entry of chatsAfterReset) {
    for (const message of entry.messages || []) {
      const ts = new Date(message.timestamp || '').getTime()
      if (Number.isFinite(ts)) lifetimeActiveDayKeys.add(dayKeyFromTimestamp(ts))
    }
  }
  const activeDayKeys = new Set<string>()
  const sessionIds = new Set<string>()
  for (const event of messageEvents) {
    activeDayKeys.add(dayKeyFromTimestamp(event.timestamp))
    sessionIds.add(event.chatId)
  }
  const hasAnyMessage = chatsAfterReset.some((entry) =>
    entry.summaryOnly === true ? (entry.messageCount ?? 0) > 0 : (entry.messages || []).length > 0
  )
  return {
    lifetimeDayKeys: [...lifetimeActiveDayKeys].sort(),
    rangeMessageCount: messageEvents.length,
    rangeDayKeys: [...activeDayKeys].sort(),
    rangeChatIds: [...sessionIds].sort(),
    hasAnyMessage
  }
}

const FIXTURE: MessageActivitySource[] = [
  chat('alpha', [
    ago(70 * DAY),
    ago(40 * DAY + HOUR),
    ago(30 * DAY - MINUTE),
    ago(30 * DAY + MINUTE),
    ago(7 * DAY),
    ago(2 * HOUR),
    'not a date',
    ''
  ]),
  chat('beta', [ago(6 * DAY), ago(6 * DAY - 1000), ago(25 * HOUR)]),
  chat('gamma', [ago(100 * DAY), ago(99 * DAY)]),
  summaryRow('delta', 4),
  chat('epsilon', []),
  { appChatId: 'no-messages-field' },
  chat('zeta', [ago(DAY), ago(0)])
]

const REQUESTS: MessageActivityRequest[] = [
  { resetAt: 0, rangeStart: 0 },
  { resetAt: 0, rangeStart: NOW - 30 * DAY },
  { resetAt: 0, rangeStart: NOW - 7 * DAY },
  { resetAt: 0, rangeStart: NOW - DAY },
  { resetAt: NOW - 50 * DAY, rangeStart: NOW - 30 * DAY },
  { resetAt: NOW - 50 * DAY, rangeStart: 0 },
  { resetAt: NOW - 1000, rangeStart: 0 },
  { resetAt: NOW - 6 * DAY - 500, rangeStart: NOW - 7 * DAY },
  { resetAt: NOW + DAY, rangeStart: 0 },
  { resetAt: Number.NaN, rangeStart: -5 }
]

/** Small deterministic PRNG so the property run is reproducible. */
const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('messageActivityFromChats', () => {
  it('agrees with the legacy full-record walk on the boundary fixture for every request', () => {
    for (const request of REQUESTS) {
      expect(messageActivityFromChats(FIXTURE, request), JSON.stringify(request)).toEqual(
        legacyWalk(FIXTURE, request)
      )
    }
  })

  it('agrees with the legacy walk on random chats and cutoffs', () => {
    const random = mulberry32(2026)
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const timestamps: number[] = []
      const chats: MessageActivitySource[] = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        (_, index) => {
          if (random() < 0.15) return summaryRow(`summary-${index}`, Math.floor(random() * 3))
          const messages = Array.from({ length: Math.floor(random() * 6) }, () => {
            if (random() < 0.1) return { timestamp: pick(['', 'nope', undefined]) }
            const ts = NOW - Math.floor(random() * 120 * DAY) + Math.floor(random() * 2 * HOUR)
            timestamps.push(ts)
            return { timestamp: new Date(ts).toISOString() }
          })
          return { appChatId: `chat-${index % 4}`, messages }
        }
      )
      const cutoff = (): number => {
        const mode = random()
        if (mode < 0.3) return 0
        if (mode < 0.6 && timestamps.length > 0) return pick(timestamps)
        return NOW - Math.floor(random() * 130 * DAY)
      }
      const request = { resetAt: cutoff(), rangeStart: cutoff() }
      expect(messageActivityFromChats(chats, request), JSON.stringify({ chats, request })).toEqual(
        legacyWalk(chats, request)
      )
    }
  })

  it('drops messages before the reset before any fact is counted', () => {
    const chats = [chat('a', [ago(10 * DAY), ago(2 * DAY)])]
    const activity = messageActivityFromChats(chats, { resetAt: NOW - 5 * DAY, rangeStart: 0 })
    expect(activity.lifetimeDayKeys).toEqual([messageActivityDayKey(NOW - 2 * DAY)])
    expect(activity.rangeMessageCount).toBe(1)
    expect(messageActivityFromChats(chats, { resetAt: NOW - DAY, rangeStart: 0 })).toEqual(
      emptyMessageActivity()
    )
  })

  it('applies the range as an instant on top of the reset, not as a day boundary', () => {
    const rangeStart = NOW - 7 * DAY
    const chats = [chat('a', [new Date(rangeStart - MINUTE).toISOString(), ago(20 * DAY)])]
    const activity = messageActivityFromChats(chats, { resetAt: 0, rangeStart })
    expect(activity.lifetimeDayKeys).toEqual([
      messageActivityDayKey(NOW - 20 * DAY),
      messageActivityDayKey(rangeStart - MINUTE)
    ])
    expect(activity.rangeDayKeys).toEqual([])
    expect(activity.rangeChatIds).toEqual([])
    expect(activity.rangeMessageCount).toBe(0)
    expect(activity.hasAnyMessage).toBe(true)
  })

  it('ignores unparseable timestamps except for hasAnyMessage with no reset', () => {
    const chats = [chat('a', ['nope', ''])]
    expect(messageActivityFromChats(chats, { resetAt: 0, rangeStart: 0 })).toEqual({
      ...emptyMessageActivity(),
      hasAnyMessage: true
    })
    expect(messageActivityFromChats(chats, { resetAt: 1, rangeStart: 0 })).toEqual(
      emptyMessageActivity()
    )
  })

  it('lets a summary-only row answer only hasAnyMessage, from messageCount', () => {
    const rows = [summaryRow('s', 3)]
    expect(messageActivityFromChats(rows, { resetAt: NOW + DAY, rangeStart: 0 })).toEqual({
      ...emptyMessageActivity(),
      hasAnyMessage: true
    })
    expect(messageActivityFromChats([summaryRow('s', 0)], { resetAt: 0, rangeStart: 0 })).toEqual(
      emptyMessageActivity()
    )
  })

  it('returns sorted, de-duplicated day keys and chat ids', () => {
    const chats = [chat('zed', [ago(DAY), ago(DAY + HOUR)]), chat('abe', [ago(0), ago(DAY)])]
    const activity = messageActivityFromChats(chats, { resetAt: 0, rangeStart: 0 })
    expect(activity.rangeChatIds).toEqual(['abe', 'zed'])
    expect(activity.rangeDayKeys).toEqual([
      messageActivityDayKey(NOW - DAY),
      messageActivityDayKey(NOW)
    ])
    expect(activity.lifetimeDayKeys).toEqual(activity.rangeDayKeys)
    expect(activity.rangeMessageCount).toBe(4)
  })

  it('keys days on the local calendar', () => {
    expect(messageActivityDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
    expect(messageActivityDayKey(new Date(2026, 0, 6, 0, 0).getTime())).toBe('2026-01-06')
  })

  it('emptyMessageActivity is the aggregate of no chats', () => {
    expect(messageActivityFromChats([], { resetAt: 0, rangeStart: 0 })).toEqual(
      emptyMessageActivity()
    )
  })
})
