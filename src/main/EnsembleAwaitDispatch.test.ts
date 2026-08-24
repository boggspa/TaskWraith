import { describe, expect, it, vi } from 'vitest'
import type { SubThreadMailbox } from './SubThreadMailbox'
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
    isParentRunActive: vi.fn(() => true),
    clampTimeoutSeconds: vi.fn(() => 5),
    now: vi.fn(() => 0),
    delay: vi.fn(async () => undefined),
    ...overrides
  }
}

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
