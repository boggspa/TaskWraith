/**
 * Host Arc Track3 Mixed Wave A SUPPORT — cross-family status-map honesty pins.
 *
 * Per-family shadow suites cover adapter shape. This file locks the three
 * skew cases that must stay honest when Run / Mission / Round map functions
 * evolve independently:
 *   - paused goal → blocked (never completed)
 *   - stale running round → completed (never live running)
 *   - starting run → running
 */

import { describe, expect, it } from 'vitest'
import {
  mapActiveGoalShadowsToHostMissions,
  mapActiveGoalStatusToHostMissionOutcome
} from './HostProductionMissionShadow'
import {
  mapEnsembleRoundShadowsToHostRounds,
  projectHostRoundStatus
} from './HostProductionRoundShadow'
import { mapActiveRunShadowsToHostRuns } from './HostProductionRunShadow'

describe('HostProductionShadowStatusMap — cross-family honesty pins', () => {
  it('paused goal maps to blocked — never completed', () => {
    expect(mapActiveGoalStatusToHostMissionOutcome('paused')).toBe('blocked')
    expect(mapActiveGoalStatusToHostMissionOutcome('paused')).not.toBe('completed')

    const rows = mapActiveGoalShadowsToHostMissions([
      {
        id: 'goal-paused-1',
        objective: 'Hold for human review',
        status: 'paused',
        updatedAt: '2024-11-14T22:13:20.000Z'
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('blocked')
    expect(rows[0].status).not.toBe('completed')
  })

  it('stale running round (running + live=false) maps to completed — not running', () => {
    expect(projectHostRoundStatus('running', false)).toBe('completed')
    expect(projectHostRoundStatus('running', true)).toBe('running')

    const rows = mapEnsembleRoundShadowsToHostRounds([
      {
        roundId: 'round-stale-1',
        threadId: 'chat-1',
        status: 'running',
        live: false,
        participantIds: ['p-a'],
        providerRunIds: ['run-1']
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('completed')
    expect(rows[0].status).not.toBe('running')
  })

  it('starting run maps to running (providerOutcome)', () => {
    const rows = mapActiveRunShadowsToHostRuns([
      {
        runId: 'run-starting-1',
        threadId: 'chat-1',
        providerId: 'codex',
        status: 'starting'
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].providerOutcome).toBe('running')
  })
})
