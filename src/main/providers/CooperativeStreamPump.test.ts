import { describe, expect, it } from 'vitest'
import { COOPERATIVE_STREAM_TURN_BUDGET_MS, forEachCooperative } from './CooperativeStreamPump'

describe('forEachCooperative', () => {
  it('visits every item synchronously when the turn stays under budget', () => {
    const seen: number[] = []
    forEachCooperative([1, 2, 3], (item) => {
      seen.push(item)
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('yields the remainder once a turn exceeds the G-lag budget', async () => {
    let clock = 0
    const scheduled: Array<() => void> = []
    const seen: string[] = []
    forEachCooperative(
      ['a', 'b', 'c'],
      (item) => {
        seen.push(item)
        clock += COOPERATIVE_STREAM_TURN_BUDGET_MS
      },
      {
        now: () => clock,
        schedule: (resume) => scheduled.push(resume)
      }
    )

    expect(seen).toEqual(['a'])
    expect(scheduled).toHaveLength(1)
    scheduled[0]()
    expect(seen).toEqual(['a', 'b'])
    expect(scheduled).toHaveLength(2)
    scheduled[1]()
    expect(seen).toEqual(['a', 'b', 'c'])
  })
})
