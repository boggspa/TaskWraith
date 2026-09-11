import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { TranscriptTailBroadcaster } from './TranscriptTailBroadcaster'
import { TranscriptVisibilityLatency } from './TranscriptVisibilityLatency'
import {
  MAX_TRANSCRIPT_TAIL_BYTES,
  transcriptTailBytesExceed
} from '../shared/transcriptTailStream'
import { estimateJsonishBytes } from '../shared/transcriptPage'
import { ChatTranscriptStore } from '../renderer/src/lib/chatTranscriptStore'
import { applyTranscriptTailFrame } from '../renderer/src/lib/transcriptTailApplier'
import { TranscriptStallWatchdog } from '../renderer/src/lib/transcriptStallWatchdog'

/**
 * THE GATE. "The transcript never lags" is not a claim this repo is allowed to
 * make without a number behind it, so this file is that number.
 *
 * The invariant under test is not "it is fast" — wall-clock assertions are
 * flaky and would be tuned away the first time CI ran on a loaded box. It is
 * the structural property that makes the latency bounded in the first place:
 *
 *   the work and the bytes between a row being appended and that row being
 *   visible depend ONLY on the number of new rows, never on how large the
 *   transcript is, how many chats are streaming, or how busy main is.
 *
 * That is exactly what was false before. The old path pulled a 500-message /
 * 0.53 MiB page per refresh, served synchronously on main, so every one of
 * those three variables was in the latency.
 *
 * Producer and consumer are driven here in one process deliberately: this is
 * the seam the 2026-09-11 incident crossed, and testing the halves separately
 * is what let it stay broken while both halves passed.
 */

function message(id: string, content = `row ${id}`): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-09-11T17:50:00.000Z' } as ChatMessage
}

function chat(appChatId: string, messages: ChatMessage[]): ChatRecord {
  return { appChatId, messages, runs: [] } as unknown as ChatRecord
}

function transcript(rows: number, prefix = 'm'): ChatMessage[] {
  return Array.from({ length: rows }, (_, index) => message(`${prefix}-${index}`))
}

/** The renderer's paged window, opened on the live tail of `total` rows. */
function openPagedTail(store: ChatTranscriptStore, chatId: string, messages: ChatMessage[]): void {
  const windowSize = Math.min(messages.length, 100)
  const windowStart = messages.length - windowSize
  store.ingestPage({
    chatId,
    messages: messages.slice(windowStart),
    runs: [],
    totalMessageCount: messages.length,
    windowStart,
    windowEnd: messages.length,
    estimatedBytes: 1,
    hasOlder: windowStart > 0,
    hasNewer: false,
    oldestMessageId: messages[windowStart]?.id ?? null,
    newestMessageId: messages[messages.length - 1]?.id ?? null,
    updatedAt: 1
  })
}

describe('transcript liveness gate — cost is independent of transcript size', () => {
  it('carries the same bytes for one appended row at 100, 2k and 20k rows', () => {
    const sizes = [100, 2_000, 20_000]
    const carried = sizes.map((size) => {
      const broadcaster = new TranscriptTailBroadcaster()
      const before = transcript(size)
      broadcaster.observe(chat('chat-1', before))
      const frame = broadcaster.observe(chat('chat-1', [...before, message('appended')]))
      if (frame?.kind !== 'tail-append') throw new Error('expected an append frame')
      return { rows: frame.messages.length, bytes: estimateJsonishBytes(frame.messages) }
    })

    // One row in, one row on the wire, at every transcript size.
    expect(carried.map((entry) => entry.rows)).toEqual([1, 1, 1])
    // And byte-for-byte identical: a 20,000-row thread costs exactly what a
    // 100-row thread costs. The old pull carried a 500-message page either way.
    expect(new Set(carried.map((entry) => entry.bytes)).size).toBe(1)
    expect(carried[0]!.bytes).toBeLessThan(MAX_TRANSCRIPT_TAIL_BYTES)
  })

  it('never exceeds the frame byte ceiling, whatever the transcript weighs', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const before = transcript(20_000)
    broadcaster.observe(chat('chat-1', before))
    const frame = broadcaster.observe(chat('chat-1', [...before, message('a'), message('b')]))
    if (frame?.kind !== 'tail-append') throw new Error('expected an append frame')
    expect(transcriptTailBytesExceed(frame.messages, MAX_TRANSCRIPT_TAIL_BYTES)).toBe(false)
  })
})

describe('transcript liveness gate — N seats x M rows end to end', () => {
  const SEATS = 24
  const ROWS_PER_SEAT = 40
  const STARTING_ROWS = 1_493

  it('keeps every seat current, row by row, with no resyncs and no accumulated lag', () => {
    let clock = 0
    const broadcaster = new TranscriptTailBroadcaster({ maxTrackedChats: SEATS * 2 })
    const store = new ChatTranscriptStore()
    const watchdog = new TranscriptStallWatchdog({ maxTrackedChats: SEATS * 2 })
    // Injected clock: the assertion is that emit and commit happen in the same
    // tick, so a real Date.now would measure the test runner, not the lane.
    const latency = new TranscriptVisibilityLatency({ now: () => clock })

    const canonical = new Map<string, ChatMessage[]>()
    for (let seat = 0; seat < SEATS; seat += 1) {
      const chatId = `chat-${seat}`
      const messages = transcript(STARTING_ROWS, `seat${seat}`)
      canonical.set(chatId, messages)
      broadcaster.observe(chat(chatId, messages))
      openPagedTail(store, chatId, messages)
    }

    let frames = 0
    let worstOutstanding = 0

    // Interleave the seats, the way a fan-out round actually arrives.
    for (let round = 0; round < ROWS_PER_SEAT; round += 1) {
      for (let seat = 0; seat < SEATS; seat += 1) {
        const chatId = `chat-${seat}`
        const messages = canonical.get(chatId)!
        messages.push(message(`seat${seat}-new-${round}`))

        clock += 1
        const frame = broadcaster.observe(chat(chatId, messages))
        expect(frame?.kind).toBe('tail-append')
        if (!frame) throw new Error('expected a frame')
        frames += 1
        latency.recordSent(chatId, frame.sequence, clock)
        watchdog.announce(chatId, frame.sequence, clock)

        const outcome = applyTranscriptTailFrame(frame, store)
        expect(outcome.status).toBe('applied')
        watchdog.settle(chatId, frame.sequence, clock)
        latency.recordCommitted(chatId, frame.sequence)

        const status = watchdog.status(chatId, clock)
        worstOutstanding = Math.max(
          worstOutstanding,
          status.announcedSequence - status.settledSequence
        )
      }
    }

    expect(frames).toBe(SEATS * ROWS_PER_SEAT)
    const counters = broadcaster.counterSnapshot()
    expect(counters.appends).toBe(SEATS * ROWS_PER_SEAT)
    // A single resync means a seat fell back to the pull lane mid-round.
    expect(counters.resyncs).toBe(0)
    expect(counters.appendedRows).toBe(SEATS * ROWS_PER_SEAT)

    // The renderer was never more than the one in-flight frame behind main.
    expect(worstOutstanding).toBe(0)
    expect(watchdog.worstLagMs(clock)).toBe(0)

    // Every seat's visible window tracks main exactly.
    for (let seat = 0; seat < SEATS; seat += 1) {
      const chatId = `chat-${seat}`
      const payload = store.get(chatId)
      expect(payload?.windowEnd).toBe(STARTING_ROWS + ROWS_PER_SEAT)
      expect(payload?.hasNewer).toBe(false)
      expect(payload?.messages.at(-1)?.id).toBe(`seat${seat}-new-${ROWS_PER_SEAT - 1}`)
    }

    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(SEATS * ROWS_PER_SEAT)
    expect(snapshot.pending).toBe(0)
    expect(snapshot.p99Ms).toBe(0)
  })
})

describe('transcript liveness gate — the bound is measured, not assumed', () => {
  it('reports the real lag when main stalls between emit and commit', () => {
    const latency = new TranscriptVisibilityLatency({ now: () => clock })
    const watchdog = new TranscriptStallWatchdog()
    let clock = 0

    // Main emits 13 rows across the 52-second round, and the renderer commits
    // none of them until the very end — the exact 2026-09-11 shape.
    for (let sequence = 1; sequence <= 13; sequence += 1) {
      clock = sequence * 4_000
      latency.recordSent('chat-1', sequence, clock)
      watchdog.announce('chat-1', sequence, clock)
    }

    clock = 120_000
    // Before anything commits, the histogram must NOT read healthy just
    // because nothing completed.
    const stalled = latency.snapshot()
    expect(stalled.samples).toBe(0)
    expect(stalled.pending).toBe(13)
    expect(stalled.oldestPendingMs).toBe(116_000)
    expect(watchdog.status('chat-1', clock)).toMatchObject({
      level: 'stalled',
      lagMs: 116_000
    })

    for (let sequence = 1; sequence <= 13; sequence += 1) {
      latency.recordCommitted('chat-1', sequence)
    }
    watchdog.settle('chat-1', 13, clock)

    const caughtUp = latency.snapshot()
    expect(caughtUp.samples).toBe(13)
    expect(caughtUp.pending).toBe(0)
    // The worst row waited nearly two minutes, and the gate says so.
    expect(caughtUp.maxMs).toBe(116_000)
    expect(caughtUp.p99Ms).toBe(116_000)
    expect(watchdog.status('chat-1', clock).level).toBe('current')
  })

  it('a healthy round reports single-digit visibility latency', () => {
    let clock = 0
    const latency = new TranscriptVisibilityLatency({ now: () => clock })
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      latency.recordSent('chat-1', sequence, clock)
      clock += 3
      latency.recordCommitted('chat-1', sequence)
    }
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(100)
    expect(snapshot.p99Ms).toBe(3)
    expect(snapshot.oldestPendingMs).toBe(0)
  })
})
