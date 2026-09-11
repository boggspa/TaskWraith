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
