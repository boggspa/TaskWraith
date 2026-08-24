import { describe, expect, it } from 'vitest'

import { createHostProductionHistoryAdapter } from './HostProductionHistoryAdapter'

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
})
