import { describe, expect, it } from 'vitest'

import {
  adjustLaneApprovals,
  buildLaneId,
  canStartConcurrentRound,
  createLane,
  formatFanoutWaveCompletionStatus,
  isTerminalLaneStatus,
  lanesForParticipant,
  NON_TERMINAL_LANE_STATUSES,
  roundHasActiveLanes,
  summariseLanes,
  TERMINAL_LANE_STATUSES,
  transitionLane
} from './EnsembleLanes'
import type { ConcurrentLane, EnsembleRoundState } from './store/types'

const NOW = '2026-05-27T22:00:00.000Z'
const LATER = '2026-05-27T22:01:00.000Z'

function makeRound(lanes: ConcurrentLane[] = []): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'do the thing',
    startedAt: NOW,
    concurrentMode: lanes.length > 0,
    lanes: lanes.reduce<Record<string, ConcurrentLane>>((acc, lane) => {
      acc[lane.laneId] = lane
      return acc
    }, {}),
    participants: []
  }
}

describe('buildLaneId', () => {
  it('produces a stable id from roundId + participantId + attempt', () => {
    expect(buildLaneId('round-1', 'codex-explorer', 1)).toBe('lane-round-1-codex-explorer-1')
  })

  it('defaults attempt to 1', () => {
    expect(buildLaneId('round-1', 'pid')).toBe('lane-round-1-pid-1')
  })

  it('increments on retry attempts', () => {
    expect(buildLaneId('round-1', 'pid', 2)).toBe('lane-round-1-pid-2')
    expect(buildLaneId('round-1', 'pid', 99)).toBe('lane-round-1-pid-99')
  })
})

describe('Lane status sets', () => {
  it('classifies pending / running / blocked / awaiting-approval as non-terminal', () => {
    expect(NON_TERMINAL_LANE_STATUSES.has('pending')).toBe(true)
    expect(NON_TERMINAL_LANE_STATUSES.has('running')).toBe(true)
    expect(NON_TERMINAL_LANE_STATUSES.has('blocked')).toBe(true)
    expect(NON_TERMINAL_LANE_STATUSES.has('awaiting-approval')).toBe(true)
  })

  it('classifies completed / failed / cancelled as terminal', () => {
    expect(TERMINAL_LANE_STATUSES.has('completed')).toBe(true)
    expect(TERMINAL_LANE_STATUSES.has('failed')).toBe(true)
    expect(TERMINAL_LANE_STATUSES.has('cancelled')).toBe(true)
  })

  it('isTerminalLaneStatus matches the set membership', () => {
    expect(isTerminalLaneStatus('completed')).toBe(true)
    expect(isTerminalLaneStatus('failed')).toBe(true)
    expect(isTerminalLaneStatus('cancelled')).toBe(true)
    expect(isTerminalLaneStatus('pending')).toBe(false)
    expect(isTerminalLaneStatus('running')).toBe(false)
    expect(isTerminalLaneStatus('blocked')).toBe(false)
    expect(isTerminalLaneStatus('awaiting-approval')).toBe(false)
  })
})

describe('createLane', () => {
  it('returns a pending lane with the supplied fields', () => {
    const lane = createLane({
      laneId: 'lane-abc',
      participantId: 'pid',
      provider: 'codex',
      nowIso: NOW
    })
    expect(lane.status).toBe('pending')
    expect(lane.participantId).toBe('pid')
    expect(lane.provider).toBe('codex')
    expect(lane.startedAt).toBe(NOW)
    expect(lane.approvalsQueued).toBe(0)
    expect(lane.intent).toBe('none')
    expect(lane.providerSessionId).toBeNull()
  })

  it('respects an explicit intent', () => {
    const lane = createLane({
      laneId: 'lane-x',
      participantId: 'pid',
      provider: 'claude',
      intent: 'write',
      nowIso: NOW
    })
    expect(lane.intent).toBe('write')
  })

  it('carries providerSessionId when supplied', () => {
    const lane = createLane({
      laneId: 'lane-x',
      participantId: 'pid',
      provider: 'codex',
      providerSessionId: 'codex-session-abc',
      nowIso: NOW
    })
    expect(lane.providerSessionId).toBe('codex-session-abc')
  })
})

describe('transitionLane', () => {
  function pendingLane(): ConcurrentLane {
    return createLane({
      laneId: 'lane-1',
      participantId: 'pid',
      provider: 'codex',
      nowIso: NOW
    })
  }

  it('moves pending → running', () => {
    const lane = transitionLane(pendingLane(), { status: 'running', nowIso: LATER })
    expect(lane.status).toBe('running')
    expect(lane.endedAt).toBeUndefined() // non-terminal, no end stamp
  })

  it('stamps endedAt when moving to a terminal status', () => {
    const lane = transitionLane(pendingLane(), { status: 'completed', nowIso: LATER })
    expect(lane.status).toBe('completed')
    expect(lane.endedAt).toBe(LATER)
  })

  it('stamps endedAt for failed terminal transitions', () => {
    const lane = transitionLane(pendingLane(), {
      status: 'failed',
      reason: 'adapter error',
      nowIso: LATER
    })
    expect(lane.status).toBe('failed')
    expect(lane.endedAt).toBe(LATER)
    expect(lane.reason).toBe('adapter error')
  })

  it('does not modify a lane that is already terminal', () => {
    const completed = transitionLane(pendingLane(), { status: 'completed', nowIso: LATER })
    const attempt = transitionLane(completed, { status: 'running', nowIso: LATER })
    expect(attempt).toBe(completed) // referential equality — short-circuit returns input
  })

  it('updates runId / providerSessionId when supplied', () => {
    const lane = transitionLane(pendingLane(), {
      status: 'running',
      runId: 'codex-run-1',
      providerSessionId: 'codex-session-1',
      nowIso: LATER
    })
    expect(lane.runId).toBe('codex-run-1')
    expect(lane.providerSessionId).toBe('codex-session-1')
  })

  it('clamps approvalsQueued at 0', () => {
    const lane = transitionLane(pendingLane(), {
      status: 'awaiting-approval',
      approvalsQueued: -5,
      nowIso: LATER
    })
    expect(lane.approvalsQueued).toBe(0)
  })

  it('preserves reason from prior transitions when no new reason supplied', () => {
    const blocked = transitionLane(pendingLane(), {
      status: 'blocked',
      reason: 'write-intent conflict on /src/foo.ts',
      nowIso: LATER
    })
    const retried = transitionLane(blocked, { status: 'running', nowIso: LATER })
    expect(retried.reason).toBe('write-intent conflict on /src/foo.ts')
  })
})

describe('adjustLaneApprovals', () => {
  function laneWith(count: number): ConcurrentLane {
    return {
      ...createLane({
        laneId: 'lane-1',
        participantId: 'pid',
        provider: 'codex',
        nowIso: NOW
      }),
      approvalsQueued: count
    }
  }

  it('increments by positive delta', () => {
    const next = adjustLaneApprovals(laneWith(0), 1, LATER)
    expect(next.approvalsQueued).toBe(1)
  })

  it('decrements by negative delta', () => {
    const next = adjustLaneApprovals(laneWith(3), -2, LATER)
    expect(next.approvalsQueued).toBe(1)
  })

  it('clamps at 0 — never negative', () => {
    const next = adjustLaneApprovals(laneWith(0), -5, LATER)
    expect(next.approvalsQueued).toBe(0)
  })

  it('does not modify terminal lanes', () => {
    const completed = transitionLane(laneWith(0), { status: 'completed', nowIso: LATER })
    const attempt = adjustLaneApprovals(completed, 1, LATER)
    expect(attempt).toBe(completed)
  })
})

describe('lanesForParticipant', () => {
  it('returns empty array when no lanes', () => {
    expect(lanesForParticipant(makeRound(), 'pid')).toEqual([])
  })

  it('returns only lanes for the given participant', () => {
    const a = createLane({
      laneId: 'lane-a',
      participantId: 'pid-1',
      provider: 'codex',
      nowIso: NOW
    })
    const b = createLane({
      laneId: 'lane-b',
      participantId: 'pid-2',
      provider: 'claude',
      nowIso: NOW
    })
    const c = createLane({
      laneId: 'lane-c',
      participantId: 'pid-1',
      provider: 'codex',
      nowIso: NOW
    })
    const round = makeRound([a, b, c])
    const out = lanesForParticipant(round, 'pid-1').map((l) => l.laneId)
    expect(out).toEqual(['lane-a', 'lane-c'])
  })
})

describe('roundHasActiveLanes', () => {
  it('returns false for rounds with no lanes', () => {
    expect(roundHasActiveLanes(makeRound())).toBe(false)
  })

  it('returns true when at least one lane is non-terminal', () => {
    const a = createLane({
      laneId: 'lane-a',
      participantId: 'p1',
      provider: 'codex',
      nowIso: NOW
    })
    expect(roundHasActiveLanes(makeRound([a]))).toBe(true)
  })

  it('returns false when every lane is terminal', () => {
    const a = transitionLane(
      createLane({ laneId: 'lane-a', participantId: 'p1', provider: 'codex', nowIso: NOW }),
      { status: 'completed', nowIso: LATER }
    )
    const b = transitionLane(
      createLane({ laneId: 'lane-b', participantId: 'p2', provider: 'claude', nowIso: NOW }),
      { status: 'failed', nowIso: LATER }
    )
    expect(roundHasActiveLanes(makeRound([a, b]))).toBe(false)
  })
})

describe('summariseLanes', () => {
  it('returns all-zero map for empty rounds', () => {
    const out = summariseLanes(makeRound())
    expect(out.pending).toBe(0)
    expect(out.running).toBe(0)
    expect(out.completed).toBe(0)
    expect(out.failed).toBe(0)
    expect(out.cancelled).toBe(0)
    expect(out.blocked).toBe(0)
    expect(out['awaiting-approval']).toBe(0)
  })

  it('counts each status correctly', () => {
    const lanes: ConcurrentLane[] = [
      transitionLane(
        createLane({ laneId: 'a', participantId: 'p1', provider: 'codex', nowIso: NOW }),
        { status: 'running', nowIso: LATER }
      ),
      transitionLane(
        createLane({ laneId: 'b', participantId: 'p2', provider: 'codex', nowIso: NOW }),
        { status: 'running', nowIso: LATER }
      ),
      transitionLane(
        createLane({ laneId: 'c', participantId: 'p3', provider: 'claude', nowIso: NOW }),
        { status: 'completed', nowIso: LATER }
      ),
      transitionLane(
        createLane({ laneId: 'd', participantId: 'p4', provider: 'gemini', nowIso: NOW }),
        { status: 'blocked', nowIso: LATER }
      )
    ]
    const out = summariseLanes(makeRound(lanes))
    expect(out.running).toBe(2)
    expect(out.completed).toBe(1)
    expect(out.blocked).toBe(1)
    expect(out.failed).toBe(0)
  })
})

describe('canStartConcurrentRound', () => {
  it('always allows serial mode regardless of gate', () => {
    const result = canStartConcurrentRound({
      concurrentLanesEnabled: false,
      chatIsEnsemble: false,
      requestedConcurrentMode: false,
      enabledParticipantCount: 1
    })
    expect(result.ok).toBe(true)
  })

  it('rejects concurrent mode when the gate is off', () => {
    const result = canStartConcurrentRound({
      concurrentLanesEnabled: false,
      chatIsEnsemble: true,
      requestedConcurrentMode: true,
      enabledParticipantCount: 3
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/TASKWRAITH_CONCURRENT_LANES/)
  })

  it('rejects concurrent mode on non-ensemble chats', () => {
    const result = canStartConcurrentRound({
      concurrentLanesEnabled: true,
      chatIsEnsemble: false,
      requestedConcurrentMode: true,
      enabledParticipantCount: 3
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/Ensemble chat/)
  })

  it('rejects concurrent mode with fewer than 2 enabled participants', () => {
    const result = canStartConcurrentRound({
      concurrentLanesEnabled: true,
      chatIsEnsemble: true,
      requestedConcurrentMode: true,
      enabledParticipantCount: 1
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/at least 2/)
  })

  it('allows concurrent mode when gate + ensemble + participant count are all good', () => {
    const result = canStartConcurrentRound({
      concurrentLanesEnabled: true,
      chatIsEnsemble: true,
      requestedConcurrentMode: true,
      enabledParticipantCount: 3
    })
    expect(result.ok).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})

describe('formatFanoutWaveCompletionStatus', () => {
  it('keeps the plain disposition copy when every lane returned', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Fan-out wave',
        outcomes: [
          { label: 'Scout', status: 'answered' },
          { label: 'Worker', status: 'yielded' }
        ],
        hasSourceRun: true,
        continuousReviewWave: false
      })
    ).toBe('Fan-out wave complete · 2 lane(s) returned to the caller.')
  })

  it('names a skipped lane and its recorded reason', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Fan-out wave',
        outcomes: [
          { label: 'Work1', status: 'answered' },
          {
            label: 'Work3',
            status: 'cancelled',
            reason: 'Lane lane-kimi-1 is not approved to write .wip-work3-slice3.'
          }
        ],
        hasSourceRun: true,
        continuousReviewWave: false
      })
    ).toBe(
      'Fan-out wave complete · 1 lane(s) returned, 1 skipped (Work3 — Lane lane-kimi-1 is not approved to write .wip-work3-slice3.).'
    )
  })

  it('separates failed lanes from returned ones instead of counting them as returned', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Fan-out wave',
        outcomes: [
          { label: 'Work1', status: 'answered' },
          { label: 'Work3', status: 'failed', reason: 'kimi transport rejected every write tool.' }
        ],
        hasSourceRun: true,
        continuousReviewWave: false
      })
    ).toBe(
      'Fan-out wave complete · 1 lane(s) returned, 1 failed (Work3 — kimi transport rejected every write tool.).'
    )
  })

  it('keeps the bare count when no skipped lane recorded a reason', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Fan-out wave',
        outcomes: [
          { label: 'Work1', status: 'answered' },
          { label: 'Work3', status: 'cancelled' }
        ],
        hasSourceRun: true,
        continuousReviewWave: false
      })
    ).toBe('Fan-out wave complete · 1 lane(s) returned, 1 skipped.')
  })

  it('keeps "complete" for a wave whose lanes all ran but produced nothing', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Review wave',
        outcomes: [
          { label: 'Scout', status: 'skipped', reason: 'Completed without producing output.' },
          { label: 'Work3', status: 'skipped', reason: 'Completed without producing output.' }
        ],
        hasSourceRun: false,
        continuousReviewWave: true
      })
    ).toBe(
      'Review wave complete · 0 lane(s) returned, 2 skipped (Scout — Completed without producing output.; Work3 — Completed without producing output.).'
    )
  })

  it('lists every stopped lane when the whole wave was stopped', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Review wave',
        outcomes: [
          { label: 'Scout', status: 'cancelled', reason: 'Owning participant was skipped.' },
          { label: 'Work3', status: 'cancelled', reason: 'Stop requested by user.' }
        ],
        hasSourceRun: false,
        continuousReviewWave: false
      })
    ).toBe(
      'Review wave skipped · 2 lane(s) stopped (Scout — Owning participant was skipped.; Work3 — Stop requested by user.).'
    )
  })

  it('truncates an oversized lane reason for the status feed', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Fan-out wave',
        outcomes: [
          { label: 'Work1', status: 'answered' },
          { label: 'Work3', status: 'cancelled', reason: 'x'.repeat(200) }
        ],
        hasSourceRun: true,
        continuousReviewWave: false
      })
    ).toBe(
      `Fan-out wave complete · 1 lane(s) returned, 1 skipped (Work3 — ${'x'.repeat(139)}…).`
    )
  })

  it('keeps the background, continuous review-wave, and serial-return arms', () => {
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Scout wave',
        outcomes: [{ label: 'Scout', status: 'answered' }],
        completionDisposition: 'background',
        hasSourceRun: false,
        continuousReviewWave: false
      })
    ).toBe('Scout wave complete · 1 lane(s) returned.')
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Review wave',
        outcomes: [{ label: 'Scout', status: 'answered' }],
        hasSourceRun: false,
        continuousReviewWave: true
      })
    ).toBe('Review wave complete · continuing Continuous while hops remain.')
    expect(
      formatFanoutWaveCompletionStatus({
        label: 'Fan-out wave',
        outcomes: [{ label: 'Scout', status: 'answered' }],
        hasSourceRun: false,
        continuousReviewWave: false
      })
    ).toBe('Fan-out wave complete · returning to serial writer step.')
  })
})
