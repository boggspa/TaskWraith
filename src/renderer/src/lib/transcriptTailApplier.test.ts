import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import type { TranscriptPage } from '../../../shared/transcriptPage'
import { ChatTranscriptStore } from './chatTranscriptStore'
import {
  buildTranscriptTailAppend,
  buildTranscriptTailResync,
  buildTranscriptTailUpdate
} from '../../../shared/transcriptTailStream'
import { applyTranscriptTailFrame } from './transcriptTailApplier'

function message(id: string, content = `content-${id}`): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-09-11T17:50:00.000Z' } as ChatMessage
}

function rows(count: number, startIndex = 0): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`m-${startIndex + index}`))
}

/** A paged window covering canonical indices [start, start + messages.length). */
function page(messages: ChatMessage[], start: number, total: number): TranscriptPage {
  const end = start + messages.length
  return {
    chatId: 'chat-1',
    messages,
    runs: [],
    totalMessageCount: total,
    windowStart: start,
    windowEnd: end,
    estimatedBytes: 100,
    hasOlder: start > 0,
    hasNewer: end < total,
    oldestMessageId: messages[0]?.id ?? null,
    newestMessageId: messages[messages.length - 1]?.id ?? null,
    updatedAt: 1
  }
}

function append(baseMessageCount: number, messages: ChatMessage[], sequence = 1) {
  const frame = buildTranscriptTailAppend({
    chatId: 'chat-1',
    sequence,
    baseMessageCount,
    messages,
    appendedAtMs: 1_000
  })
  if (!frame) throw new Error('expected a buildable append frame')
  return frame
}

/** A store holding the live tail of a 1,493-row transcript, the 2026-09-11 shape. */
function pagedStoreAtTail(): ChatTranscriptStore {
  const store = new ChatTranscriptStore()
  store.ingestPage(page(rows(100, 1_393), 1_393, 1_493))
  return store
}

describe('applyTranscriptTailFrame', () => {
  it('lands appended rows on the live tail without a fetch', () => {
    const store = pagedStoreAtTail()
    const outcome = applyTranscriptTailFrame(append(1_493, rows(2, 1_493)), store)
    expect(outcome).toMatchObject({ status: 'applied', rows: 2, settled: true })

    const payload = store.get('chat-1')
    expect(payload?.messages.map((row) => row.id).slice(-2)).toEqual(['m-1493', 'm-1494'])
    expect(payload?.windowEnd).toBe(1_495)
    expect(payload?.totalMessageCount).toBe(1_495)
    expect(payload?.hasNewer).toBe(false)
    expect(payload?.hasOlder).toBe(true)
  })

  it('keeps landing consecutive frames, so a whole round arrives row by row', () => {
    const store = pagedStoreAtTail()
    for (let index = 0; index < 13; index += 1) {
      const outcome = applyTranscriptTailFrame(
        append(1_493 + index, [message(`round-${index}`)], index + 1),
        store
      )
      expect(outcome.status).toBe('applied')
    }
    const payload = store.get('chat-1')
    expect(payload?.windowEnd).toBe(1_506)
    expect(payload?.messages.at(-1)?.id).toBe('round-12')
  })

  it('REFUSES a discontiguous frame instead of collapsing the window to it', () => {
    const store = pagedStoreAtTail()
    // Main is at 1,500 but this renderer only ever got to 1,493: six rows were
    // missed. The store's own page path would treat this as a non-adjacent page
    // and REPLACE the window with these two rows.
    const outcome = applyTranscriptTailFrame(append(1_500, rows(2, 1_500)), store)
    expect(outcome).toMatchObject({ status: 'discontiguous', settled: false, rows: 0 })

    const payload = store.get('chat-1')
    expect(payload?.messages).toHaveLength(100)
    expect(payload?.windowEnd).toBe(1_493)
  })

  it('reports a frame the window already holds as a settled duplicate', () => {
    const store = pagedStoreAtTail()
    // The reconcile lane already pulled these rows in.
    const outcome = applyTranscriptTailFrame(append(1_480, rows(2, 1_480)), store)
    expect(outcome).toMatchObject({ status: 'duplicate', settled: true })
    expect(store.get('chat-1')?.messages).toHaveLength(100)
  })

  it('never duplicates a row the reconcile lane delivered first', () => {
    const store = pagedStoreAtTail()
    applyTranscriptTailFrame(append(1_493, [message('m-1493')]), store)
    // The pull lane re-delivers the same row inside its next tail page.
    store.appendChatTranscriptPage('chat-1', page([message('m-1493')], 1_493, 1_494))
    const ids = store.get('chat-1')?.messages.map((row) => row.id) ?? []
    expect(ids.filter((id) => id === 'm-1493')).toHaveLength(1)
  })

  it('declines while the reader has scrolled back off the tail', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(page(rows(100, 200), 200, 1_493))
    expect(store.get('chat-1')?.hasNewer).toBe(true)
    const outcome = applyTranscriptTailFrame(append(1_493, rows(1, 1_493)), store)
    expect(outcome).toMatchObject({ status: 'not-at-tail', settled: false })
    expect(store.get('chat-1')?.windowStart).toBe(200)
  })

  it('declines a chat the store has never seen', () => {
    const outcome = applyTranscriptTailFrame(append(0, [message('a')]), new ChatTranscriptStore())
    expect(outcome).toMatchObject({ status: 'not-paged', settled: false })
  })

  it('declines a fully hydrated chat, whose canonical lane already owns it', () => {
    const store = new ChatTranscriptStore()
    store.ingest({
      appChatId: 'chat-1',
      messages: rows(5),
      runs: [],
      updatedAt: 1
    } as unknown as ChatRecord)
    expect(store.isPaged('chat-1')).toBe(false)
    const outcome = applyTranscriptTailFrame(append(5, [message('m-5')]), store)
    expect(outcome).toMatchObject({ status: 'not-paged', settled: false })
  })

  it('reports a resync frame as requiring the pull lane, and touches nothing', () => {
    const store = pagedStoreAtTail()
    const frame = buildTranscriptTailResync({
      chatId: 'chat-1',
      sequence: 4,
      messageCount: 1_600,
      appendedAtMs: 1
    })
    if (!frame) throw new Error('expected a buildable resync frame')
    const outcome = applyTranscriptTailFrame(frame, store)
    expect(outcome).toMatchObject({ status: 'resync-required', sequence: 4, settled: false })
    expect(store.get('chat-1')?.windowEnd).toBe(1_493)
  })

  it('carries the sequence through every outcome so the watchdog can settle it', () => {
    const store = pagedStoreAtTail()
    expect(applyTranscriptTailFrame(append(1_493, [message('x')], 7), store).sequence).toBe(7)
    expect(applyTranscriptTailFrame(append(9_999, [message('y')], 8), store).sequence).toBe(8)
  })

  it('appends to an empty paged window without inventing older history', () => {
    const store = new ChatTranscriptStore()
    store.ingestPage(page([], 0, 0))
    const outcome = applyTranscriptTailFrame(append(0, [message('first')]), store)
    expect(outcome.status).toBe('applied')
    const payload = store.get('chat-1')
    expect(payload?.messages.map((row) => row.id)).toEqual(['first'])
    expect(payload?.hasOlder).toBe(false)
  })
})

describe('applyTranscriptTailFrame — tail-update', () => {
  function update(
    messageCount: number,
    updateRows: { index: number; message: ChatMessage }[],
    sequence = 1
  ) {
    const frame = buildTranscriptTailUpdate({
      chatId: 'chat-1',
      sequence,
      messageCount,
      rows: updateRows,
      appendedAtMs: 1_000
    })
    if (!frame) throw new Error('fixture built an invalid update frame')
    return frame
  }

  it('writes a changed row into the visible window and settles', () => {
    const store = new ChatTranscriptStore()
    const window = rows(10, 90)
    store.ingestPage(page(window, 90, 100))
    const edited = { ...window[4], content: 'streamed further' } as ChatMessage
    const outcome = applyTranscriptTailFrame(update(100, [{ index: 94, message: edited }]), store)
    expect(outcome).toMatchObject({ status: 'applied', rows: 1, settled: true })
    expect(store.get('chat-1')?.messages[4]).toBe(edited)
    // The window did not move. An edit must never scroll the reader.
    expect(store.get('chat-1')?.windowStart).toBe(90)
    expect(store.get('chat-1')?.windowEnd).toBe(100)
  })

  it('settles a frame whose rows are all outside the window', () => {
    // The reader scrolled back. Nothing this frame describes is theirs to see,
    // so there is nothing outstanding — announcing it and never settling would
    // report a permanent lag on a transcript that is completely up to date.
    const store = new ChatTranscriptStore()
    store.ingestPage(page(rows(10, 90), 90, 100))
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 3, message: message('m-3', 'edited far above') }]),
      store
    )
    expect(outcome).toMatchObject({ status: 'not-visible', rows: 0, settled: true })
  })

  it('treats a row already identical as a duplicate, not a change', () => {
    const store = new ChatTranscriptStore()
    const window = rows(10, 90)
    store.ingestPage(page(window, 90, 100))
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: window[4] }]),
      store
    )
    expect(outcome).toMatchObject({ status: 'duplicate', rows: 0, settled: true })
  })

  it('refuses — and writes nothing — when the row lands on a different id', () => {
    const store = new ChatTranscriptStore()
    const window = rows(10, 90)
    store.ingestPage(page(window, 90, 100))
    const before = store.get('chat-1')
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: message('someone-else', 'wrong row') }]),
      store
    )
    expect(outcome).toMatchObject({ status: 'discontiguous', settled: false })
    expect(store.get('chat-1')).toBe(before)
  })

  it('refuses when the renderer is behind on length — the pull lane owns that', () => {
    const store = new ChatTranscriptStore()
    const window = rows(10, 90)
    store.ingestPage(page(window, 90, 100))
    const outcome = applyTranscriptTailFrame(
      update(140, [{ index: 94, message: { ...window[4], content: 'x' } as ChatMessage }]),
      store
    )
    expect(outcome).toMatchObject({ status: 'discontiguous', settled: false })
  })

  it('declines an update for a chat that is not paged', () => {
    const store = new ChatTranscriptStore()
    store.ingest({
      appChatId: 'chat-1',
      title: 'T',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      messages: rows(3),
      runs: []
    } as unknown as ChatRecord)
    const outcome = applyTranscriptTailFrame(
      update(3, [{ index: 1, message: message('m-1', 'edited') }]),
      store
    )
    expect(outcome).toMatchObject({ status: 'not-paged', settled: false })
  })

  it('applies an update to a window that was itself grown by an append', () => {
    // The two halves of the lane composing: a row arrives on the push lane, and
    // then its text keeps growing on the same lane. Before this, the second
    // half only ever reached the user at the pull lane's cadence.
    const store = new ChatTranscriptStore()
    const window = rows(10, 90)
    store.ingestPage(page(window, 90, 100))
    const arriving = message('m-100', 'partial')
    expect(applyTranscriptTailFrame(append(100, [arriving], 1), store).status).toBe('applied')

    const grown = { ...arriving, content: 'partial and then some' } as ChatMessage
    const outcome = applyTranscriptTailFrame(
      update(101, [{ index: 100, message: grown }], 2),
      store
    )
    expect(outcome).toMatchObject({ status: 'applied', rows: 1, settled: true })
    expect(store.get('chat-1')?.messages.at(-1)).toBe(grown)
    expect(store.get('chat-1')?.windowEnd).toBe(101)
  })
})

describe('applyTranscriptTailFrame — recency guard', () => {
  function update(
    messageCount: number,
    updateRows: { index: number; message: ChatMessage }[],
    sequence: number
  ) {
    const frame = buildTranscriptTailUpdate({
      chatId: 'chat-1',
      sequence,
      messageCount,
      rows: updateRows,
      appendedAtMs: 1_000
    })
    if (!frame) throw new Error('fixture built an invalid update frame')
    return frame
  }

  /** A ten-row window at the live tail of a 100-row transcript. */
  function tailWindowStore(): { store: ChatTranscriptStore; window: ChatMessage[] } {
    const store = new ChatTranscriptStore()
    const window = rows(10, 90)
    store.ingestPage(page(window, 90, 100))
    return { store, window }
  }

  it('REFUSES a frame whose sequence is strictly older than one already shown', () => {
    const { store, window } = tailWindowStore()
    const grown = { ...window[4], content: 'content-m-94 and then streamed further' } as ChatMessage
    expect(
      applyTranscriptTailFrame(update(100, [{ index: 94, message: grown }], 2), store).status
    ).toBe('applied')

    // Even though THIS frame's content would be a legitimate growth, it was
    // sequenced before the one the window already shows.
    const late = { ...window[4], content: 'content-m-94 and then streamed further and more' }
    const outcome = applyTranscriptTailFrame(update(100, [{ index: 94, message: late }], 1), store)
    expect(outcome).toMatchObject({ status: 'stale-sequence', sequence: 1, settled: false })
    expect(store.get('chat-1')?.messages[4]).toBe(grown)
  })

  it('refuses a stale APPEND even when it would abut the window', () => {
    const store = pagedStoreAtTail()
    expect(applyTranscriptTailFrame(append(1_493, rows(2, 1_493), 5), store).status).toBe('applied')
    const outcome = applyTranscriptTailFrame(append(1_495, [message('late')], 3), store)
    expect(outcome).toMatchObject({ status: 'stale-sequence', settled: false })
    expect(store.get('chat-1')?.messages.at(-1)?.id).toBe('m-1494')
  })

  it('admits a redelivered frame at the SAME sequence — only strictly-older is refused', () => {
    const { store, window } = tailWindowStore()
    const grown = { ...window[4], content: 'content-m-94 plus more' } as ChatMessage
    expect(
      applyTranscriptTailFrame(update(100, [{ index: 94, message: grown }], 3), store).status
    ).toBe('applied')
    const again = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: { ...grown } }], 3),
      store
    )
    expect(again.status).not.toBe('stale-sequence')
  })

  it('REFUSES an update that truncates a streamed row to a prefix of itself', () => {
    // The defect: a stale whole-record save re-ships the row as it was
    // mid-stream, and the renderer applied update(long) then update(short),
    // visibly truncating the lane card mid-content.
    const { store, window } = tailWindowStore()
    const streamed = {
      ...window[4],
      content: 'directives. And then a great deal more text'
    } as ChatMessage
    expect(
      applyTranscriptTailFrame(update(100, [{ index: 94, message: streamed }], 1), store).status
    ).toBe('applied')

    const regressed = { ...window[4], content: 'directives.' } as ChatMessage
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: regressed }], 2),
      store
    )
    expect(outcome).toMatchObject({ status: 'stale-content', sequence: 2, settled: false })
    expect(store.get('chat-1')?.messages[4]).toBe(streamed)
  })

  it('keeps the lane live after a refusal: the next FRESH frame applies', () => {
    const { store, window } = tailWindowStore()
    const streamed = {
      ...window[4],
      content: 'directives. And then a great deal more text'
    } as ChatMessage
    applyTranscriptTailFrame(update(100, [{ index: 94, message: streamed }], 1), store)
    expect(
      applyTranscriptTailFrame(
        update(100, [{ index: 94, message: { ...window[4], content: 'directives.' } }], 2),
        store
      ).status
    ).toBe('stale-content')

    // The record recovers and streaming resumes on the same lane.
    const recovered = {
      ...window[4],
      content: 'directives. And then a great deal more text, finished'
    } as ChatMessage
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: recovered }], 3),
      store
    )
    expect(outcome).toMatchObject({ status: 'applied', rows: 1, settled: true })
    expect(store.get('chat-1')?.messages[4]).toBe(recovered)
  })

  it('permits shorter content that is NOT a pure prefix — a genuine replacement', () => {
    const { store, window } = tailWindowStore()
    const long = { ...window[4], content: 'a long answer that spans quite a few words' }
    applyTranscriptTailFrame(update(100, [{ index: 94, message: long }], 1), store)

    const rewritten = { ...window[4], content: 'shorter, different' } as ChatMessage
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: rewritten }], 2),
      store
    )
    expect(outcome).toMatchObject({ status: 'applied', settled: true })
    expect(store.get('chat-1')?.messages[4]).toBe(rewritten)
  })

  it('permits a same-content edit — a tool status flip is not a text regression', () => {
    const { store, window } = tailWindowStore()
    const flipped = {
      ...window[4],
      toolActivities: [{ status: 'completed' }]
    } as unknown as ChatMessage
    const outcome = applyTranscriptTailFrame(
      update(100, [{ index: 94, message: flipped }], 1),
      store
    )
    expect(outcome).toMatchObject({ status: 'applied', settled: true })
    expect(store.get('chat-1')?.messages[4]).toBe(flipped)
  })

  it('resets the watermark on window replace, so a producer restart cannot wedge the lane', () => {
    const { store, window } = tailWindowStore()
    const grown = { ...window[4], content: 'content-m-94 and then some' } as ChatMessage
    expect(
      applyTranscriptTailFrame(update(100, [{ index: 94, message: grown }], 50), store).status
    ).toBe('applied')

    // The pull lane replaces the window (a reconcile, a jump, a re-open).
    store.ingestPage(page(rows(10, 90), 90, 100))
    // A restarted producer re-sequences from 1. Without the reset every one
    // of its frames would read as stale against 50.
    const current = store.get('chat-1')!.messages[4]
    const fresh = { ...current, content: `${current.content} anew` } as ChatMessage
    const outcome = applyTranscriptTailFrame(update(100, [{ index: 94, message: fresh }], 1), store)
    expect(outcome).toMatchObject({ status: 'applied', settled: true })
    expect(store.get('chat-1')?.messages[4]).toBe(fresh)
  })

  it('resets the watermark on a resync frame', () => {
    const store = pagedStoreAtTail()
    expect(applyTranscriptTailFrame(append(1_493, rows(2, 1_493), 40), store).status).toBe(
      'applied'
    )
    const resync = buildTranscriptTailResync({
      chatId: 'chat-1',
      sequence: 41,
      messageCount: 1_495,
      appendedAtMs: 1
    })
    if (!resync) throw new Error('expected a buildable resync frame')
    expect(applyTranscriptTailFrame(resync, store).status).toBe('resync-required')

    // Frames that follow the resync are not judged against the pre-gap epoch.
    const outcome = applyTranscriptTailFrame(append(1_495, [message('after-restart')], 1), store)
    expect(outcome).toMatchObject({ status: 'applied', settled: true })
  })
})
