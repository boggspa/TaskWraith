import { describe, expect, it } from 'vitest'
import { applyChatTranscriptOps } from '../../shared/chatUpdateTransport'
import {
  applyChatRecordMutation,
  deriveChatRecordMutationWithProjection
} from './ChatRecordMutation'
import { ChatTranscriptMutationAuthor } from './ChatTranscriptMutationAuthoring'
import type { ChatMessage, ChatRecord } from './types'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-08-16T00:00:00.000Z'
  }
}

function chat(messages: ChatMessage[], revision: number): ChatRecord {
  return {
    appChatId: 'authored-chat',
    title: 'Authored transcript',
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    messages,
    runs: [],
    persistenceRevision: revision
  }
}

describe('ChatTranscriptMutationAuthor', () => {
  it('replays exact update/delete/append operations through journal and renderer paths', () => {
    const before = chat([message('a', 'A'), message('b', 'B')], 1)
    const updatedA = message('a', 'A2')
    const appendedC = message('c', 'C')
    const after = chat([updatedA, appendedC], 2)
    const author = new ChatTranscriptMutationAuthor(before.messages.length)
    author.update(updatedA)
    author.delete(1, 'b')
    author.append([appendedC])
    const authoredTranscript = author.finish()
    const derived = deriveChatRecordMutationWithProjection(before, after, {
      authoredTranscript,
      savedAt: '2026-08-16T00:00:01.000Z'
    })

    expect(derived.transcriptOps).toEqual([
      { op: 'update', id: 'a', message: updatedA },
      { op: 'delete', id: 'b' },
      { op: 'append', messages: [appendedC] }
    ])
    expect(derived.batch.operations.map((operation) => operation.type)).toEqual([
      'record_patch',
      'message_put',
      'messages_splice',
      'messages_splice'
    ])
    expect(applyChatRecordMutation(before, derived.batch)).toEqual(after)
    expect(applyChatTranscriptOps(before.messages, derived.transcriptOps!)).toEqual(after.messages)
  })

  it('marks a middle insertion for snapshot recovery while keeping journal replay exact', () => {
    const before = chat([message('a', 'A'), message('c', 'C')], 1)
    const inserted = message('b', 'B')
    const after = chat([before.messages[0], inserted, before.messages[1]], 2)
    const author = new ChatTranscriptMutationAuthor(2)
    author.splice(1, 0, [], [inserted])
    const derived = deriveChatRecordMutationWithProjection(before, after, {
      authoredTranscript: author.finish()
    })

    expect(derived.transcriptOps).toBeNull()
    expect(applyChatRecordMutation(before, derived.batch)).toEqual(after)
  })

  it('derives an authored append without reading historical message elements', () => {
    const historical = Array.from({ length: 28_000 }, (_, index) =>
      message(`message-${index}`, `history-${index}`)
    )
    const appended = message('message-28000', 'new tail')
    const author = new ChatTranscriptMutationAuthor(historical.length)
    author.append([appended])
    const guard = (messages: ChatMessage[]): ChatMessage[] =>
      new Proxy(messages, {
        get(target, property, receiver) {
          if (
            property === Symbol.iterator ||
            (typeof property === 'string' && /^\d+$/.test(property))
          ) {
            throw new Error('authored derivation read historical messages')
          }
          return Reflect.get(target, property, receiver)
        }
      })
    const before = chat(guard(historical), 1)
    const after = chat(guard([...historical, appended]), 2)

    const derived = deriveChatRecordMutationWithProjection(before, after, {
      authoredTranscript: author.finish()
    })

    expect(derived.transcriptOps).toEqual([{ op: 'append', messages: [appended] }])
    expect(derived.changedMessageCount).toBe(1)
  })
})
