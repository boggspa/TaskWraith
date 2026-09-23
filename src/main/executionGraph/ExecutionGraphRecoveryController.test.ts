import { describe, expect, it, vi } from 'vitest'
import type { ExecutionRunProjection } from './ExecutionGraphRun'
import type { ExecutionGraphServiceDiagnostic } from '../ipc/executionGraphHandlers'
import type { ExecutionGraphRecoveryDiagnostic } from '../services/ExecutionGraphCoordinator'
import {
  EXECUTION_GRAPH_RECOVERY_AUTOMATIC_RETRY_DELAY_MS,
  ExecutionGraphRecoveryController,
  type ExecutionGraphRecoveryCoordinator
} from './ExecutionGraphRecoveryController'

function diagnostic(executionId: string, message = 'refused'): ExecutionGraphRecoveryDiagnostic {
  return { executionId, message }
}

function projection(executionId: string, state: ExecutionRunProjection['state'], owner?: string) {
  return {
    executionId,
    state,
    ...(owner ? { owner: { threadId: owner } } : {})
  } as ExecutionRunProjection
}

function harness(
  options: {
    startup?: readonly ExecutionGraphRecoveryDiagnostic[]
    retried?: readonly ExecutionGraphRecoveryDiagnostic[]
    archived?: ExecutionRunProjection
    executions?: readonly ExecutionRunProjection[]
    coordinatorAvailable?: boolean
  } = {}
) {
  let diagnostics: readonly ExecutionGraphRecoveryDiagnostic[] = []
  let service: readonly ExecutionGraphServiceDiagnostic[] = []
  const executions = options.executions ?? []
  const coordinator = {
    recover: vi.fn(() => options.startup ?? []),
    recoverExecutions: vi.fn(() => options.retried ?? []),
    archiveExecution: vi.fn(async () => options.archived ?? projection('a', 'cancelled')),
    listExecutions: vi.fn(() => executions),
    getExecution: vi.fn((executionId: string) =>
      executions.find((execution) => execution.executionId === executionId)
    )
  } satisfies ExecutionGraphRecoveryCoordinator
  const schedule = vi.fn()
  const log = vi.fn()
  const controller = new ExecutionGraphRecoveryController({
    coordinator: () => (options.coordinatorAvailable === false ? null : coordinator),
    readDiagnostics: () => diagnostics,
    writeDiagnostics: (next) => {
      diagnostics = next
    },
    readServiceDiagnostics: () => service,
    writeServiceDiagnostics: (next) => {
      service = next
    },
    schedule,
    log
  })
  return {
    controller,
    coordinator,
    schedule,
    log,
    read: () => diagnostics,
    service: () => service,
    seedService: (next: readonly ExecutionGraphServiceDiagnostic[]) => {
      service = next
    }
  }
}

const unreadable = { code: 'startup_recovery_failed', message: 'execution registry unreadable' }

describe('ExecutionGraphRecoveryController', () => {
  it('records the launch refusals and arms exactly one automatic retry', () => {
    const h = harness({ startup: [diagnostic('a'), diagnostic('b')], retried: [diagnostic('b')] })

    h.controller.runStartupRecovery()

    expect(h.read()).toEqual([diagnostic('a'), diagnostic('b')])
    expect(h.log).toHaveBeenCalledWith(
      '[ExecutionGraph] startup recovery failed for executionId=a: refused'
    )
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.schedule).toHaveBeenCalledWith(
      expect.any(Function),
      EXECUTION_GRAPH_RECOVERY_AUTOMATIC_RETRY_DELAY_MS
    )

    h.schedule.mock.calls[0][0]()

    expect(h.coordinator.recoverExecutions).toHaveBeenCalledWith(['a', 'b'])
    expect(h.read()).toEqual([diagnostic('b')])

    // A later startup pass never re-arms, and never re-runs the launch pass.
    h.controller.runStartupRecovery()
    expect(h.schedule).toHaveBeenCalledTimes(1)
    expect(h.coordinator.recover).toHaveBeenCalledTimes(1)
  })

  it('arms no automatic retry when nothing was refused', () => {
    const h = harness()
    h.controller.runStartupRecovery()
    expect(h.read()).toEqual([])
    expect(h.schedule).not.toHaveBeenCalled()
  })

  it('covers only the stacks still paused on every pass after the launch pass', () => {
    // A stack the launch pass recovered may be live by the next pass, and
    // recovery re-evaluates a stack as if the process had just restarted.
    const h = harness({
      startup: [diagnostic('b', 'Execution owner metadata is loading')],
      retried: [diagnostic('b', 'Execution owner metadata is still loading')]
    })
    h.controller.runStartupRecovery()

    const next = h.controller.runStartupRecovery()

    expect(h.coordinator.recover).toHaveBeenCalledTimes(1)
    expect(h.coordinator.recoverExecutions).toHaveBeenCalledTimes(1)
    expect(h.coordinator.recoverExecutions).toHaveBeenCalledWith(['b'])
    expect(next).toEqual([diagnostic('b', 'Execution owner metadata is still loading')])
    expect(h.read()).toEqual(next)
  })

  it('touches no ledger on a later pass when the launch pass paused nothing', () => {
    const h = harness()
    h.controller.runStartupRecovery()
    h.controller.runStartupRecovery()
    expect(h.coordinator.recover).toHaveBeenCalledTimes(1)
    expect(h.coordinator.recoverExecutions).not.toHaveBeenCalled()
  })

  it('runs the whole launch pass again after one that failed, keeping the paused set', () => {
    const h = harness({ startup: [diagnostic('a')] })
    h.coordinator.recover.mockImplementationOnce(() => {
      throw new Error('execution registry briefly unreadable')
    })

    // The starter hears the throw and runs the pass again.
    expect(() => h.controller.runStartupRecovery()).toThrow('execution registry briefly unreadable')
    expect(h.read()).toEqual([])

    // Nothing was recovered, so the next pass is the whole launch pass again.
    expect(h.controller.runStartupRecovery()).toEqual([diagnostic('a')])
    expect(h.coordinator.recover).toHaveBeenCalledTimes(2)
    expect(h.coordinator.recoverExecutions).not.toHaveBeenCalled()
  })

  it('preloads every live owner for the launch pass and only the paused owners after it', () => {
    const h = harness({
      executions: [
        projection('a', 'running', 'chat-a'),
        projection('b', 'running', 'chat-b'),
        projection('c', 'running', 'chat-a'),
        projection('d', 'running')
      ],
      startup: [diagnostic('b', 'Execution owner metadata is loading')]
    })

    expect(h.controller.startupOwnerIds()).toEqual(['chat-a', 'chat-b'])
    expect(h.coordinator.listExecutions).toHaveBeenCalledWith({ includeTerminal: false })

    h.controller.runStartupRecovery()

    expect(h.controller.startupOwnerIds()).toEqual(['chat-b'])
    expect(h.coordinator.listExecutions).toHaveBeenCalledTimes(1)
  })

  it('reports a failed startup pass once it survives a re-run, and only once', () => {
    const h = harness()

    // The next pass may absorb it (a listing that failed between the owner
    // preload and recovery), so the first failure is only logged.
    h.controller.startupPassFailed(new Error('execution registry unreadable'), true)
    expect(h.service()).toEqual([])
    expect(h.log).toHaveBeenCalledWith(
      '[ExecutionGraph] startup recovery pass failed and will run again: execution registry unreadable'
    )

    h.controller.startupPassFailed(new Error('execution registry unreadable'), true)
    expect(h.service()).toEqual([unreadable])

    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)
    expect(h.service()).toEqual([unreadable])
    expect(h.log).toHaveBeenCalledTimes(3)
  })

  it('reports a failed startup pass at once when no further pass will run', () => {
    const h = harness()
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)
    expect(h.service()).toEqual([unreadable])
    expect(h.log).toHaveBeenCalledWith(
      '[ExecutionGraph] startup recovery pass failed: execution registry unreadable'
    )
  })

  it('withdraws the report when a later pass succeeds, and only its own report', () => {
    const history: ExecutionGraphServiceDiagnostic = {
      code: 'history_deletion_recovery_required',
      message: 'Pending deletion.'
    }
    const h = harness()
    h.seedService([history])
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)
    expect(h.service()).toEqual([history, unreadable])

    h.controller.runStartupRecovery()

    expect(h.service()).toEqual([history])

    // A success also restarts the count: one new failure is only logged again.
    h.controller.startupPassFailed(new Error('execution registry unreadable'), true)
    expect(h.service()).toEqual([history])
    h.controller.startupPassFailed(new Error('execution registry unreadable'), true)
    expect(h.service()).toEqual([history, unreadable])
  })

  it('keeps the paused set through a later pass that throws, and withdraws on the next', () => {
    const h = harness({ startup: [diagnostic('b')] })
    h.controller.runStartupRecovery()
    h.coordinator.recoverExecutions.mockImplementationOnce(() => {
      throw new Error('execution registry unreadable')
    })

    expect(() => h.controller.runStartupRecovery()).toThrow('execution registry unreadable')
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)
    expect(h.read()).toEqual([diagnostic('b')])
    expect(h.service()).toEqual([unreadable])

    h.controller.runStartupRecovery()

    expect(h.read()).toEqual([])
    expect(h.service()).toEqual([])
  })

  it('withdraws the report when a user retry gets through after the launch pass', () => {
    const h = harness({ startup: [diagnostic('a'), diagnostic('b')] })
    h.controller.runStartupRecovery()
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)
    expect(h.service()).toEqual([unreadable])

    h.controller.retry({ executionId: 'a' })

    expect(h.read()).toEqual([diagnostic('b')])
    expect(h.service()).toEqual([])
  })

  it('keeps the report when a user retry throws', () => {
    const h = harness({ startup: [diagnostic('a')] })
    h.controller.runStartupRecovery()
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)
    h.coordinator.recoverExecutions.mockImplementationOnce(() => {
      throw new Error('execution registry unreadable')
    })

    expect(() => h.controller.retry({ executionId: 'a' })).toThrow('execution registry unreadable')

    expect(h.read()).toEqual([diagnostic('a')])
    expect(h.service()).toEqual([unreadable])
  })

  it('keeps the report when a retry has nothing to cover because the launch pass never ran', () => {
    const h = harness({ startup: [diagnostic('a')] })
    h.coordinator.recover.mockImplementation(() => {
      throw new Error('execution registry unreadable')
    })
    expect(() => h.controller.runStartupRecovery()).toThrow('execution registry unreadable')
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)

    expect(h.controller.retry()).toEqual([])

    expect(h.coordinator.recoverExecutions).not.toHaveBeenCalled()
    expect(h.service()).toEqual([unreadable])
  })

  it('withdraws the report once the last paused stack is archived', async () => {
    const h = harness({ startup: [diagnostic('a'), diagnostic('b')] })
    h.controller.runStartupRecovery()
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)

    await h.controller.archive('a')
    // Stack b still waits for a pass the failure may be stopping.
    expect(h.service()).toEqual([unreadable])

    await h.controller.archive('b')
    expect(h.read()).toEqual([])
    expect(h.service()).toEqual([])
  })

  it('keeps the report after an archive while the launch pass has not run', async () => {
    const h = harness()
    h.coordinator.recover.mockImplementation(() => {
      throw new Error('execution registry unreadable')
    })
    expect(() => h.controller.runStartupRecovery()).toThrow('execution registry unreadable')
    h.controller.startupPassFailed(new Error('execution registry unreadable'), false)

    await h.controller.archive('a')

    expect(h.service()).toEqual([unreadable])
  })

  it('bounds the reported message like every other graph diagnostic', () => {
    const h = harness()
    h.controller.startupPassFailed(new Error('x'.repeat(5_000)), false)
    expect(h.service()[0].message).toBe('x'.repeat(2_048))
  })

  it('reports a thrown value that is not an Error by its own text', () => {
    const h = harness()
    h.controller.startupPassFailed('execution registry unreadable', false)
    expect(h.service()).toEqual([unreadable])
  })

  it('logs an automatic retry that throws instead of crashing the timer', () => {
    const h = harness({ startup: [diagnostic('a')] })
    h.coordinator.recoverExecutions.mockImplementation(() => {
      throw new Error('ledger unavailable')
    })
    h.controller.runStartupRecovery()

    expect(() => h.schedule.mock.calls[0][0]()).not.toThrow()
    expect(h.log).toHaveBeenCalledWith(
      '[ExecutionGraph] automatic recovery retry failed: ledger unavailable'
    )
    expect(h.read()).toEqual([diagnostic('a')])
  })

  it('retries one paused execution and keeps every diagnostic in place', () => {
    const h = harness({
      startup: [diagnostic('a'), diagnostic('b')],
      retried: [diagnostic('a', 'still refused')]
    })
    h.controller.runStartupRecovery()

    const next = h.controller.retry({ executionId: 'a' })

    expect(h.coordinator.recoverExecutions).toHaveBeenCalledWith(['a'])
    // Still paused: same position, fresh message — the visible card must not swap.
    expect(next).toEqual([diagnostic('a', 'still refused'), diagnostic('b')])
    expect(h.read()).toEqual(next)
    expect(h.log).toHaveBeenCalledWith(
      '[ExecutionGraph] recovery retry still paused for executionId=a: still refused'
    )
  })

  it('refuses to re-run recovery for an execution the launch pass never paused', () => {
    const h = harness({ startup: [diagnostic('a')] })
    h.controller.runStartupRecovery()

    expect(() => h.controller.retry({ executionId: 'live' })).toThrow(
      'Execution "live" is not paused in startup recovery.'
    )
    expect(h.coordinator.recoverExecutions).not.toHaveBeenCalled()
  })

  it('retrying with nothing paused touches no ledger', () => {
    const h = harness()
    expect(h.controller.retry()).toEqual([])
    expect(h.coordinator.recoverExecutions).not.toHaveBeenCalled()
  })

  it('archive terminalizes through the coordinator and drops the paused diagnostic', async () => {
    const h = harness({ startup: [diagnostic('a'), diagnostic('b')] })
    h.controller.runStartupRecovery()

    const archived = await h.controller.archive('a', 'Archived from notices.')

    expect(h.coordinator.archiveExecution).toHaveBeenCalledWith('a', 'Archived from notices.')
    expect(archived.state).toBe('cancelled')
    expect(h.read()).toEqual([diagnostic('b')])
  })

  it('archive keeps the diagnostic when the execution did not close', async () => {
    const h = harness({
      startup: [diagnostic('a')],
      archived: projection('a', 'requires_action')
    })
    h.controller.runStartupRecovery()

    await h.controller.archive('a')

    expect(h.read()).toEqual([diagnostic('a')])
  })

  it('answers with a reason while the graph service is unavailable', async () => {
    const h = harness({ coordinatorAvailable: false })
    expect(h.controller.startupOwnerIds()).toEqual([])
    expect(h.controller.runStartupRecovery()).toEqual([])
    // Initialization failure is already on the service list as its own
    // diagnostic; the launch pass falls back to nothing paused, not a failure.
    expect(h.service()).toEqual([])
    expect(h.log).not.toHaveBeenCalled()
    expect(() => h.controller.retry()).toThrow('Durable Stack recovery is unavailable')
    await expect(h.controller.archive('a')).rejects.toThrow('Durable Stack recovery is unavailable')
  })
})
