'use strict'

/**
 * Literal 60-minute 50-chat select / hydrate / demote schedule (T1b).
 *
 * Separate from fixtureGenerator.buildReplaySchedule so T1a fixture fingerprints
 * stay stable. Schedule version is intentional and tested.
 *
 * Baseline (HEAD) may observe demote_candidate as a no-op; after reports must
 * verify demotion actually dropped hydrated bytes when collectors are attached.
 */

const SCHEDULE_VERSION = 1
const DURATION_MS = 60 * 60 * 1000
const CHAT_COUNT = 50
/** Deterministic dwell per chat visit (ms). 50 chats × 72s = 3600s. */
const DWELL_MS = 72_000
const TICK_MS = 6_000

/**
 * @param {object} [options]
 * @param {number} [options.seed=42]
 * @param {number} [options.chatCount=50]
 * @param {number} [options.durationMs=3600000]
 * @param {number} [options.dwellMs]
 * @param {number} [options.tickMs=6000]
 * @param {string} [options.chatIdPrefix='perf-50_chat_switch-chat-']
 * @param {(n: number, width?: number) => string} [options.pad]
 */
function buildSixtyMinuteChatSwitchSchedule(options = {}) {
  const seed = options.seed == null ? 42 : options.seed
  const chatCount = options.chatCount == null ? CHAT_COUNT : options.chatCount
  const durationMs = options.durationMs == null ? DURATION_MS : options.durationMs
  const dwellMs =
    options.dwellMs == null ? Math.floor(durationMs / Math.max(1, chatCount)) : options.dwellMs
  const tickMs = options.tickMs == null ? TICK_MS : options.tickMs
  const prefix = options.chatIdPrefix || 'perf-50_chat_switch-chat-'
  const pad = options.pad || ((n, width = 2) => String(n).padStart(width, '0'))

  if (chatCount < 1) throw new Error('chatCount must be ≥ 1')
  if (durationMs < chatCount) throw new Error('durationMs too small for chatCount')

  /** @type {object[]} */
  const events = []
  let seq = 0
  let t = 0

  events.push({
    seq: ++seq,
    t: 0,
    kind: 'schedule_start',
    scheduleVersion: SCHEDULE_VERSION,
    seed,
    chatCount,
    durationMs,
    dwellMs,
    tickMs
  })

  for (let i = 0; i < chatCount; i++) {
    const appChatId = `${prefix}${pad(i + 1, 2)}`
    const visitStart = t

    events.push({
      seq: ++seq,
      t,
      kind: 'select_chat',
      appChatId,
      chatIndex: i,
      wallClockMs: t
    })

    events.push({
      seq: ++seq,
      t: t + 1,
      kind: 'hydrate_chat',
      appChatId,
      chatIndex: i,
      wallClockMs: t + 1
    })

    const dwellEnd = visitStart + dwellMs
    let tickAt = visitStart + tickMs
    while (tickAt < dwellEnd && tickAt <= durationMs) {
      events.push({
        seq: ++seq,
        t: tickAt,
        kind: 'wall_clock_tick',
        appChatId,
        chatIndex: i,
        wallClockMs: tickAt,
        elapsedMs: tickAt
      })
      // Alias event for drivers that prefer dwell naming
      events.push({
        seq: ++seq,
        t: tickAt,
        kind: 'dwell',
        appChatId,
        chatIndex: i,
        wallClockMs: tickAt,
        dwellRemainingMs: dwellEnd - tickAt
      })
      tickAt += tickMs
    }

    t = Math.min(durationMs, dwellEnd)

    // Candidate for demotion after leaving the chat (baseline may no-op).
    events.push({
      seq: ++seq,
      t,
      kind: 'demote_candidate',
      appChatId,
      chatIndex: i,
      wallClockMs: t,
      expectDemoteNoOpOnBaseline: true,
      expectDemoteVerifiedAfter: true
    })
  }

  events.push({
    seq: ++seq,
    t: durationMs,
    kind: 'schedule_complete',
    scheduleVersion: SCHEDULE_VERSION,
    seed,
    chatCount,
    durationMs,
    eventCount: events.length + 1,
    requiredKinds: ['select_chat', 'hydrate_chat', 'dwell', 'wall_clock_tick', 'demote_candidate']
  })

  return {
    scheduleVersion: SCHEDULE_VERSION,
    seed,
    chatCount,
    durationMs,
    dwellMs,
    tickMs,
    eventCount: events.length,
    events
  }
}

/**
 * @param {ReturnType<typeof buildSixtyMinuteChatSwitchSchedule>} schedule
 */
function summarizeSixtyMinuteSchedule(schedule) {
  const counts = Object.create(null)
  for (const e of schedule.events) {
    counts[e.kind] = (counts[e.kind] || 0) + 1
  }
  return {
    scheduleVersion: schedule.scheduleVersion,
    durationMs: schedule.durationMs,
    chatCount: schedule.chatCount,
    eventCount: schedule.eventCount,
    kindCounts: counts,
    hasSelect: (counts.select_chat || 0) === schedule.chatCount,
    hasHydrate: (counts.hydrate_chat || 0) === schedule.chatCount,
    hasDemote: (counts.demote_candidate || 0) === schedule.chatCount,
    hasDwell: (counts.dwell || 0) > 0,
    hasWallClockTick: (counts.wall_clock_tick || 0) > 0
  }
}

module.exports = {
  SCHEDULE_VERSION,
  DURATION_MS,
  CHAT_COUNT,
  DWELL_MS,
  TICK_MS,
  buildSixtyMinuteChatSwitchSchedule,
  summarizeSixtyMinuteSchedule
}
