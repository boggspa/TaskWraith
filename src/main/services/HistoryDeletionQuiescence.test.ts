import { describe, expect, it, vi } from 'vitest'
import type { HistoryDeletionPreparation, HistoryDeletionQuiescenceTarget } from '../store'
import {
  HistoryDeletionQuiescenceError,
  requireReacquiredHistoryDeletionHolds,
  type HistoryDeletionQuiescenceHandlers,
  quiescePreparedHistoryDeletion
} from './HistoryDeletionQuiescence'

function preparation(
  targets: HistoryDeletionQuiescenceTarget[],
  completedQuiescenceTargetIds: string[] = []
): HistoryDeletionPreparation {
  return {
    operationId: 'delete-1',
    kind: 'global',
    chatIds: ['chat-a'],
    runIds: ['run-a', 'run-b'],
    quiescenceTargets: targets,
    completedQuiescenceTargetIds
  }
}

function handlers(
  onHandle: (target: HistoryDeletionQuiescenceTarget) => void = () => {}
): HistoryDeletionQuiescenceHandlers {
  const complete = vi.fn(async (target: HistoryDeletionQuiescenceTarget): Promise<void> => {
    onHandle(target)
  })
  return {
    maintenanceCompaction: complete,
    providerRun: async (target) => {
      onHandle(target)
      return true
    },
    canvas: complete,
    executionGraph: complete,
    usage: complete,
    projectReference: complete,
    media: complete,
    bridge: complete,
    record: vi.fn()
  }
}

describe('quiescePreparedHistoryDeletion', () => {
  it('reopens receipt projection for process-local holds reacquired after restart', () => {
    const recovered = preparation(
      [
        { id: 'maintenance-compaction:global', kind: 'maintenance-compaction' },
        { id: 'provider-run:run-a', kind: 'provider-run', runId: 'run-a', provider: 'codex' },
        { id: 'canvas:global', kind: 'canvas' },
        { id: 'usage:global', kind: 'usage' },
        { id: 'project-reference:global', kind: 'project-reference' },
        { id: 'media:global', kind: 'media' },
        { id: 'bridge:global', kind: 'bridge' }
      ],
      [
        'maintenance-compaction:global',
        'provider-run:run-a',
        'canvas:global',
        'usage:global',
        'project-reference:global',
        'media:global',
        'bridge:global'
      ]
    )

    expect(requireReacquiredHistoryDeletionHolds(recovered)).toMatchObject({
      completedQuiescenceTargetIds: ['provider-run:run-a']
    })
  })

  it('runs targets in deterministic safety order and records each strict completion', async () => {
    const calls: string[] = []
    const targetHandlers = handlers((target) => calls.push(`handle:${target.id}`))
    targetHandlers.record = vi.fn(async (_operationId, targetIds) => {
      calls.push(`record:${targetIds[0]}`)
    })

    const recorded = await quiescePreparedHistoryDeletion(
      preparation([
        { id: 'bridge:global', kind: 'bridge' },
        { id: 'media:global', kind: 'media' },
        { id: 'project-reference:global', kind: 'project-reference' },
        { id: 'maintenance-compaction:global', kind: 'maintenance-compaction' },
        { id: 'provider-run:run-b', kind: 'provider-run', runId: 'run-b', provider: 'kimi' },
        { id: 'execution-graph:global', kind: 'execution-graph' },
        { id: 'usage:global', kind: 'usage' },
        { id: 'canvas:global', kind: 'canvas' },
        { id: 'provider-run:run-a', kind: 'provider-run', runId: 'run-a', provider: 'codex' }
      ]),
      targetHandlers
    )

    expect(recorded).toEqual([
      'provider-run:run-a',
      'provider-run:run-b',
      'maintenance-compaction:global',
      'canvas:global',
      'execution-graph:global',
      'usage:global',
      'project-reference:global',
      'media:global',
      'bridge:global'
    ])
    expect(calls).toEqual(recorded.flatMap((id) => [`handle:${id}`, `record:${id}`]))
    expect(targetHandlers.record).toHaveBeenCalledTimes(9)
    expect(targetHandlers.record).toHaveBeenNthCalledWith(1, 'delete-1', ['provider-run:run-a'])
  })

  it('resumes from durable receipts without invoking completed targets again', async () => {
    const handled: string[] = []
    const targetHandlers = handlers((target) => handled.push(target.id))

    const recorded = await quiescePreparedHistoryDeletion(
      preparation(
        [
          { id: 'canvas:global', kind: 'canvas' },
          { id: 'media:global', kind: 'media' },
          { id: 'bridge:global', kind: 'bridge' }
        ],
        ['canvas:global', 'media:global']
      ),
      targetHandlers
    )

    expect(handled).toEqual(['bridge:global'])
    expect(recorded).toEqual(['bridge:global'])
    expect(targetHandlers.record).toHaveBeenCalledOnce()
    expect(targetHandlers.record).toHaveBeenCalledWith('delete-1', ['bridge:global'])
  })

  it('fails closed when provider termination is not affirmatively confirmed', async () => {
    const targetHandlers = handlers()
    targetHandlers.providerRun = vi.fn(async () => false)

    await expect(
      quiescePreparedHistoryDeletion(
        preparation([
          { id: 'provider-run:run-a', kind: 'provider-run', runId: 'run-a', provider: 'codex' },
          { id: 'canvas:global', kind: 'canvas' }
        ]),
        targetHandlers
      )
    ).rejects.toMatchObject({
      name: 'HistoryDeletionQuiescenceError',
      targetId: 'provider-run:run-a',
      targetKind: 'provider-run'
    })
    expect(targetHandlers.canvas).not.toHaveBeenCalled()
    expect(targetHandlers.record).not.toHaveBeenCalled()
  })

  it('records no receipt and stops after any strict handler fails or returns false', async () => {
    const targetHandlers = handlers()
    targetHandlers.canvas = vi.fn(async () => true)
    targetHandlers.executionGraph = vi.fn(async () => false)

    let error: unknown
    try {
      await quiescePreparedHistoryDeletion(
        preparation([
          { id: 'media:global', kind: 'media' },
          { id: 'execution-graph:global', kind: 'execution-graph' },
          { id: 'canvas:global', kind: 'canvas' }
        ]),
        targetHandlers
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(HistoryDeletionQuiescenceError)
    expect(error).toMatchObject({ targetId: 'execution-graph:global' })
    expect(targetHandlers.record).toHaveBeenCalledTimes(1)
    expect(targetHandlers.record).toHaveBeenCalledWith('delete-1', ['canvas:global'])
    expect(targetHandlers.media).not.toHaveBeenCalled()
  })

  it('does not receipt usage or start media until the exact strict usage purge settles', async () => {
    let settleUsage!: () => void
    const usage = new Promise<void>((resolve) => {
      settleUsage = resolve
    })
    const targetHandlers = handlers()
    targetHandlers.usage = vi.fn(() => usage)

    const deleting = quiescePreparedHistoryDeletion(
      preparation([
        { id: 'media:global', kind: 'media' },
        { id: 'usage:global', kind: 'usage' }
      ]),
      targetHandlers
    )

    await Promise.resolve()
    expect(targetHandlers.record).not.toHaveBeenCalledWith('delete-1', ['usage:global'])
    expect(targetHandlers.media).not.toHaveBeenCalled()

    settleUsage()
    await deleting
    expect(targetHandlers.record).toHaveBeenNthCalledWith(1, 'delete-1', ['usage:global'])
    expect(targetHandlers.media).toHaveBeenCalledOnce()
  })

  it('wraps a strict handler error and does not run or receipt later targets', async () => {
    const targetHandlers = handlers()
    targetHandlers.canvas = vi.fn(async () => {
      throw new Error('canvas still active')
    })

    await expect(
      quiescePreparedHistoryDeletion(
        preparation([
          { id: 'canvas:global', kind: 'canvas' },
          { id: 'execution-graph:global', kind: 'execution-graph' }
        ]),
        targetHandlers
      )
    ).rejects.toMatchObject({
      name: 'HistoryDeletionQuiescenceError',
      targetId: 'canvas:global',
      causeValue: expect.objectContaining({ message: 'canvas still active' })
    })
    expect(targetHandlers.executionGraph).not.toHaveBeenCalled()
    expect(targetHandlers.record).not.toHaveBeenCalled()
  })

  it('does not claim completion when writing the durable receipt fails', async () => {
    const targetHandlers = handlers()
    targetHandlers.record = vi.fn(async () => {
      throw new Error('disk unavailable')
    })

    await expect(
      quiescePreparedHistoryDeletion(
        preparation([{ id: 'canvas:global', kind: 'canvas' }]),
        targetHandlers
      )
    ).rejects.toMatchObject({
      name: 'HistoryDeletionQuiescenceError',
      targetId: 'canvas:global',
      causeValue: expect.objectContaining({ message: 'disk unavailable' })
    })
    expect(targetHandlers.record).toHaveBeenCalledOnce()
  })
})
