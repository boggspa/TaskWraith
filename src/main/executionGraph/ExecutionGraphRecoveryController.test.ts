import { describe, expect, it, vi } from 'vitest'
import type { ExecutionRunProjection } from './ExecutionGraphRun'
import type { ExecutionGraphRecoveryDiagnostic } from '../services/ExecutionGraphCoordinator'
import {
  EXECUTION_GRAPH_RECOVERY_AUTOMATIC_RETRY_DELAY_MS,
  ExecutionGraphRecoveryController,
  type ExecutionGraphRecoveryCoordinator
} from './ExecutionGraphRecoveryController'

function diagnostic(executionId: string, message = 'refused'): ExecutionGraphRecoveryDiagnostic {
  return { executionId, message }
}

function projection(executionId: string, state: ExecutionRunProjection['state']) {
  return { executionId, state } as ExecutionRunProjection
}

function harness(
  options: {
    startup?: readonly ExecutionGraphRecoveryDiagnostic[]
    retried?: readonly ExecutionGraphRecoveryDiagnostic[]
    archived?: ExecutionRunProjection
    coordinatorAvailable?: boolean
  } = {}
) {
  let diagnostics: readonly ExecutionGraphRecoveryDiagnostic[] = []
  const coordinator = {
    recover: vi.fn(() => options.startup ?? []),
    recoverExecutions: vi.fn(() => options.retried ?? []),
    archiveExecution: vi.fn(async () => options.archived ?? projection('a', 'cancelled'))
  } satisfies ExecutionGraphRecoveryCoordinator
  const schedule = vi.fn()
  const log = vi.fn()
  const controller = new ExecutionGraphRecoveryController({
    coordinator: () => (options.coordinatorAvailable === false ? null : coordinator),
    readDiagnostics: () => diagnostics,
    writeDiagnostics: (next) => {
      diagnostics = next
    },
    schedule,
    log
  })
  return { controller, coordinator, schedule, log, read: () => diagnostics }
}

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

    // A deferred replay of the launch pass reports again but never re-arms.
    h.controller.runStartupRecovery()
    expect(h.schedule).toHaveBeenCalledTimes(1)
  })

  it('arms no automatic retry when nothing was refused', () => {
    const h = harness()
    h.controller.runStartupRecovery()
    expect(h.read()).toEqual([])
    expect(h.schedule).not.toHaveBeenCalled()
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

  it('retries one paused execution and keeps the others as reported', () => {
    const h = harness({
      startup: [diagnostic('a'), diagnostic('b')],
      retried: [diagnostic('a', 'still refused')]
    })
    h.controller.runStartupRecovery()

    const next = h.controller.retry({ executionId: 'a' })

    expect(h.coordinator.recoverExecutions).toHaveBeenCalledWith(['a'])
    expect(next).toEqual([diagnostic('b'), diagnostic('a', 'still refused')])
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
    expect(h.controller.runStartupRecovery()).toEqual([])
    expect(() => h.controller.retry()).toThrow('Durable Stack recovery is unavailable')
    await expect(h.controller.archive('a')).rejects.toThrow('Durable Stack recovery is unavailable')
  })
})
