import { describe, expect, it } from 'vitest'
import type {
  ConcurrentLane,
  EnsembleParticipant,
  EnsembleRoundParticipantState,
  EnsembleRoundState
} from '../main/store/types'
import {
  clearEnsembleRoundFailureForSeatChange,
  ensembleSeatExecutionConfigChanged
} from './ensembleSeatFailureClear'

function seat(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'p-gemini',
    provider: 'gemini',
    enabled: true,
    role: 'GemProW',
    instructions: 'Work.',
    order: 8,
    model: 'gemini-3-pro',
    permissionPresetId: 'workspace_write',
    ...overrides
  }
}

function roundState(
  overrides: Partial<EnsembleRoundParticipantState> = {}
): EnsembleRoundParticipantState {
  return {
    participantId: 'p-gemini',
    provider: 'gemini',
    role: 'GemProW',
    order: 8,
    status: 'failed',
    reason: 'Provider exited with code 1.',
    lastFailureReason: 'Provider exited with code 1.',
    ...overrides
  }
}

function lane(overrides: Partial<ConcurrentLane> = {}): ConcurrentLane {
  return {
    laneId: 'lane-r1-p-gemini-1',
    participantId: 'p-gemini',
    provider: 'gemini',
    status: 'failed',
    intent: 'read',
    startedAt: '2026-08-05T00:00:00.000Z',
    reason: 'Lane dispatch failed.',
    ...overrides
  }
}

function round(overrides: Partial<EnsembleRoundState> = {}): EnsembleRoundState {
  return {
    roundId: 'r1',
    status: 'completed',
    prompt: 'Do the thing.',
    startedAt: '2026-08-05T00:00:00.000Z',
    endedAt: '2026-08-05T00:05:00.000Z',
    participants: [roundState()],
    ...overrides
  }
}

const NOW = '2026-08-05T01:00:00.000Z'

describe('ensembleSeatExecutionConfigChanged', () => {
  it('flags every execution-config knob the seat can run with', () => {
    const before = seat()
    const changes: Array<Partial<EnsembleParticipant>> = [
      { provider: 'codex' },
      { model: 'gemini-3-flash' },
      { reasoningEffort: 'high' },
      { fastModeEnabled: true },
      { thinkingEnabled: false },
      { serviceTier: 'priority' },
      { permissionPresetId: 'read_only' },
      { permissionOverrides: {} },
      { geminiAuthProfileId: 'profile-2' },
      { runtimeProfileId: 'runtime-2' },
      { ollamaRunProfile: 'throughput' as EnsembleParticipant['ollamaRunProfile'] }
    ]
    for (const patch of changes) {
      expect(
        ensembleSeatExecutionConfigChanged(before, { ...before, ...patch }),
        `patch ${Object.keys(patch)[0]}`
      ).toBe(true)
    }
  })

  it('ignores identity, wording, ordering, and automation-managed fields', () => {
    const before = seat()
    const nonExecution: Array<Partial<EnsembleParticipant>> = [
      {},
      { role: 'Renamed' },
      { instructions: 'New brief.' },
      { enabled: false },
      { order: 2 },
      { stageRole: 'scout' },
      // Session linkage rotates via automated adoption paths; treating it as
      // an execution change would clear real failures behind the user's back.
      { linkedProviderSessionId: 'session-next' }
    ]
    for (const patch of nonExecution) {
      expect(
        ensembleSeatExecutionConfigChanged(before, { ...before, ...patch }),
        `patch ${Object.keys(patch)[0] || 'none'}`
      ).toBe(false)
    }
  })
})

describe('clearEnsembleRoundFailureForSeatChange', () => {
  it('resets a failed seat to idle and wipes both failure reasons', () => {
    const cleared = clearEnsembleRoundFailureForSeatChange(round(), 'p-gemini', NOW)
    expect(cleared?.participants[0]).toMatchObject({
      participantId: 'p-gemini',
      status: 'idle'
    })
    expect(cleared?.participants[0].reason).toBeUndefined()
    expect(cleared?.participants[0].lastFailureReason).toBeUndefined()
  })

  it('resets an unreachable seat the same way', () => {
    const source = round({ participants: [roundState({ status: 'unreachable' })] })
    const cleared = clearEnsembleRoundFailureForSeatChange(source, 'p-gemini', NOW)
    expect(cleared?.participants[0].status).toBe('idle')
  })

  it('leaves every other participant state untouched by reference', () => {
    const bystander = roundState({ participantId: 'p-codex', status: 'answered' })
    const source = round({ participants: [roundState(), bystander] })
    const cleared = clearEnsembleRoundFailureForSeatChange(source, 'p-gemini', NOW)
    expect(cleared?.participants[1]).toBe(bystander)
  })

  it('is an identity no-op when there is nothing to clear', () => {
    const answered = round({ participants: [roundState({ status: 'answered' })] })
    expect(clearEnsembleRoundFailureForSeatChange(answered, 'p-gemini', NOW)).toBe(answered)
    const absent = round()
    expect(clearEnsembleRoundFailureForSeatChange(absent, 'p-nobody', NOW)).toBe(absent)
    expect(clearEnsembleRoundFailureForSeatChange(undefined, 'p-gemini', NOW)).toBeUndefined()
  })

  it("stamps the seat's terminal-failure lanes as superseded without rewriting history", () => {
    const failedLane = lane()
    const blockedLane = lane({ laneId: 'lane-r1-p-gemini-2', status: 'blocked' })
    const completedLane = lane({ laneId: 'lane-r1-p-gemini-0', status: 'completed' })
    const bystanderLane = lane({
      laneId: 'lane-r1-p-codex-1',
      participantId: 'p-codex',
      status: 'failed'
    })
    const source = round({
      participants: [
        roundState({ status: 'idle', reason: undefined, lastFailureReason: undefined })
      ],
      lanes: {
        [failedLane.laneId]: failedLane,
        [blockedLane.laneId]: blockedLane,
        [completedLane.laneId]: completedLane,
        [bystanderLane.laneId]: bystanderLane
      }
    })
    const cleared = clearEnsembleRoundFailureForSeatChange(source, 'p-gemini', NOW)
    expect(cleared).not.toBe(source)
    expect(cleared?.lanes?.[failedLane.laneId]).toMatchObject({
      status: 'failed',
      failureSupersededBySeatChangeAt: NOW
    })
    expect(cleared?.lanes?.[blockedLane.laneId]?.failureSupersededBySeatChangeAt).toBe(NOW)
    expect(cleared?.lanes?.[completedLane.laneId]).toBe(completedLane)
    expect(cleared?.lanes?.[bystanderLane.laneId]).toBe(bystanderLane)
  })

  it('keeps an existing supersede stamp and stays identity when only stamped lanes remain', () => {
    const stamped = lane({ failureSupersededBySeatChangeAt: '2026-08-05T00:30:00.000Z' })
    const source = round({
      participants: [
        roundState({ status: 'idle', reason: undefined, lastFailureReason: undefined })
      ],
      lanes: { [stamped.laneId]: stamped }
    })
    expect(clearEnsembleRoundFailureForSeatChange(source, 'p-gemini', NOW)).toBe(source)
  })
})
