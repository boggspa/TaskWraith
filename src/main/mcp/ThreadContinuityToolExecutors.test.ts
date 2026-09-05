import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import { createThreadContinuityToolExecutors } from './ThreadContinuityToolExecutors'

function fixture() {
  let chat = {
    appChatId: 'chat',
    archived: false,
    messages: [
      { id: 'm', role: 'user', content: 'Keep this correction.', timestamp: '2026-09-05T12:00:00Z' }
    ],
    runs: []
  } as unknown as ChatRecord
  let active = true
  const executor = createThreadContinuityToolExecutors({
    resolveCaller: () =>
      active ? { chatId: 'chat', runId: 'r', seatId: '__solo__', provider: 'codex' } : null,
    getChat: (id) => (id === 'chat' ? chat : null),
    readDetail: async () => null,
    saveCheckpoint: (value) => {
      chat = value
    },
    now: () => '2026-09-05T12:00:01Z'
  })
  return {
    executor,
    getChat: () => chat,
    isolate: () => {
      active = false
    }
  }
}

describe('task-local continuity tools', () => {
  it('reads the caller’s own message and rejects a supplied foreign task', async () => {
    const { executor } = fixture()
    const read = await executor.execute('tw_history_read', { messageId: 'm' }, {}, 'codex')
    expect(JSON.parse(read.text)).toMatchObject({ available: true, text: 'Keep this correction.' })
    const foreign = await executor.execute(
      'tw_history_read',
      { messageId: 'm', chatId: 'foreign' },
      {},
      'codex'
    )
    expect(foreign.isError).toBe(true)
  })
  it('refuses context-isolated callers before exposing any transcript or checkpoint', async () => {
    const { executor, isolate } = fixture()
    isolate()
    for (const tool of ['tw_history_search', 'tw_history_read', 'tw_checkpoint'] as const) {
      expect((await executor.execute(tool, {}, {}, 'codex')).isError).toBe(true)
    }
  })
  it('binds checkpoint ownership to the host and preserves clear/recreate revisions', async () => {
    const { executor, getChat } = fixture()
    const write = await executor.execute(
      'tw_checkpoint',
      {
        op: 'write',
        text: 'Next: test the fix.',
        expectedRevision: 0,
        references: [{ messageId: 'm' }]
      },
      {},
      'codex'
    )
    expect(JSON.parse(write.text)).toMatchObject({ saved: true, revision: 1 })
    expect(getChat().continuityCheckpoints?.__solo__.author).toMatchObject({
      provider: 'codex',
      runId: 'r'
    })
    const forged = await executor.execute(
      'tw_checkpoint',
      { op: 'write', text: 'foreign', expectedRevision: 1, seatId: 'someone-else' },
      {},
      'codex'
    )
    expect(forged.isError).toBe(true)
    const cleared = await executor.execute(
      'tw_checkpoint',
      { op: 'clear', expectedRevision: 1 },
      {},
      'codex'
    )
    expect(JSON.parse(cleared.text)).toMatchObject({ revision: 2, active: false })
    expect(
      (
        await executor.execute(
          'tw_checkpoint',
          { op: 'write', text: 'stale', expectedRevision: 1 },
          {},
          'codex'
        )
      ).isError
    ).toBe(true)
  })
  it('rejects oversized inputs and invalid byte offsets before a read', async () => {
    const { executor } = fixture()
    expect(
      (
        await executor.execute(
          'tw_checkpoint',
          { op: 'write', text: 'x'.repeat(1601), expectedRevision: 0 },
          {},
          'codex'
        )
      ).isError
    ).toBe(true)
    expect(
      (await executor.execute('tw_history_read', { messageId: 'm', offset: -1 }, {}, 'codex'))
        .isError
    ).toBe(true)
    expect(
      (await executor.execute('tw_history_search', { query: 'x'.repeat(201) }, {}, 'codex')).isError
    ).toBe(true)
  })
})
