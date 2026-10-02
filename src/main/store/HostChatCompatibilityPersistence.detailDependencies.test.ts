import { describe, expect, it, vi } from 'vitest'
import { HostChatCompatibilityPersistence } from './HostChatCompatibilityPersistence'
import type { ChatRecord } from './types'

describe('Host compatibility detail debts', () => {
  it('retains predecessor and newer pending debts after failed publication', async () => {
    let reject!: (error: Error) => void
    const firstPending = new Promise<void>((_resolve, fail) => {
      reject = fail
    })
    const first = vi.fn().mockReturnValueOnce(firstPending).mockResolvedValue(undefined)
    const second = vi.fn(async () => {})
    const enqueue = vi.fn()
    const coordinator = new HostChatCompatibilityPersistence({
      enqueue,
      drain: async () => {},
      drainAll: async () => {}
    })
    coordinator.stage(
      {
        chatId: 'chat',
        record: { appChatId: 'chat', persistenceRevision: 1 } as ChatRecord,
        expectedRevision: 0
      },
      {
        detailDependencies: { awaitDurable: first }
      }
    )
    coordinator.materialize('chat')
    const barrier = coordinator.barrier('chat')
    coordinator.stage(
      {
        chatId: 'chat',
        record: { appChatId: 'chat', persistenceRevision: 2 } as ChatRecord,
        expectedRevision: 1
      },
      {
        detailDependencies: { awaitDurable: second }
      }
    )
    reject(new Error('first publication failed'))
    await expect(barrier).rejects.toThrow('publication failed')
    expect(enqueue).not.toHaveBeenCalled()
    await coordinator.barrier('chat')
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0][0].record.persistenceRevision).toBe(2)
  })

  it('waits before enqueue and keeps process-local tokens out of persisted input', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const enqueue = vi.fn()
    const coordinator = new HostChatCompatibilityPersistence({
      enqueue,
      drain: async () => {},
      drainAll: async () => {}
    })
    const record = { appChatId: 'chat', persistenceRevision: 1 } as ChatRecord
    coordinator.stage(
      { chatId: 'chat', record, expectedRevision: 0 },
      {
        durabilityFallback: true,
        detailDependencies: { awaitDurable: () => pending }
      }
    )
    coordinator.materialize('chat')
    expect(enqueue).not.toHaveBeenCalled()
    release()
    await coordinator.barrier('chat')
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue.mock.calls[0][0]).toEqual({ chatId: 'chat', record, expectedRevision: 0 })
  })

  it('does not enqueue on synchronous debt failure and retains a retryable lineage', async () => {
    const enqueue = vi.fn()
    const debt = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('debt failed')
      })
      .mockResolvedValueOnce(undefined)
    const coordinator = new HostChatCompatibilityPersistence({
      enqueue,
      drain: async () => {},
      drainAll: async () => {}
    })
    coordinator.stage(
      {
        chatId: 'chat',
        record: { appChatId: 'chat', persistenceRevision: 1 } as ChatRecord,
        expectedRevision: 0
      },
      {
        detailDependencies: { awaitDurable: debt }
      }
    )
    await expect(coordinator.barrier('chat')).rejects.toThrow('debt failed')
    expect(enqueue).not.toHaveBeenCalled()
    await coordinator.barrier('chat')
    expect(enqueue).toHaveBeenCalledOnce()
  })
})
