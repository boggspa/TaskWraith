import { describe, expect, it } from 'vitest'

import { bootOnlyRecoveryVerdict, captureBootOnlyRecoveryShape } from './BootOnlyRecoveryGuard'

describe('bootOnlyRecoveryVerdict', () => {
  it('is safe when the run queue is unchanged since boot', () => {
    const shape = captureBootOnlyRecoveryShape([
      { runId: 'run-b', status: 'active' },
      { runId: 'run-a', status: 'completed' }
    ])
    expect(shape.map((entry) => entry.runId)).toEqual(['run-a', 'run-b'])
    expect(bootOnlyRecoveryVerdict(shape, shape)).toEqual({ safe: true })
  })

  it('refuses once a run has started, because recovery would fail a live run', () => {
    const atBoot = captureBootOnlyRecoveryShape([{ runId: 'run-a', status: 'completed' }])
    const now = captureBootOnlyRecoveryShape([
      { runId: 'run-a', status: 'completed' },
      { runId: 'run-new', status: 'active' }
    ])
    expect(bootOnlyRecoveryVerdict(atBoot, now)).toEqual({ safe: false, reason: 'run_started' })
  })

  it('refuses on a status transition even with no new run', () => {
    const atBoot = captureBootOnlyRecoveryShape([{ runId: 'run-a', status: 'queued' }])
    const now = captureBootOnlyRecoveryShape([{ runId: 'run-a', status: 'active' }])
    expect(bootOnlyRecoveryVerdict(atBoot, now)).toEqual({
      safe: false,
      reason: 'run_status_changed'
    })
  })

  it('refuses when a job disappeared, rather than assuming the queue only grows', () => {
    const atBoot = captureBootOnlyRecoveryShape([
      { runId: 'run-a', status: 'queued' },
      { runId: 'run-b', status: 'queued' }
    ])
    const now = captureBootOnlyRecoveryShape([{ runId: 'run-a', status: 'queued' }])
    expect(bootOnlyRecoveryVerdict(atBoot, now)).toEqual({ safe: false, reason: 'run_removed' })
  })

  it('is safe for an empty queue on both sides', () => {
    expect(bootOnlyRecoveryVerdict([], [])).toEqual({ safe: true })
  })
})
