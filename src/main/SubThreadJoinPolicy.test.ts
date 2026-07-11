import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBTHREAD_JOIN_DEADLINE_MS,
  bindSubThreadJoinPolicyToRun,
  evaluateSubThreadJoin,
  resolveSubThreadJoinPolicy
} from './SubThreadJoinPolicy'

const nowMs = Date.parse('2026-07-11T12:00:00.000Z')

function worker(
  id: string,
  options: {
    required?: boolean
    quorum?: number
    debounceMs?: number
    deadlineMs?: number
    terminalAt?: string
    outcome?: 'done' | 'requires_action' | 'failed' | 'cancelled'
  } = {}
) {
  const policy = bindSubThreadJoinPolicyToRun(
    resolveSubThreadJoinPolicy(
      {
        required: options.required,
        quorum: options.quorum,
        debounceMs: options.debounceMs,
        deadlineMs: options.deadlineMs
      },
      { groupId: 'parent-run-1', nowMs }
    ),
    `worker-run-${id}`
  )
  return {
    subThreadId: `child-${id}`,
    workerRunId: `worker-run-${id}`,
    policy,
    ...(options.terminalAt
      ? {
          terminal: {
            at: options.terminalAt,
            outcome: options.outcome || ('done' as const)
          }
        }
      : {})
  }
}

describe('SubThreadJoinPolicy', () => {
  it('normalizes bounded defaults and binds the worker run identity', () => {
    const policy = bindSubThreadJoinPolicyToRun(
      resolveSubThreadJoinPolicy(undefined, { groupId: 'parent-run-1', nowMs }),
      'worker-run-1'
    )

    expect(policy).toMatchObject({
      schemaVersion: 1,
      groupId: 'parent-run-1',
      required: true,
      workerRunId: 'worker-run-1'
    })
    expect(Date.parse(policy.deadlineAt) - nowMs).toBe(DEFAULT_SUBTHREAD_JOIN_DEADLINE_MS)
  })

  it('waits for all required workers by default', () => {
    const evaluation = evaluateSubThreadJoin(
      [worker('1', { terminalAt: '2026-07-11T12:00:01.000Z' }), worker('2')],
      { nowMs: nowMs + 2_000 }
    )

    expect(evaluation).toMatchObject({
      status: 'waiting',
      requiredWorkers: 2,
      terminalRequiredWorkers: 1,
      quorum: 2,
      missingRequiredSubThreadIds: ['child-2']
    })
  })

  it('releases at quorum and counts failed or cancelled workers as terminal evidence', () => {
    const evaluation = evaluateSubThreadJoin(
      [
        worker('1', {
          quorum: 2,
          debounceMs: 0,
          terminalAt: '2026-07-11T12:00:01.000Z',
          outcome: 'failed'
        }),
        worker('2', {
          quorum: 2,
          debounceMs: 0,
          terminalAt: '2026-07-11T12:00:02.000Z',
          outcome: 'cancelled'
        }),
        worker('3', { quorum: 2 })
      ],
      { nowMs: nowMs + 3_000 }
    )

    expect(evaluation).toMatchObject({ status: 'ready', quorum: 2, terminalWorkers: 2 })
  })

  it('debounces a satisfied join so nearby child results coalesce', () => {
    const evaluation = evaluateSubThreadJoin(
      [worker('1', { debounceMs: 500, terminalAt: '2026-07-11T12:00:01.000Z' })],
      { nowMs: nowMs + 1_200 }
    )

    expect(evaluation).toMatchObject({
      status: 'debouncing',
      readyAt: '2026-07-11T12:00:01.500Z'
    })
  })

  it('does not let optional workers block required quorum', () => {
    const evaluation = evaluateSubThreadJoin(
      [
        worker('required', {
          debounceMs: 0,
          terminalAt: '2026-07-11T12:00:01.000Z'
        }),
        worker('optional', { required: false, debounceMs: 0 })
      ],
      { nowMs: nowMs + 2_000 }
    )

    expect(evaluation).toMatchObject({ status: 'ready', requiredWorkers: 1, quorum: 1 })
  })

  it('releases at the deadline and reports missing required workers', () => {
    const evaluation = evaluateSubThreadJoin(
      [worker('1', { deadlineMs: 1_000 }), worker('2', { deadlineMs: 1_000 })],
      { nowMs: nowMs + 1_001 }
    )

    expect(evaluation).toMatchObject({
      status: 'deadline',
      missingRequiredSubThreadIds: ['child-1', 'child-2']
    })
  })

  it('does not silently weaken a configured quorum larger than current membership', () => {
    const evaluation = evaluateSubThreadJoin(
      [
        worker('1', {
          quorum: 3,
          debounceMs: 0,
          terminalAt: '2026-07-11T12:00:01.000Z'
        }),
        worker('2', {
          quorum: 3,
          debounceMs: 0,
          terminalAt: '2026-07-11T12:00:02.000Z'
        })
      ],
      { nowMs: nowMs + 3_000 }
    )

    expect(evaluation).toMatchObject({
      status: 'waiting',
      quorum: 3,
      terminalRequiredWorkers: 2
    })
  })
})
