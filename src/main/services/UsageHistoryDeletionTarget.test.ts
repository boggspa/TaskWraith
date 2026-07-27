import { describe, expect, it, vi } from 'vitest'
import type { HistoryDeletionPreparation } from '../store'
import {
  UsageHistoryDeletionTarget,
  type UsageHistoryDeletionStore
} from './UsageHistoryDeletionTarget'

function preparation(
  overrides: Partial<HistoryDeletionPreparation> = {}
): HistoryDeletionPreparation {
  return {
    operationId: 'deletion-a',
    kind: 'workspace',
    workspaceId: 'workspace-a',
    chatIds: ['chat-b', 'chat-a'],
    runIds: ['run-b', 'run-a'],
    quiescenceTargets: [],
    completedQuiescenceTargetIds: [],
    ...overrides
  }
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('UsageHistoryDeletionTarget', () => {
  it('fsyncs the correlated frozen scope synchronously before strict purge starts', async () => {
    const order: string[] = []
    const strict = deferred()
    const store: UsageHistoryDeletionStore<{ id: string }> = {
      beginHistoryMutation: vi.fn((scope) => {
        order.push('begin')
        expect(scope).toEqual({
          operationId: 'deletion-a',
          kind: 'workspace',
          workspaceId: 'workspace-a',
          chatIds: ['chat-a', 'chat-b'],
          runIds: ['run-a', 'run-b']
        })
        expect(Object.isFrozen(scope)).toBe(true)
        expect(Object.isFrozen(scope.chatIds)).toBe(true)
        expect(Object.isFrozen(scope.runIds)).toBe(true)
        return { id: 'hold-a' }
      }),
      purgeHistoryStrict: vi.fn(() => {
        order.push('purge')
        return strict.promise
      }),
      endHistoryMutation: vi.fn(() => {
        order.push('end')
        return true
      })
    }
    const target = new UsageHistoryDeletionTarget(store)
    const outer = preparation()

    const hold = target.acquire(outer)
    expect(order).toEqual(['begin'])

    const purging = target.purgeStrict(outer, hold).then(() => order.push('receipt'))
    expect(order).toEqual(['begin', 'purge'])
    strict.resolve()
    await purging
    expect(order).toEqual(['begin', 'purge', 'receipt'])

    order.push('outer-commit')
    target.releaseAfterCommit(outer, hold)
    expect(order).toEqual(['begin', 'purge', 'receipt', 'outer-commit', 'end'])
  })

  it('copies the outer inventory so later array mutation cannot widen the held scope', () => {
    const beginHistoryMutation = vi.fn(() => ({ id: 'hold-a' }))
    const target = new UsageHistoryDeletionTarget({
      beginHistoryMutation,
      purgeHistoryStrict: vi.fn(),
      endHistoryMutation: vi.fn(() => true)
    })
    const outer = preparation()

    const hold = target.acquire(outer)
    outer.chatIds.push('chat-c')
    outer.runIds.push('run-c')

    expect(hold.scope.chatIds).toEqual(['chat-a', 'chat-b'])
    expect(hold.scope.runIds).toEqual(['run-a', 'run-b'])
    expect(() => target.releaseAfterCommit(outer, hold)).toThrow(
      'does not match the outer deletion preparation'
    )
  })

  it('rejects a hold from a different outer operation before purging or releasing it', async () => {
    const store = {
      beginHistoryMutation: vi.fn(() => ({ id: 'hold-a' })),
      purgeHistoryStrict: vi.fn(),
      endHistoryMutation: vi.fn(() => true)
    }
    const target = new UsageHistoryDeletionTarget(store)
    const hold = target.acquire(preparation())
    const mismatched = preparation({ operationId: 'deletion-b' })

    await expect(target.purgeStrict(mismatched, hold)).rejects.toThrow(
      'does not match the outer deletion preparation'
    )
    expect(() => target.releaseAfterCommit(mismatched, hold)).toThrow(
      'does not match the outer deletion preparation'
    )
    expect(store.purgeHistoryStrict).not.toHaveBeenCalled()
    expect(store.endHistoryMutation).not.toHaveBeenCalled()
  })

  it('fails loudly when the post-commit hold is no longer active', () => {
    const target = new UsageHistoryDeletionTarget({
      beginHistoryMutation: vi.fn(() => ({ id: 'hold-a' })),
      purgeHistoryStrict: vi.fn(),
      endHistoryMutation: vi.fn(() => false)
    })
    const outer = preparation()
    const hold = target.acquire(outer)

    expect(() => target.releaseAfterCommit(outer, hold)).toThrow(
      'was not active after commit'
    )
  })

  it('can release a fully reconciled timed-out attempt without claiming an outer commit', () => {
    const endHistoryMutation = vi.fn(() => true)
    const target = new UsageHistoryDeletionTarget({
      beginHistoryMutation: vi.fn(() => ({ id: 'hold-a' })),
      purgeHistoryStrict: vi.fn(),
      endHistoryMutation
    })
    const outer = preparation()
    const hold = target.acquire(outer)

    target.releaseAfterCompletion(outer, hold)

    expect(endHistoryMutation).toHaveBeenCalledWith({ id: 'hold-a' })
  })

  it('requires a workspace id before creating a store-side intent', () => {
    const beginHistoryMutation = vi.fn()
    const target = new UsageHistoryDeletionTarget({
      beginHistoryMutation,
      purgeHistoryStrict: vi.fn(),
      endHistoryMutation: vi.fn(() => true)
    })

    expect(() => target.acquire(preparation({ workspaceId: undefined }))).toThrow(
      'requires a workspace id'
    )
    expect(beginHistoryMutation).not.toHaveBeenCalled()
  })

  it.each([
    {
      kind: 'global' as const,
      workspaceId: undefined,
      expectedWorkspaceId: undefined
    },
    {
      kind: 'chat' as const,
      workspaceId: undefined,
      expectedWorkspaceId: undefined
    },
    {
      kind: 'truncate' as const,
      workspaceId: 'workspace-a',
      expectedWorkspaceId: undefined
    }
  ])(
    'passes an exact frozen $kind scope to the usage store',
    ({ kind, workspaceId, expectedWorkspaceId }) => {
      const beginHistoryMutation = vi.fn(() => ({ id: 'hold-a' }))
      const target = new UsageHistoryDeletionTarget({
        beginHistoryMutation,
        purgeHistoryStrict: vi.fn(),
        endHistoryMutation: vi.fn(() => true)
      })

      target.acquire(preparation({ kind, workspaceId }))

      expect(beginHistoryMutation).toHaveBeenCalledWith({
        operationId: 'deletion-a',
        kind,
        ...(expectedWorkspaceId ? { workspaceId: expectedWorkspaceId } : {}),
        chatIds: ['chat-a', 'chat-b'],
        runIds: ['run-a', 'run-b']
      })
    }
  )
})
