import { describe, expect, it } from 'vitest'
import {
  executionGraphBypassesOrdinaryChatOccupancy,
  executionGraphLifecyclePairMatches,
  executionGraphPrelaunchJobIsStarting
} from './ExecutionGraphDispatchPolicy'

describe('execution graph dispatch policy', () => {
  it('limits the same-chat occupancy bypass to exact graph rows', () => {
    expect(executionGraphBypassesOrdinaryChatOccupancy({ executionGraph: undefined })).toBe(false)
    expect(
      executionGraphBypassesOrdinaryChatOccupancy({
        executionGraph: { executionId: 'graph-one' } as never
      })
    ).toBe(true)
  })

  it('admits the provisional lifecycle and the provider-owned lifecycle only', () => {
    expect(
      executionGraphLifecyclePairMatches({
        hasExistingSession: true,
        sessionStatus: 'starting',
        jobStatus: 'starting'
      })
    ).toBe(true)
    expect(
      executionGraphLifecyclePairMatches({
        hasExistingSession: true,
        sessionStatus: 'running',
        jobStatus: 'active'
      })
    ).toBe(true)
    expect(
      executionGraphLifecyclePairMatches({
        hasExistingSession: true,
        sessionStatus: 'starting',
        jobStatus: 'active'
      })
    ).toBe(false)
    expect(
      executionGraphLifecyclePairMatches({
        hasExistingSession: true,
        sessionStatus: 'running',
        jobStatus: 'starting'
      })
    ).toBe(false)
    expect(
      executionGraphLifecyclePairMatches({ hasExistingSession: false, jobStatus: 'starting' })
    ).toBe(true)
  })

  it('keeps prelaunch on the starting side of adapter adoption', () => {
    expect(executionGraphPrelaunchJobIsStarting('starting')).toBe(true)
    expect(executionGraphPrelaunchJobIsStarting('active')).toBe(false)
  })
})
