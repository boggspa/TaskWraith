import { describe, expect, it, vi } from 'vitest'
import {
  HistoryDeletionTransactionCoordinator,
  type HistoryDeletionTransactionCoordinatorDeps
} from './HistoryDeletionTransactionCoordinator'
import type { HistoryDeletionPreparation, HistoryDeletionPrepareInput } from './store'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function preparation(
  operationId = 'delete-global',
  completedQuiescenceTargetIds: string[] = []
): HistoryDeletionPreparation {
  return {
    operationId,
    kind: 'global',
    chatIds: ['chat-a'],
    runIds: ['run-a'],
    quiescenceTargets: [{ id: 'canvas:global', kind: 'canvas' }],
    completedQuiescenceTargetIds
  }
}

function deps(
  overrides: Partial<HistoryDeletionTransactionCoordinatorDeps<{ generation: number }>> = {}
): HistoryDeletionTransactionCoordinatorDeps<{ generation: number }> {
  return {
    prepare: vi.fn(() => preparation()),
    acquireHolds: vi.fn(() => ({ generation: 1 })),
    quiesce: vi.fn(async () => undefined),
    commit: vi.fn(),
    releaseHolds: vi.fn(),
    ...overrides
  }
}

describe('HistoryDeletionTransactionCoordinator', () => {
  it('durably prepares before acquiring holds or awaiting external teardown', async () => {
    const order: string[] = []
    const external = deferred()
    const target = deps({
      prepare: vi.fn(() => {
        order.push('prepare')
        return preparation()
      }),
      acquireHolds: vi.fn(() => {
        order.push('holds')
        return { generation: 1 }
      }),
      quiesce: vi.fn(async () => {
        order.push('quiesce')
        await external.promise
      }),
      commit: vi.fn(() => order.push('commit')),
      releaseHolds: vi.fn(() => order.push('release'))
    })
    const coordinator = new HistoryDeletionTransactionCoordinator(target)

    const clearing = coordinator.run({ kind: 'global' })
    expect(order).toEqual(['prepare', 'holds', 'quiesce'])
    external.resolve()
    await clearing
    expect(order).toEqual(['prepare', 'holds', 'quiesce', 'commit', 'release'])
  })

  it('joins the exact operation and rejects another scope before side effects', async () => {
    const external = deferred()
    let pending: HistoryDeletionPreparation | null = null
    const target = deps({
      prepare: vi.fn((input: HistoryDeletionPrepareInput) => {
        if (pending && input.kind !== pending.kind) throw new Error('pending scope')
        pending ??= preparation()
        return pending
      }),
      quiesce: vi.fn(() => external.promise)
    })
    const coordinator = new HistoryDeletionTransactionCoordinator(target)

    const first = coordinator.run({ kind: 'global' })
    const joined = coordinator.run({ kind: 'global' })
    expect(joined).toBe(first)
    expect(() => coordinator.run({ kind: 'workspace', workspaceId: 'workspace-b' })).toThrow(
      'pending scope'
    )
    expect(target.acquireHolds).toHaveBeenCalledOnce()
    external.resolve()
    await first
  })

  it('retains holds after failure and resumes only after durable evidence advances', async () => {
    let attempts = 0
    const refreshHolds = vi.fn((_preparation, holds) => ({
      generation: holds.generation + 1
    }))
    const target = deps({
      refreshHolds,
      quiesce: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('media purge failed')
      })
    })
    const coordinator = new HistoryDeletionTransactionCoordinator(target)

    await expect(coordinator.run({ kind: 'global' })).rejects.toThrow('media purge failed')
    expect(target.releaseHolds).not.toHaveBeenCalled()
    await coordinator.run({ kind: 'global' })
    expect(target.acquireHolds).toHaveBeenCalledOnce()
    expect(refreshHolds).toHaveBeenCalledOnce()
    expect(target.commit).toHaveBeenCalledOnce()
    expect(target.releaseHolds).toHaveBeenCalledOnce()
  })

  it('reacquires every in-memory hold during startup resume despite completed receipts', async () => {
    const target = deps()
    const coordinator = new HistoryDeletionTransactionCoordinator(target)
    const recovered = preparation('delete-recovered', ['canvas:global'])

    await coordinator.resume(recovered)

    expect(target.acquireHolds).toHaveBeenCalledWith(recovered)
    expect(target.quiesce).toHaveBeenCalledWith(recovered, { generation: 1 })
    expect(target.commit).toHaveBeenCalledWith('delete-recovered')
  })
})
