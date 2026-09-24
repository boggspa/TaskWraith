import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_STALL_ALERT_MS,
  TRANSCRIPT_STALL_WARN_MS,
  TranscriptStallWatchdog
} from './transcriptStallWatchdog'

describe('TranscriptStallWatchdog', () => {
  it('reads current for a chat nothing has announced', () => {
    const watchdog = new TranscriptStallWatchdog()
    expect(watchdog.status('chat-1', 10_000).level).toBe('current')
    expect(watchdog.status(null, 10_000).level).toBe('current')
  })

  it('reads current once the announced sequence is settled', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 1, 0)
    watchdog.settle('chat-1', 1, 20)
    const status = watchdog.status('chat-1', 60_000)
    expect(status.level).toBe('current')
    expect(status.lagMs).toBe(0)
  })

  it('escalates current → catching-up → stalled as the gap ages', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 1, 0)
    expect(watchdog.status('chat-1', TRANSCRIPT_STALL_WARN_MS - 1).level).toBe('current')
    expect(watchdog.status('chat-1', TRANSCRIPT_STALL_WARN_MS).level).toBe('catching-up')
    expect(watchdog.status('chat-1', TRANSCRIPT_STALL_ALERT_MS).level).toBe('stalled')
  })

  it('measures from the OLDEST unsettled announcement, so a chatty producer cannot hide a stall', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 1, 0)
    // Main keeps announcing every 200ms while the renderer commits nothing.
    for (let sequence = 2; sequence <= 50; sequence += 1) {
      watchdog.announce('chat-1', sequence, sequence * 200)
    }
    const status = watchdog.status('chat-1', 10_000)
    expect(status.lagMs).toBe(10_000)
    expect(status.level).toBe('stalled')
  })

  it('restarts the clock on the remaining gap after partial progress', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 1, 0)
    watchdog.announce('chat-1', 2, 100)
    watchdog.settle('chat-1', 1, 9_000)
    // Sequence 2 is still outstanding, but its wait restarts at the settle.
    expect(watchdog.status('chat-1', 9_500).lagMs).toBe(500)
    expect(watchdog.status('chat-1', 9_500).level).toBe('current')
  })

  it('reports the exact 2026-09-11 shape: rows appear all at once after a long silence', () => {
    const watchdog = new TranscriptStallWatchdog()
    // Round starts; main announces 13 rows across 52 seconds.
    for (let sequence = 1; sequence <= 13; sequence += 1) {
      watchdog.announce('chat-1', sequence, sequence * 4_000)
    }
    expect(watchdog.status('chat-1', 120_000).level).toBe('stalled')
    expect(watchdog.status('chat-1', 120_000).lagMs).toBe(116_000)
    // The renderer finally catches up in one commit.
    watchdog.settle('chat-1', 13, 120_000)
    expect(watchdog.status('chat-1', 120_001).level).toBe('current')
  })

  it('ignores a stale settle below the high-water mark', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 5, 0)
    watchdog.settle('chat-1', 5, 10)
    watchdog.settle('chat-1', 2, 20)
    expect(watchdog.status('chat-1', 60_000).settledSequence).toBe(5)
    expect(watchdog.status('chat-1', 60_000).level).toBe('current')
  })

  it('ignores an out-of-order announce below the high-water mark', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 5, 0)
    watchdog.announce('chat-1', 3, 100)
    expect(watchdog.status('chat-1', 0).announcedSequence).toBe(5)
  })

  it('closes the gap from a resync via settleToAnnounced', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 9, 0)
    expect(watchdog.status('chat-1', 10_000).level).toBe('stalled')
    watchdog.settleToAnnounced('chat-1', 10_000)
    const status = watchdog.status('chat-1', 10_001)
    expect(status.level).toBe('current')
    // `level` alone is not the claim. Settling to any sequence re-clocks the
    // lag to ~0 and reads as `current` while still eight frames behind, so the
    // assertion that matters is that the gap is actually CLOSED.
    expect(status.settledSequence).toBe(9)
    expect(status.settledSequence).toBe(status.announcedSequence)
  })

  it('re-clocks on a NEW announcement after catching up — the normal steady state', () => {
    // announce -> settle -> announce -> settle is what every healthy frame does.
    // Without the announce-side re-clock, `oldestUnsettledAtMs` stays pinned to
    // the very first announcement this chat ever made, so after a few minutes of
    // perfectly healthy streaming the watchdog reports a lag of minutes and the
    // notice shows a permanent "stalled" banner over a live transcript.
    const watchdog = new TranscriptStallWatchdog()
    for (let sequence = 1; sequence <= 200; sequence += 1) {
      const at = sequence * 1_000
      watchdog.announce('chat-1', sequence, at)
      watchdog.settle('chat-1', sequence, at)
    }
    // A fresh announcement 200 seconds in must be measured from NOW.
    watchdog.announce('chat-1', 201, 201_000)
    const status = watchdog.status('chat-1', 201_100)
    expect(status.lagMs).toBe(100)
    expect(status.level).toBe('current')
  })

  it('re-clocks even when the settle and the next announce share a timestamp', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 1, 0)
    watchdog.settle('chat-1', 1, 0)
    watchdog.announce('chat-1', 2, 60_000)
    expect(watchdog.status('chat-1', 60_500).lagMs).toBe(500)
  })

  it('keeps chats independent', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-a', 1, 0)
    watchdog.announce('chat-b', 1, 0)
    watchdog.settle('chat-b', 1, 1)
    expect(watchdog.status('chat-a', 10_000).level).toBe('stalled')
    expect(watchdog.status('chat-b', 10_000).level).toBe('current')
  })

  it('reports the worst outstanding lag across chats', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-a', 1, 0)
    watchdog.announce('chat-b', 1, 8_000)
    expect(watchdog.worstLagMs(10_000)).toBe(10_000)
  })

  it('forgets a chat', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('chat-1', 1, 0)
    watchdog.forget('chat-1')
    expect(watchdog.status('chat-1', 10_000).level).toBe('current')
  })

  it('bounds tracked chats by evicting the oldest-touched', () => {
    const watchdog = new TranscriptStallWatchdog({ maxTrackedChats: 2 })
    watchdog.announce('chat-a', 1, 0)
    watchdog.announce('chat-b', 1, 0)
    watchdog.announce('chat-c', 1, 0)
    expect(watchdog.status('chat-a', 10_000).level).toBe('current')
    expect(watchdog.status('chat-c', 10_000).level).toBe('stalled')
  })

  it('rejects malformed announcements rather than tracking them', () => {
    const watchdog = new TranscriptStallWatchdog()
    watchdog.announce('', 1, 0)
    watchdog.announce('chat-1', 0, 0)
    watchdog.announce('chat-1', 1.5, 0)
    expect(watchdog.status('chat-1', 60_000).level).toBe('current')
  })

  it('honours custom thresholds and never lets alert fall below warn', () => {
    const watchdog = new TranscriptStallWatchdog({ warnMs: 400, alertMs: 100 })
    watchdog.announce('chat-1', 1, 0)
    expect(watchdog.status('chat-1', 399).level).toBe('current')
    expect(watchdog.status('chat-1', 400).level).toBe('stalled')
  })
})
