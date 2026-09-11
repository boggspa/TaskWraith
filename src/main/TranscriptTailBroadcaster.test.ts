import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { TranscriptTailBroadcaster } from './TranscriptTailBroadcaster'
import { MAX_TRANSCRIPT_TAIL_ROWS } from '../shared/transcriptTailStream'

function message(id: string, content = `content-${id}`): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-09-11T17:50:00.000Z' } as ChatMessage
}

function chat(messages: ChatMessage[], appChatId = 'chat-1'): ChatRecord {
  return { appChatId, messages, runs: [] } as unknown as ChatRecord
}

/**
 * Rows built ONCE and then spread, which is what every producer in main
 * actually does (`messages: [...chat.messages, row]`). A fixture that rebuilds
 * the prefix on each call is not an append — it is a wholesale replacement —
 * and testing against one is how a prefix check gets "verified" without ever
 * being exercised.
 */
function rows(count: number, prefix = 'm'): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`${prefix}-${index}`))
}

describe('TranscriptTailBroadcaster', () => {
  it('seeds silently on first sighting — the open path owns the initial window', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    expect(broadcaster.observe(chat(rows(1493)))).toBeNull()
    expect(broadcaster.counterSnapshot().seeds).toBe(1)
    expect(broadcaster.counterSnapshot().appends).toBe(0)
  })

  it('pushes ONLY the appended rows, not the window', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const before = rows(1493)
    broadcaster.observe(chat(before))
    const frame = broadcaster.observe(chat([...before, message('new-1'), message('new-2')]))
    expect(frame?.kind).toBe('tail-append')
    if (frame?.kind !== 'tail-append') throw new Error('expected an append frame')
    expect(frame.messages.map((row) => row.id)).toEqual(['new-1', 'new-2'])
    expect(frame.baseMessageCount).toBe(1493)
  })

  it('emits nothing when a save changes no transcript row', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const messages = rows(3)
    broadcaster.observe(chat(messages))
    expect(broadcaster.observe(chat([...messages]))).toBeNull()
    expect(broadcaster.counterSnapshot().noops).toBe(1)
  })

  it('advances the watermark so consecutive appends stay incremental', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const base = rows(2)
    broadcaster.observe(chat(base))
    const a = message('a')
    const first = broadcaster.observe(chat([...base, a]))
    const second = broadcaster.observe(chat([...base, a, message('b')]))
    if (first?.kind !== 'tail-append' || second?.kind !== 'tail-append') {
      throw new Error('expected two append frames')
    }
    expect(first.messages.map((row) => row.id)).toEqual(['a'])
    expect(second.messages.map((row) => row.id)).toEqual(['b'])
    expect(second.baseMessageCount).toBe(3)
    expect(second.sequence).toBeGreaterThan(first.sequence)
  })

  describe('in-place edits — the shape EnsembleOrchestrator.flushRun actually produces', () => {
    it('resyncs when a row is rewritten IN PLACE keeping its id, and a row is appended', () => {
      // `flushRun` reconciles timeline rows by id: `author.update(replacement)`
      // keeps `message.id` and replaces the object (status running -> yielded,
      // tool activity -> complete), then appends the status card. Anchor-id
      // equality holds throughout, so only object identity catches this.
      const broadcaster = new TranscriptTailBroadcaster()
      const a = message('a', 'partial answer')
      const b = message('b', 'tool running')
      broadcaster.observe(chat([a, b]))

      const aFinal = { ...a, content: 'complete answer' } as ChatMessage
      const bFinal = { ...b, content: 'tool complete' } as ChatMessage
      const frame = broadcaster.observe(chat([aFinal, bFinal, message('status')]))

      expect(frame?.kind).toBe('tail-resync')
      expect(broadcaster.counterSnapshot().appends).toBe(0)
    })

    it('resyncs when only the ANCHOR row is rewritten in place', () => {
      const broadcaster = new TranscriptTailBroadcaster()
      const a = message('a')
      const b = message('b', 'streaming…')
      broadcaster.observe(chat([a, b]))
      const bFinal = { ...b, content: 'streaming complete' } as ChatMessage
      expect(broadcaster.observe(chat([a, bFinal, message('c')]))?.kind).toBe('tail-resync')
    })

    it('stays QUIET for an in-place edit with no append — the lane carries row arrival', () => {
      // Streaming text into the tail row: same length, same tail id, new object.
      // This is deliberately a no-op, and the trade-off is explicit: emitting a
      // resync here would fire a `get-chat-transcript-page` on every 250 ms
      // flush, straight into the main thread this lane exists to stop depending
      // on — a storm in the name of freshness. In-place edits stay with the pull
      // lane, exactly where they were before this lane existed.
      //
      // The cost is real and worth naming: the stall watchdog is not told about
      // an edit-only change, so its bound covers row ARRIVAL, not streaming
      // text inside a row already on screen.
      const broadcaster = new TranscriptTailBroadcaster()
      const a = message('a')
      const b = message('b', 'stream 1')
      broadcaster.observe(chat([a, b]))
      const frame = broadcaster.observe(chat([a, { ...b, content: 'stream 2' } as ChatMessage]))
      expect(frame).toBeNull()
      expect(broadcaster.counterSnapshot().resyncs).toBe(0)
    })

    it('still catches an in-place edit once a row is ALSO appended', () => {
      // The dangerous combination: rows rewritten AND the transcript grown, in
      // one save. Silence here would leave superseded rows on screen while the
      // new one arrived beside them.
      const broadcaster = new TranscriptTailBroadcaster()
      const a = message('a', 'partial')
      broadcaster.observe(chat([a]))
      const frame = broadcaster.observe(
        chat([{ ...a, content: 'final' } as ChatMessage, message('next')])
      )
      expect(frame?.kind).toBe('tail-resync')
    })

    it('resyncs on a mid-transcript insertBefore, which is not a tail extension', () => {
      const broadcaster = new TranscriptTailBroadcaster()
      const base = rows(3)
      broadcaster.observe(chat(base))
      const spliced = [base[0]!, message('inserted'), base[1]!, base[2]!]
      expect(broadcaster.observe(chat(spliced))?.kind).toBe('tail-resync')
    })
  })

  it('resyncs when a row id changes', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const a = message('a')
    broadcaster.observe(chat([a, message('b')]))
    expect(broadcaster.observe(chat([a, message('b-renamed'), message('c')]))?.kind).toBe(
      'tail-resync'
    )
  })

  it('resyncs when rows were DELETED', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const base = rows(10)
    broadcaster.observe(chat(base))
    expect(broadcaster.observe(chat(base.slice(0, 4)))?.kind).toBe('tail-resync')
  })

  it('resyncs when a compaction rewrites the prefix but keeps the count', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const a = message('a')
    broadcaster.observe(chat([a, message('b')]))
    expect(broadcaster.observe(chat([a, message('z')]))?.kind).toBe('tail-resync')
  })

  it('resyncs rather than truncating when more rows land than a frame may carry', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const before = rows(5)
    broadcaster.observe(chat(before))
    const frame = broadcaster.observe(
      chat([...before, ...rows(MAX_TRANSCRIPT_TAIL_ROWS + 1, 'burst')])
    )
    expect(frame?.kind).toBe('tail-resync')
    if (frame?.kind !== 'tail-resync') throw new Error('expected a resync frame')
    expect(frame.messageCount).toBe(5 + MAX_TRANSCRIPT_TAIL_ROWS + 1)
  })

  it('keeps the sequence contiguous across a resync so a gap stays readable', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const before = rows(2)
    broadcaster.observe(chat(before))
    const append = broadcaster.observe(chat([...before, message('a')]))
    const x = message('x')
    const resync = broadcaster.observe(chat([x]))
    const next = broadcaster.observe(chat([x, message('y')]))
    expect(append?.sequence).toBe(1)
    expect(resync?.sequence).toBe(2)
    expect(next?.sequence).toBe(3)
    expect(next?.kind).toBe('tail-append')
  })

  describe('paged and summary projections', () => {
    it('ignores a record with NO messages array', () => {
      const broadcaster = new TranscriptTailBroadcaster()
      const base = rows(1493)
      broadcaster.observe(chat(base))
      expect(
        broadcaster.observe({ appChatId: 'chat-1', runs: [] } as unknown as ChatRecord)
      ).toBeNull()
      expect(broadcaster.observe(chat([...base, message('new')]))?.kind).toBe('tail-append')
    })

    it('ignores a shell carrying messages: [] and LEAVES THE WATERMARK ALONE', () => {
      // `buildChatShell` emits `messages: []` with the canonical transcript
      // untouched, and such shells reach saveChat routinely on a large thread.
      // Resetting the watermark here made the escalated save that immediately
      // followed read as "the whole transcript was just appended".
      const broadcaster = new TranscriptTailBroadcaster()
      const base = rows(1493)
      broadcaster.observe(chat(base))

      const shell = {
        appChatId: 'chat-1',
        messages: [],
        runs: [],
        summaryOnly: true,
        transcriptPaged: true,
        messageCount: 1493
      } as unknown as ChatRecord
      expect(broadcaster.observe(shell)).toBeNull()
      expect(broadcaster.counterSnapshot().resyncs).toBe(0)

      // The watermark survived: the next real save is still an incremental
      // append, not a 1,493-row replay.
      const frame = broadcaster.observe(chat([...base, message('after-shell')]))
      expect(frame?.kind).toBe('tail-append')
      if (frame?.kind !== 'tail-append') throw new Error('expected an append frame')
      expect(frame.baseMessageCount).toBe(1493)
      expect(frame.messages).toHaveLength(1)
    })

    it('still resyncs on a genuine clear of a small transcript', () => {
      const broadcaster = new TranscriptTailBroadcaster()
      const base = rows(3)
      broadcaster.observe(chat(base))
      // A real truncation reaches the lane as a shorter, non-empty array, or as
      // the next append against a shorter base.
      expect(broadcaster.observe(chat([base[0]!]))?.kind).toBe('tail-resync')
    })
  })

  it('tracks chats independently', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const a = rows(2, 'a')
    const b = rows(2, 'b')
    broadcaster.observe(chat(a, 'chat-a'))
    broadcaster.observe(chat(b, 'chat-b'))
    const frame = broadcaster.observe(chat([...a, message('only-a')], 'chat-a'))
    expect(frame?.chatId).toBe('chat-a')
    expect(broadcaster.observe(chat([...b], 'chat-b'))).toBeNull()
  })

  it('re-seeds silently after forget, rather than replaying a transcript', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    const base = rows(3)
    broadcaster.observe(chat(base))
    broadcaster.forget('chat-1')
    expect(broadcaster.observe(chat(base))).toBeNull()
    expect(broadcaster.counterSnapshot().seeds).toBe(2)
  })

  it('bounds retained watermarks by evicting the oldest-touched chat', () => {
    let clock = 0
    const broadcaster = new TranscriptTailBroadcaster({
      maxTrackedChats: 2,
      now: () => (clock += 1)
    })
    const a = rows(1, 'a')
    const c = rows(1, 'c')
    broadcaster.observe(chat(a, 'chat-a'))
    broadcaster.observe(chat(rows(1, 'b'), 'chat-b'))
    broadcaster.observe(chat(c, 'chat-c'))
    // chat-a was evicted, so its next sighting re-seeds instead of appending.
    expect(broadcaster.observe(chat([...a, message('a2')], 'chat-a'))).toBeNull()
    // chat-c is still tracked and appends normally.
    expect(broadcaster.observe(chat([...c, message('c2')], 'chat-c'))?.kind).toBe('tail-append')
  })

  it('handles an empty transcript growing its first row', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    broadcaster.observe(chat([]))
    const frame = broadcaster.observe(chat([message('first')]))
    expect(frame?.kind).toBe('tail-append')
    if (frame?.kind !== 'tail-append') throw new Error('expected an append frame')
    expect(frame.baseMessageCount).toBe(0)
    expect(frame.messages.map((row) => row.id)).toEqual(['first'])
  })

  it('rejects a record with no chat id', () => {
    const broadcaster = new TranscriptTailBroadcaster()
    expect(broadcaster.observe({ messages: [] } as unknown as ChatRecord)).toBeNull()
    expect(broadcaster.observe(null)).toBeNull()
  })

  it('stamps appendedAtMs from the injected clock for the visibility histogram', () => {
    const broadcaster = new TranscriptTailBroadcaster({ now: () => 4_242 })
    const base = rows(1)
    broadcaster.observe(chat(base))
    const frame = broadcaster.observe(chat([...base, message('a')]))
    expect(frame?.appendedAtMs).toBe(4_242)
  })
})
