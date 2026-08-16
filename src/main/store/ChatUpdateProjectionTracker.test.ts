import { describe, expect, it } from 'vitest'
import { applyChatUpdateDelivery, buildChatUpdateDelivery } from '../../shared/chatUpdateTransport'
import { deriveChatRecordMutationWithProjection } from './ChatRecordMutation'
import { ChatTranscriptMutationAuthor } from './ChatTranscriptMutationAuthoring'
import { ChatUpdateProjectionTracker } from './ChatUpdateProjectionTracker'
import type { ChatMessage, ChatRecord } from './types'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-08-16T00:00:00.000Z'
  }
}

function chat(messages: ChatMessage[], revision = 1, extras: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-projection',
    title: 'Projection',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision,
    ...extras
  }
}

function advance(source: ChatRecord, mutate: (next: ChatRecord) => void): ChatRecord {
  const next = structuredClone(source)
  mutate(next)
  next.updatedAt += 1
  next.persistenceRevision = (source.persistenceRevision ?? 0) + 1
  return next
}

describe('ChatUpdateProjectionTracker', () => {
  it('advances bytes and rolling metadata from changed operations only', () => {
    const before = chat(
      Array.from({ length: 5_000 }, (_, index) =>
        message(`message-${index}`, `historical-${index}`)
      )
    )
    const after = advance(before, (next) => {
      next.messages[next.messages.length - 1].content += ' streamed-tail'
    })
    const tracker = new ChatUpdateProjectionTracker()
    const seeded = tracker.seed(before)
    const observed = tracker.observe(
      before,
      after,
      deriveChatRecordMutationWithProjection(before, after)
    )

    expect(observed.delta?.transcriptOps).toEqual([
      {
        op: 'update',
        id: 'message-4999',
        message: after.messages[after.messages.length - 1]
      }
    ])
    expect(observed.state.retainedBytes - seeded.retainedBytes).toBe(' streamed-tail'.length)
    expect(observed.state.recordHash).not.toBe(seeded.recordHash)
    expect(observed.state.runsRevision).toBe(seeded.runsRevision)
    expect(observed.state.ensembleRevision).toBe(seeded.ensembleRevision)
  })

  it('produces a patch that reconstructs the exact saved chat', () => {
    const before = chat([message('a', 'A'), message('b', 'B')])
    const after = advance(before, (next) => {
      next.title = 'Updated projection'
      next.messages.splice(0, 1)
      next.messages[0].content = 'B2'
      next.messages.push(message('c', 'C'))
    })
    const tracker = new ChatUpdateProjectionTracker()
    tracker.seed(before)
    const observed = tracker.observe(
      before,
      after,
      deriveChatRecordMutationWithProjection(before, after)
    )
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'projection-patch',
      revision: 2,
      chat: after,
      baseline: { revision: 1, chat: before },
      producerDelta: observed.delta ?? undefined,
      protocolVersion: 2
    })

    expect(delivery.kind).toBe('patch')
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: before })).toMatchObject({
      ok: true,
      baseline: { chat: after }
    })
  })

  it('keeps metadata-only transcript identity and retained bytes stable', () => {
    const messages = [message('a', 'A')]
    const before = chat(messages)
    const after = advance(before, (next) => {
      next.title = 'Metadata only'
    })
    after.messages = messages
    const tracker = new ChatUpdateProjectionTracker()
    const seeded = tracker.seed(before)
    const observed = tracker.observe(
      before,
      after,
      deriveChatRecordMutationWithProjection(before, after)
    )

    expect(observed.delta?.transcriptOps).toEqual([])
    expect(observed.delta?.changedMessageCount).toBe(0)
    expect(observed.state.retainedBytes).toBe(seeded.retainedBytes)
  })

  it('advances an authored whole-message update without a history diff', () => {
    const before = chat([message('a', 'A')])
    const after = advance(before, (next) => {
      next.messages[0].content = 'A much longer update'
    })
    const author = new ChatTranscriptMutationAuthor(before.messages.length)
    author.update(after.messages[0])
    const tracker = new ChatUpdateProjectionTracker()
    const seeded = tracker.seed(before)
    const observed = tracker.observe(
      before,
      after,
      deriveChatRecordMutationWithProjection(before, after, {
        authoredTranscript: author.finish()
      })
    )

    expect(observed.delta?.transcriptOps).toEqual([
      { op: 'update', id: 'a', message: after.messages[0] }
    ])
    expect(observed.state.retainedBytes - seeded.retainedBytes).toBe(
      'A much longer update'.length - 1
    )
  })

  it('falls back to a freshly seeded snapshot state after a discontinuous mutation', () => {
    const before = chat([message('a', 'A')], 3)
    const after = advance(before, (next) => {
      next.messages.push(message('b', 'B'))
    })
    const tracker = new ChatUpdateProjectionTracker()
    tracker.seed(before)
    const derived = deriveChatRecordMutationWithProjection(before, after)
    derived.batch.baseRevision = 99

    const observed = tracker.observe(before, after, derived)

    expect(observed.delta).toBeNull()
    expect(observed.state.persistenceRevision).toBe(after.persistenceRevision)
  })
})
