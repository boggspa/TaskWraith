import { describe, expect, it } from 'vitest'

import { projectHostRecovery } from './HostRecoveryProjection'
import type { HostRuntimeRecoverySummary } from './HostRuntimeBootstrap'

function summary(
  recoveryState: HostRuntimeRecoverySummary['delta']['recoveryState']
): HostRuntimeRecoverySummary {
  return {
    position: { generation: 7, cursor: 42 },
    delta: {
      recoveryState,
      recoveryWarnings: recoveryState === 'clean' ? [] : ['bounded warning'],
      lowestRetainedCursor: 12,
      size: 3,
      retainedBytes: 256
    },
    receipts: { size: 5, indeterminate: 2 }
  }
}

describe('projectHostRecovery', () => {
  it.each([
    ['clean', 'clean'],
    ['recovered-truncated-tail', 'recovered'],
    ['recovered-corrupt-interior', 'recovered'],
    ['degraded-checkpoint', 'degraded']
  ] as const)('maps %s to %s', (state, expected) => {
    expect(projectHostRecovery({ summary: summary(state) })).toEqual({
      lastGeneration: 7,
      lastCursor: 42,
      reopenStatus: expected,
      detail: 'indeterminate_receipts=2'
    })
  })

  it('preserves the sole delta position and bounded receipt metadata', () => {
    const input = {
      summary: summary('clean'),
      lastCheckpointAt: 1234
    }
    const before = structuredClone(input)
    const result = projectHostRecovery(input)

    expect(result).toEqual({
      lastCheckpointAt: 1234,
      lastGeneration: 7,
      lastCursor: 42,
      reopenStatus: 'clean',
      detail: 'indeterminate_receipts=2'
    })
    expect(input).toEqual(before)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, undefined])(
    'omits invalid checkpoint timestamp %s',
    (lastCheckpointAt) => {
      const result = projectHostRecovery({
        summary: summary('clean'),
        lastCheckpointAt
      })
      expect(result).not.toHaveProperty('lastCheckpointAt')
    }
  )

  it('omits zero indeterminate detail and fails closed for an unknown future state', () => {
    const base = summary('clean')
    base.receipts.indeterminate = 0
    expect(projectHostRecovery({ summary: base })).toEqual({
      lastGeneration: 7,
      lastCursor: 42,
      reopenStatus: 'clean'
    })

    const future = summary('clean') as HostRuntimeRecoverySummary
    ;(future.delta as { recoveryState: string }).recoveryState = 'future-state'
    expect(projectHostRecovery({ summary: future })).toMatchObject({
      reopenStatus: 'unknown'
    })
  })
})
