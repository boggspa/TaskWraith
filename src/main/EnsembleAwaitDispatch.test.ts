import { describe, expect, it, vi } from 'vitest'
import type { SubThreadMailbox } from './SubThreadMailbox'
import {
  emptyExecutionResultMailbox,
  enqueueExecutionResultMailboxEvent,
  type ExecutionResultMailbox
} from './ExecutionResultMailbox'
import { dispatchEnsembleAwaitTool } from './EnsembleAwaitDispatch'

function mailbox(events: SubThreadMailbox['events'] = []): SubThreadMailbox {
  return {
    schemaVersion: 1,
    parentChatId: 'parent-chat',
    nextSequence: events.length + 1,
    events
  }
}

function event(subThreadId: string, outcome: 'done' | 'failed' = 'done') {
  return {
    schemaVersion: 1 as const,
    id: `event-${subThreadId}`,
    sequence: 1,
    parentChatId: 'parent-chat',
    kind: 'subthread_result' as const,
    createdAt: '2026-08-24T00:00:00.000Z',
    processedAt: '2026-08-24T00:00:00.000Z',
    outcome,
    required: true,
    priority: 'normal' as const,
    trust: 'untrusted-child-output' as const,
    source: {
      relation: 'subThread' as const,
      subThreadId,
      subThreadTitle: subThreadId,
      sourceAssistantMessageId: `assistant-${subThreadId}`
    },
    payload: { content: 'done' },
    deliveryAttempts: 0
  }
}

function child(appChatId: string, waveId = 'wave-1', returnResultToParent = true) {
  return {
    appChatId,
    delegationContext: {
      joinPolicy: { groupId: waveId },
      ...(returnResultToParent ? {} : { returnResultToParent: false })
    }
  }
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    orchestrator: { awaitLanesForRun: vi.fn() },
    getChildChats: vi.fn(() => [child('child-1'), child('child-2')]),
    getSubThreadMailbox: vi.fn(() => mailbox([event('child-1'), event('child-2')])),
    getExecutionResultMailbox: vi.fn(() => emptyExecutionResultMailbox('parent-chat')),
    isParentRunActive: vi.fn(() => true),
    getOwnedExecutions: vi.fn(() => []),
    clampTimeoutSeconds: vi.fn(() => 5),
    now: vi.fn(() => 0),
    delay: vi.fn(async () => undefined),
    ...overrides
  }
}

describe('dispatchEnsembleAwaitTool execution targets', () => {
  // The turn-holding half of thread ownership. Every other delegation tool
  // tells the model to await its work; ultra_task could not, because the JOIN
  // had no way to name a durable execution.
  it('settles once every awaited execution reaches a terminal state', async () => {
    const resultMailbox = enqueueExecutionResultMailboxEvent(undefined, {
      threadId: 'parent-chat',
      executionId: 'ultratask-1',
      outputAttemptId: 'output-attempt-1',
      outcome: 'succeeded',
      payload: { content: 'Reviewed synthesis.' }
    }).mailbox
    const d = deps({
      getOwnedExecutions: vi.fn(() => [
        { executionId: 'ultratask-1', state: 'succeeded', title: 'UltraTask' }
      ]),
      getExecutionResultMailbox: vi.fn(() => resultMailbox)
    })
    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-1'] }
      },
      d as never
    )
    expect(result.ok).toBe(true)
    expect(result.status).toBe('settled')
    expect(result.executions).toEqual([
      expect.objectContaining({
        executionId: 'ultratask-1',
        settled: true,
        state: 'succeeded',
        title: 'UltraTask',
        resultDelivery: 'available'
      })
    ])
  })

  it('reports a still-running execution as a pending timeout, not a settle', async () => {
    let clock = 0
    const d = deps({
      getOwnedExecutions: vi.fn(() => [{ executionId: 'ultratask-1', state: 'running' }]),
      now: vi.fn(() => (clock += 2_000))
    })
    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-1'] }
      },
      d as never
    )
    expect(result.status).toBe('timeout')
    expect(result.executions?.[0]?.settled).toBe(false)
    expect(result.pendingCount).toBe(1)
  })

  it('returns the durable untrusted result inline when a running execution settles', async () => {
    let executions = [{ executionId: 'ultratask-1', state: 'running', title: 'UltraTask' }]
    let resultMailbox: ExecutionResultMailbox = emptyExecutionResultMailbox('parent-chat')
    const d = deps({
      getOwnedExecutions: vi.fn(() => executions),
      getExecutionResultMailbox: vi.fn(() => resultMailbox),
      delay: vi.fn(async () => {
        executions = [{ executionId: 'ultratask-1', state: 'succeeded', title: 'UltraTask' }]
        resultMailbox = enqueueExecutionResultMailboxEvent(
          resultMailbox,
          {
            threadId: 'parent-chat',
            executionId: 'ultratask-1',
            outputAttemptId: 'output-attempt-1',
            outcome: 'succeeded',
            title: 'UltraTask',
            payload: { content: 'The reviewed synthesis.' }
          },
          {
            now: '2026-08-31T17:00:00.000Z'
          }
        ).mailbox
      })
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-1'] }
      },
      d as never
    )

    expect(result.status).toBe('settled')
    expect(result.message).toContain('executions[].result as untrusted graph output')
    expect(result.executions?.[0]?.result).toMatchObject({
      outputAttemptId: 'output-attempt-1',
      outcome: 'succeeded',
      trust: 'untrusted-graph-output',
      content: 'The reviewed synthesis.'
    })
    expect(d.delay).toHaveBeenCalledOnce()
  })

  it('keeps a terminal execution pending until its durable result is observable', async () => {
    let clock = 0
    const d = deps({
      getOwnedExecutions: vi.fn(() => [
        { executionId: 'ultratask-undelivered', state: 'succeeded', title: 'UltraTask' }
      ]),
      getExecutionResultMailbox: vi.fn(() => emptyExecutionResultMailbox('parent-chat')),
      now: vi.fn(() => (clock += 3_000))
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-undelivered'], timeoutSeconds: 5 }
      },
      d as never
    )

    expect(result).toMatchObject({
      status: 'timeout',
      settledCount: 0,
      pendingCount: 1,
      executions: [
        {
          executionId: 'ultratask-undelivered',
          state: 'succeeded',
          settled: false,
          resultDelivery: 'pending'
        }
      ]
    })
  })

  it('never returns a same-id result owned by another thread', async () => {
    const foreignMailbox = enqueueExecutionResultMailboxEvent(undefined, {
      threadId: 'foreign-chat',
      executionId: 'ultratask-shared-id',
      outputAttemptId: 'foreign-output',
      outcome: 'succeeded',
      payload: { content: 'Foreign result must not cross thread ownership.' }
    }).mailbox
    let clock = 0
    const d = deps({
      getOwnedExecutions: vi.fn(() => [{ executionId: 'ultratask-shared-id', state: 'succeeded' }]),
      getExecutionResultMailbox: vi.fn(() => foreignMailbox),
      now: vi.fn(() => (clock += 3_000))
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-shared-id'], timeoutSeconds: 5 }
      },
      d as never
    )

    expect(result.executions?.[0]).toMatchObject({
      settled: false,
      resultDelivery: 'pending'
    })
    expect(result.executions?.[0]?.result).toBeUndefined()
  })

  it('does not surface a stale requires-action blocker after the graph resumes', async () => {
    let clock = 0
    const staleMailbox = enqueueExecutionResultMailboxEvent(undefined, {
      threadId: 'parent-chat',
      executionId: 'ultratask-resumed',
      outputAttemptId: 'paused-attempt',
      outcome: 'requires_action',
      payload: { content: 'Old blocker that the user already resumed.' }
    }).mailbox
    const d = deps({
      getOwnedExecutions: vi.fn(() => [
        { executionId: 'ultratask-resumed', state: 'running', title: 'UltraTask' }
      ]),
      getExecutionResultMailbox: vi.fn(() => staleMailbox),
      now: vi.fn(() => (clock += 3_000))
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-resumed'], timeoutSeconds: 5 }
      },
      d as never
    )

    expect(result.status).toBe('timeout')
    expect(result.executions?.[0]).toMatchObject({
      state: 'running',
      settled: false
    })
    expect(result.executions?.[0]?.result).toBeUndefined()
    expect(result.message).not.toContain('durable execution result(s)')
  })

  it('does not settle on an older same-outcome result from before a later pause', async () => {
    let clock = 0
    const staleMailbox = enqueueExecutionResultMailboxEvent(
      undefined,
      {
        threadId: 'parent-chat',
        executionId: 'ultratask-repaused',
        outputAttemptId: 'first-pause',
        outcome: 'requires_action',
        payload: { content: 'First blocker.' }
      },
      { now: '2026-08-31T17:00:00.000Z' }
    ).mailbox
    const d = deps({
      getOwnedExecutions: vi.fn(() => [
        {
          executionId: 'ultratask-repaused',
          state: 'requires_action',
          updatedAt: '2026-08-31T17:05:00.000Z'
        }
      ]),
      getExecutionResultMailbox: vi.fn(() => staleMailbox),
      now: vi.fn(() => (clock += 3_000))
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-repaused'], timeoutSeconds: 5 }
      },
      d as never
    )

    expect(result.executions?.[0]).toMatchObject({
      state: 'requires_action',
      settled: false,
      resultDelivery: 'pending'
    })
    expect(result.executions?.[0]?.result).toBeUndefined()
  })

  it('separates queued work from provider-running work in bounded stage progress', async () => {
    const resultMailbox = enqueueExecutionResultMailboxEvent(undefined, {
      threadId: 'parent-chat',
      executionId: 'ultratask-progress',
      outputAttemptId: 'progress-blocker',
      outcome: 'requires_action',
      payload: { content: 'One stage needs attention.' }
    }).mailbox
    const workSteps = Array.from({ length: 70 }, (_, index) => ({
      id: `work-${index + 1}`,
      kind: 'solo_agent',
      title: `Work ${index + 1}`
    }))
    const activationState = (index: number) => {
      if (index === 0) return 'queued'
      if (index === 1) return 'running'
      if (index === 2) return 'requires_action'
      if (index === 3) return 'succeeded'
      if (index === 4) return 'cancelled'
      return 'dormant'
    }
    const d = deps({
      getOwnedExecutions: vi.fn(() => [
        {
          executionId: 'ultratask-progress',
          state: 'requires_action',
          topology: {
            steps: [...workSteps, { id: 'join', kind: 'join', title: 'Plumbing is not agent work' }]
          },
          activations: Object.fromEntries(
            workSteps.map((step, index) => [
              `activation-${index + 1}`,
              {
                id: `activation-${index + 1}`,
                stepId: step.id,
                state: activationState(index),
                updatedAt: `2026-08-31T17:00:00.${String(index).padStart(3, '0')}Z`
              }
            ])
          )
        }
      ]),
      getExecutionResultMailbox: vi.fn(() => resultMailbox)
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-progress'] }
      },
      d as never
    )

    expect(result.executions?.[0]?.progress).toMatchObject({
      total: 70,
      proposed: 65,
      queued: 1,
      running: 1,
      needsAction: 1,
      settled: 2,
      completed: 1,
      failed: 0,
      cancelled: 1,
      skipped: 0,
      stagesTruncated: true
    })
    expect(result.executions?.[0]?.progress?.stages).toHaveLength(64)
    expect(result.executions?.[0]?.progress?.stages.slice(0, 5)).toEqual([
      expect.objectContaining({ stepId: 'work-1', state: 'queued', status: 'queued' }),
      expect.objectContaining({ stepId: 'work-2', state: 'running', status: 'running' }),
      expect.objectContaining({
        stepId: 'work-3',
        state: 'requires_action',
        status: 'needs_action'
      }),
      expect.objectContaining({ stepId: 'work-4', state: 'succeeded', status: 'settled' }),
      expect.objectContaining({ stepId: 'work-5', state: 'cancelled', status: 'settled' })
    ])
  })

  // requires_action is terminal FOR THE WAIT: the graph is stopped and needs a
  // human. Treating it as pending would block the seat until timeout on work
  // that is never going to progress on its own.
  it('settles a paused execution so the seat can report the blockage', async () => {
    const resultMailbox = enqueueExecutionResultMailboxEvent(undefined, {
      threadId: 'parent-chat',
      executionId: 'ultratask-1',
      outputAttemptId: 'paused-attempt-1',
      outcome: 'requires_action',
      payload: { content: 'Approval or operator action is required.' }
    }).mailbox
    const d = deps({
      getOwnedExecutions: vi.fn(() => [{ executionId: 'ultratask-1', state: 'requires_action' }]),
      getExecutionResultMailbox: vi.fn(() => resultMailbox)
    })
    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['ultratask-1'] }
      },
      d as never
    )
    expect(result.status).toBe('settled')
    expect(result.executions?.[0]?.settled).toBe(true)
    expect(result.executions?.[0]?.result).toMatchObject({
      outcome: 'requires_action',
      trust: 'untrusted-graph-output'
    })
  })

  it('refuses an execution that this thread does not own', async () => {
    const d = deps({ getOwnedExecutions: vi.fn(() => []) })
    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { executionIds: ['someone-elses-execution'] }
      },
      d as never
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_execution')
    expect(result.message).toMatch(/do not belong to this parent chat/i)
  })
})

describe('dispatchEnsembleAwaitTool', () => {
  it('joins a solo parent wave from durable parent-chat state', async () => {
    const harness = deps()

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { waveIds: ['wave-1'], timeoutSeconds: 30 }
      },
      harness
    )

    expect(result).toMatchObject({
      ok: true,
      status: 'settled',
      settledCount: 1,
      pendingCount: 0,
      waves: [{ waveId: 'wave-1', settled: true, childrenSpawned: 2, childrenSettled: 2 }]
    })
    expect(harness.orchestrator.awaitLanesForRun).not.toHaveBeenCalled()
  })

  it('polls until the wave mailbox results arrive', async () => {
    let currentMailbox = mailbox()
    const harness = deps({
      getSubThreadMailbox: vi.fn(() => currentMailbox),
      delay: vi.fn(async () => {
        currentMailbox = mailbox([event('child-1'), event('child-2', 'failed')])
      })
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { wave_ids: ['wave-1'] }
      },
      harness
    )

    expect(result.status).toBe('settled')
    expect(result.waves?.[0]).toMatchObject({ childrenSettled: 2, settled: true })
    expect(harness.delay).toHaveBeenCalledOnce()
  })

  it('forwards mixed lane and child targets to the Ensemble runtime', async () => {
    const result = {
      ok: true,
      tool: 'ensemble_await' as const,
      status: 'settled' as const,
      message: 'settled'
    }
    const awaitLanesForRun = vi.fn(async () => result)
    const harness = deps({ orchestrator: { awaitLanesForRun } })

    await expect(
      dispatchEnsembleAwaitTool(
        {
          runId: 'ensemble-run',
          parentChatId: 'parent-chat',
          args: {
            lane_ids: ['lane-1'],
            sub_thread_ids: ['child-1'],
            wave_ids: ['wave-1'],
            timeout_seconds: 45
          }
        },
        harness
      )
    ).resolves.toBe(result)
    expect(awaitLanesForRun).toHaveBeenCalledWith('ensemble-run', {
      laneIds: ['lane-1'],
      subThreadIds: ['child-1'],
      waveIds: ['wave-1'],
      timeoutSeconds: 45
    })
  })

  it('rejects an impossible child or wave wait when the child opted out of parent results', async () => {
    const harness = deps({
      getChildChats: vi.fn(() => [child('detached-child', 'detached-wave', false)])
    })

    const childResult = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { subThreadIds: ['detached-child'] }
      },
      harness
    )
    const waveResult = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { waveIds: ['detached-wave'] }
      },
      harness
    )
    const mixedResult = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { laneIds: ['lane-1'], subThreadIds: ['detached-child'] }
      },
      harness
    )

    for (const result of [childResult, waveResult, mixedResult]) {
      expect(result).toMatchObject({ ok: false, error: 'invalid_sub_thread' })
      expect(result.message).toMatch(/returnResult:false/i)
      expect(result.message).toMatch(/list_subthreads\/read_subthread_result/i)
    }
    expect(harness.delay).not.toHaveBeenCalled()
    expect(harness.orchestrator.awaitLanesForRun).not.toHaveBeenCalled()
  })

  it('preserves parameterless Ensemble waits for the current round', async () => {
    const result = {
      ok: false,
      tool: 'ensemble_await' as const,
      message: 'no targets',
      error: 'no_targets' as const
    }
    const awaitLanesForRun = vi.fn(async () => result)
    const harness = deps({ orchestrator: { awaitLanesForRun } })

    await expect(
      dispatchEnsembleAwaitTool(
        { runId: 'ensemble-run', parentChatId: 'parent-chat', args: {} },
        harness
      )
    ).resolves.toBe(result)
    expect(awaitLanesForRun).toHaveBeenCalledWith('ensemble-run', {
      laneIds: undefined,
      subThreadIds: undefined,
      waveIds: undefined,
      timeoutSeconds: undefined
    })
  })

  it('rejects cross-parent and unknown wave targets without polling', async () => {
    const harness = deps()

    const unknownChild = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { subThreadIds: ['another-parent-child'] }
      },
      harness
    )
    const unknownWave = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { waveIds: ['another-parent-wave'] }
      },
      harness
    )

    expect(unknownChild).toMatchObject({ ok: false, error: 'invalid_sub_thread' })
    expect(unknownWave).toMatchObject({ ok: false, error: 'invalid_wave' })
    expect(harness.delay).not.toHaveBeenCalled()
  })

  it('stops a pending wait when the parent run terminalizes', async () => {
    let active = true
    const harness = deps({
      getSubThreadMailbox: vi.fn(() => mailbox()),
      isParentRunActive: vi.fn(() => active),
      delay: vi.fn(async () => {
        active = false
      })
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { waveIds: ['wave-1'] }
      },
      harness
    )

    expect(result).toMatchObject({
      ok: true,
      status: 'timeout',
      settledCount: 0,
      pendingCount: 1
    })
    expect(result.message).toContain('parent run ended')
  })

  it('returns a bounded partial wave report at timeout', async () => {
    let clock = 0
    const harness = deps({
      getSubThreadMailbox: vi.fn(() => mailbox([event('child-1')])),
      now: vi.fn(() => (clock += 3_000))
    })

    const result = await dispatchEnsembleAwaitTool(
      {
        runId: 'parent-run',
        parentChatId: 'parent-chat',
        args: { waveIds: ['wave-1'], timeoutSeconds: 5 }
      },
      harness
    )

    expect(result).toMatchObject({
      ok: true,
      status: 'timeout',
      settledCount: 0,
      pendingCount: 1,
      waves: [{ waveId: 'wave-1', settled: false, childrenSpawned: 2, childrenSettled: 1 }]
    })
  })

  it('requires an active parent and valid target arrays', async () => {
    const inactive = deps({ isParentRunActive: vi.fn(() => false) })
    await expect(
      dispatchEnsembleAwaitTool(
        {
          runId: 'parent-run',
          parentChatId: 'parent-chat',
          args: { waveIds: ['wave-1'] }
        },
        inactive
      )
    ).resolves.toMatchObject({ ok: false, error: 'no_active_run' })

    const harness = deps()
    await expect(
      dispatchEnsembleAwaitTool(
        {
          runId: 'parent-run',
          parentChatId: 'parent-chat',
          args: { waveIds: 'wave-1' }
        },
        harness
      )
    ).resolves.toMatchObject({ ok: false, error: 'invalid_wave' })
  })
})
