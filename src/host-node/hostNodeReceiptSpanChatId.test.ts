import { describe, expect, it } from 'vitest'
import { hostNodeReceiptSpanChatId } from './hostNodeReceiptSpanChatId'

describe('hostNodeReceiptSpanChatId', () => {
  const interactions = {
    listPending: () => [
      { id: 'appr-1', kind: 'approval', threadId: 'thread-light' },
      { id: 'q-1', kind: 'question', threadId: 'thread-heavy' }
    ]
  }

  it('resolves approval and question ids to their pending thread', () => {
    expect(
      hostNodeReceiptSpanChatId(interactions, { target: { kind: 'approval', id: 'appr-1' } })
    ).toBe('thread-light')
    expect(
      hostNodeReceiptSpanChatId(interactions, { target: { kind: 'question', id: 'q-1' } })
    ).toBe('thread-heavy')
  })

  it('returns undefined for thread targets, missing ids, and unknown cards', () => {
    expect(
      hostNodeReceiptSpanChatId(interactions, { target: { kind: 'thread', id: 'thread-1' } })
    ).toBeUndefined()
    expect(
      hostNodeReceiptSpanChatId(interactions, { target: { kind: 'approval' } })
    ).toBeUndefined()
    expect(
      hostNodeReceiptSpanChatId(interactions, { target: { kind: 'approval', id: 'appr-missing' } })
    ).toBeUndefined()
  })
})
