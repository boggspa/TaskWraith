import { describe, expect, it } from 'vitest'
import type { ExecutionRunProjection } from '../../../main/executionGraph/ExecutionGraphRun'
import {
  executionStackStepTitle,
  mergeExecutionRunProjection,
  shouldAppendBusySendToExecutionStack,
  sortExecutionRunHistory
} from './executionGraphLiveState'

function run(
  executionId: string,
  state: ExecutionRunProjection['state'],
  lastSequence: number,
  updatedAt: string
): ExecutionRunProjection {
  return {
    executionId,
    state,
    topology: { steps: [], edges: [] },
    topologyDigest: `digest-${executionId}`,
    activations: {},
    attempts: {},
    eventCount: lastSequence,
    lastSequence,
    integrity: 'valid',
    baseRevisionMissing: false,
    diagnostics: [],
    updatedAt
  }
}

describe('executionGraphLiveState', () => {
  it('keeps active runs ahead of terminal history while retaining every run', () => {
    const ordered = sortExecutionRunHistory([
      run('finished-newer', 'succeeded', 8, '2026-07-18T12:00:00.000Z'),
      run('active', 'running', 4, '2026-07-18T11:00:00.000Z'),
      run('finished-older', 'failed', 7, '2026-07-18T10:00:00.000Z')
    ])

    expect(ordered.map((item) => item.executionId)).toEqual([
      'active',
      'finished-newer',
      'finished-older'
    ])
  })

  it('does not let a stale response replace a newer pushed projection', () => {
    const current = run('graph', 'running', 9, '2026-07-18T12:00:00.000Z')
    const stale = run('graph', 'pending', 3, '2026-07-18T11:00:00.000Z')
    expect(mergeExecutionRunProjection(current, stale)).toBe(current)
  })

  it('admits only interactive busy solo workspace sends', () => {
    const ordinary = {
      busy: true,
      hasWorkspace: true,
      isTopLevel: true,
      isPopout: false,
      isGlobal: false,
      chatKind: 'single'
    }
    expect(shouldAppendBusySendToExecutionStack(ordinary)).toBe(true)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, chatKind: 'ensemble' })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, scheduled: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, existingPrompt: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, specialOverride: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, isTopLevel: false })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, isPopout: true })).toBe(false)
  })

  it('derives a bounded title without changing the full objective', () => {
    const objective = `${'A'.repeat(120)}\nmore detail`
    expect(executionStackStepTitle(objective)).toHaveLength(96)
    expect(executionStackStepTitle('  \nShip the renderer')).toBe('Ship the renderer')
  })
})
