import { describe, expect, it } from 'vitest'
import { describeUpdateRestartActiveWork } from './UpdateRestartActiveWork'

describe('describeUpdateRestartActiveWork', () => {
  it('returns null when nothing is running', () => {
    expect(
      describeUpdateRestartActiveWork({
        activeThreadCount: 0,
        scheduledTasks: [{ status: 'idle' }, { status: 'completed' }],
        workflows: [{ activeExecutionId: null }, {}]
      })
    ).toBeNull()
  })

  it('names every kind of live work with counts', () => {
    expect(
      describeUpdateRestartActiveWork({
        activeThreadCount: 2,
        scheduledTasks: [{ status: 'due' }, { status: 'running' }, { status: 'idle' }],
        workflows: [{ activeExecutionId: 'exec-1' }]
      })
    ).toBe(
      'Waiting for 2 active agent runs, 2 scheduled tasks due or running, 1 workflow still executing'
    )
  })

  it('uses singular wording for one item', () => {
    expect(
      describeUpdateRestartActiveWork({ activeThreadCount: 1, scheduledTasks: [], workflows: [] })
    ).toBe('Waiting for 1 active agent run')
    expect(
      describeUpdateRestartActiveWork({
        activeThreadCount: 0,
        scheduledTasks: [{ status: 'due' }],
        workflows: []
      })
    ).toBe('Waiting for 1 scheduled task due or running')
  })

  it('ignores a malformed thread count', () => {
    expect(
      describeUpdateRestartActiveWork({
        activeThreadCount: Number.NaN,
        scheduledTasks: [],
        workflows: []
      })
    ).toBeNull()
  })
})
