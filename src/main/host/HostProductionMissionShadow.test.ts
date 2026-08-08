/**
 * Host Arc Track3 Mixed Wave A — HostProductionMissionShadow pins.
 *
 * RED-first discipline matches HostProductionQuestionShadow /
 * HostProductionApprovalShadow: pins assert the mapping contract
 * before (and after) the adapter lands.
 *
 * WHAT IS BEING PINNED. ChatRecord.activeGoal rows are shadowed into
 * HostMissionProjection. Required wire fields are missionId/title/status/
 * updatedAt; paused has no Host twin and must map explicitly (never
 * invent completed).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createHostProductionMissionShadow,
  mapActiveGoalShadowsToHostMissions,
  type HostActiveGoalShadowEntry
} from './HostProductionMissionShadow'

function entry(overrides: Partial<HostActiveGoalShadowEntry> = {}): HostActiveGoalShadowEntry {
  return {
    id: 'goal-1700000000000-abc123',
    objective: 'Ship the Host missions family',
    status: 'active',
    updatedAt: '2024-11-14T22:13:20.000Z',
    threadId: 'chat-1',
    ...overrides
  }
}

describe('mapActiveGoalShadowsToHostMissions', () => {
  it('returns empty for zero goal entries (a measured none)', () => {
    expect(mapActiveGoalShadowsToHostMissions([])).toEqual([])
  })

  it('skips bad rows — missing id, empty objective, unparseable updatedAt', () => {
    const rows = mapActiveGoalShadowsToHostMissions([
      entry({ id: '' }),
      entry({ id: '   ' }),
      entry({ id: 'z'.repeat(4096) }),
      entry({ objective: '' }),
      entry({ objective: '   ' }),
      entry({ updatedAt: '' }),
      entry({ updatedAt: 'not-a-date' }),
      null as unknown as HostActiveGoalShadowEntry
    ])
    expect(rows).toEqual([])
  })

  it('happy-maps required fields and dual-stamps goalId', () => {
    const rows = mapActiveGoalShadowsToHostMissions([entry({ activeRoundId: 'round-9' })])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      missionId: 'goal-1700000000000-abc123',
      title: 'Ship the Host missions family',
      status: 'active',
      updatedAt: Date.parse('2024-11-14T22:13:20.000Z'),
      threadId: 'chat-1',
      goalId: 'goal-1700000000000-abc123',
      activeRoundId: 'round-9'
    })
  })

  it('maps ActiveGoal-like statuses onto HostMissionOutcome', () => {
    const rows = mapActiveGoalShadowsToHostMissions([
      entry({ id: 'g-active', status: 'active' }),
      entry({ id: 'g-blocked', status: 'blocked' }),
      entry({ id: 'g-completed', status: 'completed' }),
      entry({ id: 'g-cancelled', status: 'cancelled' }),
      entry({ id: 'g-failed', status: 'failed' }),
      entry({ id: 'g-weird', status: 'not-a-real-status' })
    ])
    expect(rows.map((r) => [r.missionId, r.status])).toEqual([
      ['g-active', 'active'],
      ['g-blocked', 'blocked'],
      ['g-completed', 'completed'],
      ['g-cancelled', 'cancelled'],
      ['g-failed', 'failed'],
      ['g-weird', 'unknown']
    ])
  })

  it('pins paused → blocked — never invents completed', () => {
    const rows = mapActiveGoalShadowsToHostMissions([entry({ status: 'paused' })])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('blocked')
    expect(rows[0].status).not.toBe('completed')
  })

  it('omits optional threadId / activeRoundId when absent rather than inventing', () => {
    const rows = mapActiveGoalShadowsToHostMissions([
      entry({ threadId: undefined, activeRoundId: undefined })
    ])
    expect(rows).toHaveLength(1)
    expect('threadId' in rows[0]).toBe(false)
    expect('activeRoundId' in rows[0]).toBe(false)
    expect(rows[0].goalId).toBe('goal-1700000000000-abc123')
  })

  it('bounds an over-long title rather than forwarding it', () => {
    const rows = mapActiveGoalShadowsToHostMissions([entry({ objective: 'x'.repeat(5000) })])
    expect(rows[0].title.length).toBeLessThanOrEqual(200)
  })

  it('allowlists fields — no objectiveSource, mode, provider, or ledger leak', () => {
    const rows = mapActiveGoalShadowsToHostMissions([entry()])
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['goalId', 'missionId', 'status', 'threadId', 'title', 'updatedAt'].sort()
    )
  })
})

describe('createHostProductionMissionShadow', () => {
  it('requires a listGoals function', () => {
    expect(() => createHostProductionMissionShadow({} as never)).toThrow(
      'HostProductionMissionShadow requires listGoals to be a function'
    )
  })

  it('reads live on every listMissions call (no caching of a moving set)', () => {
    const listGoals = vi.fn(() => [entry()])
    const port = createHostProductionMissionShadow({ listGoals })
    expect(port.listMissions()).toHaveLength(1)
    expect(port.listMissions()).toHaveLength(1)
    expect(listGoals).toHaveBeenCalledTimes(2)
  })

  it('lets a source throw propagate — fail closed, never a false empty', () => {
    const port = createHostProductionMissionShadow({
      listGoals: () => {
        throw new Error('goal registry unavailable')
      }
    })
    expect(() => port.listMissions()).toThrow('goal registry unavailable')
  })
})
