import { describe, expect, it } from 'vitest'
import type { ExecutionRunProjection } from '../../../main/executionGraph/ExecutionGraphRun'
import {
  executionAppendSubmissionKey,
  executionStackStepTitle,
  mergeExecutionRunProjection,
  shouldAppendBusySendToExecutionStack,
  liveOwnedExecutionThreadIds,
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

  it('never routes ordinary composer busy-sends onto the Execution Stack', () => {
    // Product rule: classic RunQueue + Steer own follow-ups. Stack/Map stay on
    // Work tab / Execution Map projections only.
    const ordinary = {
      busy: true,
      hasWorkspace: true,
      isTopLevel: true,
      isPopout: false,
      isGlobal: false,
      chatKind: 'single'
    }
    expect(shouldAppendBusySendToExecutionStack(ordinary)).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, chatKind: 'ensemble' })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, scheduled: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, existingPrompt: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, directedParticipant: true })).toBe(
      false
    )
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, specialOverride: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, busy: false })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, hasWorkspace: false })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, isGlobal: true })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, isTopLevel: false })).toBe(false)
    expect(shouldAppendBusySendToExecutionStack({ ...ordinary, isPopout: true })).toBe(false)
  })

  it('derives a bounded title without changing the full objective', () => {
    const objective = `${'A'.repeat(120)}\nmore detail`
    expect(executionStackStepTitle(objective)).toHaveLength(96)
    expect(executionStackStepTitle('  \nShip the renderer')).toBe('Ship the renderer')
  })

  it('derives a stable non-plaintext key for an uncertain append receipt', () => {
    const command = JSON.stringify({ chatId: 'chat-one', prompt: 'private task text' })
    expect(executionAppendSubmissionKey(command)).toBe(executionAppendSubmissionKey(command))
    expect(executionAppendSubmissionKey(`${command}!`)).not.toBe(
      executionAppendSubmissionKey(command)
    )
    expect(executionAppendSubmissionKey(command)).not.toContain('private task text')
  })
})

describe('liveOwnedExecutionThreadIds', () => {
  const owned = (
    executionId: string,
    state: ExecutionRunProjection['state'],
    threadId?: string
  ): ExecutionRunProjection => ({
    ...run(executionId, state, 1, '2026-08-29T00:00:00.000Z'),
    ...(threadId ? { owner: { threadId, seatId: 'antigravity:gemini-3.1-pro' } } : {})
  })

  it('reports threads whose graph has not settled', () => {
    const ids = liveOwnedExecutionThreadIds({
      a: owned('a', 'running', 'chat-one'),
      b: owned('b', 'succeeded', 'chat-two')
    })
    expect([...ids]).toEqual(['chat-one'])
  })

  // A paused graph is unfinished work the thread still answers for, so its
  // thread has not completed its task even with no provider run going.
  it('counts a paused graph as live', () => {
    const ids = liveOwnedExecutionThreadIds({
      a: owned('a', 'requires_action', 'chat-one')
    })
    expect(ids.has('chat-one')).toBe(true)
  })

  // A legacy unowned graph is permanently stuck by design. Letting it suppress
  // a thread's close-out forever would be a bug, not caution.
  it('ignores an unowned graph rather than blocking a thread indefinitely', () => {
    const ids = liveOwnedExecutionThreadIds({ a: owned('a', 'requires_action') })
    expect(ids.size).toBe(0)
  })

  it('is keyed on the accountable owner, not mere association', () => {
    const projection = {
      ...owned('a', 'running', 'owner-thread'),
      rootChatId: 'some-other-thread'
    } as ExecutionRunProjection
    const ids = liveOwnedExecutionThreadIds({ a: projection })
    expect([...ids]).toEqual(['owner-thread'])
  })
})
