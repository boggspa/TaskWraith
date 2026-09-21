import { describe, expect, it } from 'vitest'

import {
  createHostProductionHistoryAdapter,
  type HostProductionHistoryMessage
} from './HostProductionHistoryAdapter'

function userMessage(
  id: string,
  index = 0
): {
  id: string
  role: 'user'
  content: string
  timestamp: string
} {
  return {
    id,
    role: 'user',
    content: `content ${id}`,
    timestamp: new Date(1_000 + index * 1_000).toISOString()
  }
}

describe('HostProductionHistoryAdapter', () => {
  it('returns bounded redacted history pages with an independent page cursor', () => {
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 7, cursor: 99 }),
      getChat: () => ({
        appChatId: 'thread-1',
        messages: [
          { id: 'm1', role: 'user', content: 'one', timestamp: '2026-08-24T00:00:00.000Z' },
          {
            id: 'm2',
            role: 'tool',
            content: '{"secret":"no"}',
            timestamp: '2026-08-24T00:00:01.000Z'
          },
          { id: 'm3', role: 'assistant', content: 'three', timestamp: '2026-08-24T00:00:02.000Z' },
          { id: 'm4', role: 'error', content: 'four', timestamp: '2026-08-24T00:00:03.000Z' }
        ]
      })
    })

    const newest = adapter.threadHistory({ threadId: 'thread-1', limit: 2 })
    expect(newest).toMatchObject({
      generation: 7,
      cursor: 3,
      entries: [{ entryId: 'm3' }, { entryId: 'm4', role: 'system' }],
      nextBefore: { generation: 7, cursor: 1 }
    })
    expect(JSON.stringify(newest)).not.toContain('secret')

    expect(
      adapter.threadHistory({
        threadId: 'thread-1',
        limit: 2,
        before: { generation: 7, cursor: 1 }
      })
    ).toMatchObject({ entries: [{ entryId: 'm1' }], cursor: 3 })
  })

  it('never fabricates transcript deltas without a canonical live delta journal', () => {
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 2, cursor: 11 }),
      getChat: () => ({ appChatId: 'thread-1', messages: [] })
    })
    expect(
      adapter.historySince({ threadId: 'thread-1', since: { generation: 2, cursor: 0 } })
    ).toEqual({
      kind: 'full_resnapshot_required',
      threadId: 'thread-1',
      generation: 2,
      cursor: 0,
      clientGeneration: 2,
      clientCursor: 0,
      reason: 'retention_gap'
    })
  })

  it('scans only the tail for the newest page on a large history', () => {
    const prefix = Array.from({ length: 5_000 }, (_, index) => userMessage(`p${index}`, index))
    const messages: HostProductionHistoryMessage[] = [
      ...prefix,
      { id: 'tail-tool', role: 'tool', content: 'raw', timestamp: '2026-08-24T00:00:01.000Z' },
      userMessage('tail-user', 5_001),
      userMessage('tail-assist', 5_002)
    ]
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 1, cursor: 0 }),
      getChat: () => ({ appChatId: 'thread-1', messages })
    })

    const page = adapter.threadHistory({ threadId: 'thread-1', limit: 2 })
    expect(page.entries).toEqual([
      expect.objectContaining({ entryId: 'tail-user' }),
      expect.objectContaining({ entryId: 'tail-assist' })
    ])
    expect(page.cursor).toBe(5_002)
    expect(page.nextBefore).toEqual({ generation: 1, cursor: 5_000 })
    expect(JSON.stringify(page)).not.toContain('raw')
  })

  it('excludes a tool row in the middle of the tail window', () => {
    const messages: HostProductionHistoryMessage[] = [
      userMessage('m1'),
      userMessage('m2'),
      userMessage('m3'),
      { id: 'm4', role: 'tool', content: 'payload', timestamp: '2026-08-24T00:00:04.000Z' },
      userMessage('m5')
    ]
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 4, cursor: 2 }),
      getChat: () => ({ appChatId: 'thread-1', messages })
    })

    expect(adapter.threadHistory({ threadId: 'thread-1', limit: 2 })).toMatchObject({
      cursor: 4,
      entries: [{ entryId: 'm3' }, { entryId: 'm5' }],
      nextBefore: { generation: 4, cursor: 2 }
    })
    expect(
      adapter.threadHistory({
        threadId: 'thread-1',
        limit: 2,
        before: { generation: 4, cursor: 2 }
      })
    ).toMatchObject({ entries: [{ entryId: 'm1' }, { entryId: 'm2' }], cursor: 4 })
  })

  it('excludes rows with invalid ids or invalid text without changing errors', () => {
    const messages: HostProductionHistoryMessage[] = [
      { id: '', role: 'user', content: 'blank id', timestamp: '2026-08-24T00:00:00.000Z' },
      { id: 'c1', role: 'user', content: 'ctrl\u0007char', timestamp: '2026-08-24T00:00:01.000Z' },
      { id: ' pad', role: 'user', content: 'padded', timestamp: '2026-08-24T00:00:02.000Z' },
      {
        id: 'long',
        role: 'user',
        content: 'x'.repeat(16_001),
        timestamp: '2026-08-24T00:00:03.000Z'
      }
    ]
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 1, cursor: 0 }),
      getChat: () => ({ appChatId: 'thread-1', messages })
    })

    expect(adapter.threadHistory({ threadId: 'thread-1', limit: 2 })).toMatchObject({
      cursor: 0,
      entries: []
    })
    expect(
      adapter.historySince({ threadId: 'thread-1', since: { generation: 1, cursor: 0 } })
    ).toMatchObject({ kind: 'full_resnapshot_required', cursor: 0, reason: 'retention_gap' })
  })

  it('rejects a page cursor from a different generation', () => {
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 3, cursor: 5 }),
      getChat: () => ({ appChatId: 'thread-1', messages: [userMessage('m1')] })
    })
    expect(() =>
      adapter.threadHistory({
        threadId: 'thread-1',
        limit: 1,
        before: { generation: 2, cursor: 1 }
      })
    ).toThrow('Host history cursor is unavailable')
  })

  it('rejects out-of-range page cursors', () => {
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 3, cursor: 5 }),
      getChat: () => ({ appChatId: 'thread-1', messages: [userMessage('m1')] })
    })
    expect(() =>
      adapter.threadHistory({
        threadId: 'thread-1',
        limit: 1,
        before: { generation: 3, cursor: -1 }
      })
    ).toThrow('Host history cursor is unavailable')
    expect(() =>
      adapter.threadHistory({
        threadId: 'thread-1',
        limit: 1,
        before: { generation: 3, cursor: 2 }
      })
    ).toThrow('Host history cursor is unavailable')
  })

  it('increments the cursor across appends and reuses it in historySince', () => {
    const messages = [userMessage('m1'), userMessage('m2'), userMessage('m3')]
    let generation = 9
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation, cursor: 0 }),
      getChat: () => ({ appChatId: 'thread-1', messages })
    })

    expect(adapter.threadHistory({ threadId: 'thread-1', limit: 2 })).toMatchObject({
      cursor: 3,
      entries: [{ entryId: 'm2' }, { entryId: 'm3' }]
    })

    messages.push(userMessage('m4'))
    generation = 10
    expect(adapter.threadHistory({ threadId: 'thread-1', limit: 2 })).toMatchObject({
      cursor: 4,
      entries: [{ entryId: 'm3' }, { entryId: 'm4' }],
      nextBefore: { generation: 10, cursor: 2 }
    })
    expect(
      adapter.historySince({ threadId: 'thread-1', since: { generation: 10, cursor: 3 } })
    ).toEqual({
      kind: 'full_resnapshot_required',
      threadId: 'thread-1',
      generation: 10,
      cursor: 4,
      clientGeneration: 10,
      clientCursor: 3,
      reason: 'cursor_mismatch'
    })
  })

  it('reports the exact projected total on the first call and after a retention shrink', () => {
    const messages = Array.from({ length: 2_000 }, (_, index) => userMessage(`m${index}`, index))
    const adapter = createHostProductionHistoryAdapter({
      getPosition: () => ({ generation: 2, cursor: 1 }),
      getChat: () => ({ appChatId: 'thread-1', messages })
    })

    expect(adapter.threadHistory({ threadId: 'thread-1', limit: 3 })).toMatchObject({
      cursor: 2_000
    })

    messages.splice(0, 1_000)
    expect(adapter.threadHistory({ threadId: 'thread-1', limit: 3 })).toMatchObject({
      cursor: 1_000
    })
  })
})
