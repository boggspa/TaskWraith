import { describe, expect, it, vi } from 'vitest'

import { createThreadRecoveryTakeover } from './ThreadOwnershipTakeover'

const activated = { kind: 'activated', drained: 1, receiptFaults: 0 } as const

describe('createThreadRecoveryTakeover', () => {
  it('names one thread and this writer, then asks activation again for that thread only', async () => {
    const maintain = vi.fn(async () => ({ kind: 'taken' }) as never)
    const retry = vi.fn(async () => activated)
    const takeover = createThreadRecoveryTakeover({
      maintain,
      writerId: () => 'writer-1',
      trigger: () => ({ retry })
    })

    await expect(takeover('chat-a')).resolves.toEqual({
      takeover: { kind: 'taken' },
      activation: activated
    })
    expect(maintain).toHaveBeenCalledTimes(1)
    expect(maintain).toHaveBeenCalledWith({
      method: 'takeover-recovery',
      chatId: 'chat-a',
      desktopWriterId: 'writer-1'
    })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('chat-a')
  })

  it('does not ask activation again when the Host refused the takeover', async () => {
    const retry = vi.fn(async () => activated)
    const takeover = createThreadRecoveryTakeover({
      maintain: async () => ({ kind: 'busy', reason: 'live_work' }) as never,
      writerId: () => 'writer-1',
      trigger: () => ({ retry })
    })
    await expect(takeover('chat-a')).resolves.toEqual({
      takeover: { kind: 'busy', reason: 'live_work' },
      activation: null
    })
    expect(retry).not.toHaveBeenCalled()
  })

  it('reports the takeover alone while activation is not composed', async () => {
    const takeover = createThreadRecoveryTakeover({
      maintain: async () => ({ kind: 'none' }) as never,
      writerId: () => 'writer-1',
      trigger: () => null
    })
    await expect(takeover('chat-a')).resolves.toEqual({
      takeover: { kind: 'none' },
      activation: null
    })
  })

  it('propagates a maintenance failure rather than reporting a takeover', async () => {
    const takeover = createThreadRecoveryTakeover({
      maintain: async () => {
        throw new Error('host_unavailable')
      },
      writerId: () => 'writer-1',
      trigger: () => null
    })
    await expect(takeover('chat-a')).rejects.toThrow('host_unavailable')
  })
})
