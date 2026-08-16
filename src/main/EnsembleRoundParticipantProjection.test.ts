import { describe, expect, it } from 'vitest'
import type { ChatRun, EnsembleRoundParticipantState, EnsembleRoundState } from './store/types'
import { projectRoundParticipantFromChatRun } from './EnsembleRoundParticipantProjection'

function participant(
  overrides: Partial<EnsembleRoundParticipantState> = {}
): EnsembleRoundParticipantState {
  return {
    participantId: 'worker',
    provider: 'codex',
    role: 'Worker',
    order: 1,
    status: 'failed',
    runId: 'old-run',
    startedAt: '2026-08-16T10:00:00.000Z',
    endedAt: '2026-08-16T10:01:00.000Z',
    reason: 'Old attempt failed.',
    lastFailureReason: 'Old attempt failed.',
    ...overrides
  }
}

function round(state = participant()): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'Keep working.',
    startedAt: '2026-08-16T10:00:00.000Z',
    activeParticipantId: state.participantId,
    turnTransition: {
      phase: 'handoff',
      runtimeInstanceId: 'runtime-1',
      sourceParticipantId: state.participantId,
      sourceRunId: state.runId || 'old-run',
      startedAt: '2026-08-16T10:01:00.000Z'
    },
    participants: [state]
  }
}

function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: 'new-run',
    startedAt: '2026-08-16T10:02:00.000Z',
    ensembleRoundId: 'round-1',
    ensembleParticipantId: 'worker',
    ensembleParticipantStatus: 'running',
    status: 'running',
    ...overrides
  }
}

describe('projectRoundParticipantFromChatRun', () => {
  it('replaces terminal fields when a new attempt starts', () => {
    const before = round()
    const projected = projectRoundParticipantFromChatRun(before, run())!
    const worker = projected.participants[0]

    expect(worker).toMatchObject({
      participantId: 'worker',
      status: 'running',
      runId: 'new-run',
      startedAt: '2026-08-16T10:02:00.000Z'
    })
    expect(worker.endedAt).toBeUndefined()
    expect(worker.reason).toBeUndefined()
    expect(worker.lastFailureReason).toBeUndefined()
    expect(projected.activeParticipantId).toBe('worker')
    expect(projected.turnTransition).toBeUndefined()
    expect(before.participants[0].endedAt).toBe('2026-08-16T10:01:00.000Z')
  })

  it('projects a failed terminal attempt and its exact reason', () => {
    const projected = projectRoundParticipantFromChatRun(
      round(participant({ status: 'running', endedAt: undefined })),
      run({
        endedAt: '2026-08-16T10:03:00.000Z',
        ensembleParticipantStatus: 'failed',
        ensembleTerminalReason: 'Provider exited with code 1.',
        status: 'failed'
      })
    )!

    expect(projected.participants[0]).toMatchObject({
      status: 'failed',
      endedAt: '2026-08-16T10:03:00.000Z',
      reason: 'Provider exited with code 1.',
      lastFailureReason: 'Provider exited with code 1.'
    })
    expect(projected.activeParticipantId).toBeUndefined()
  })

  it('clears an older failure after a successful terminal attempt', () => {
    const projected = projectRoundParticipantFromChatRun(
      round(),
      run({
        endedAt: '2026-08-16T10:03:00.000Z',
        ensembleParticipantStatus: 'answered',
        status: 'success'
      })
    )!

    expect(projected.participants[0]).toMatchObject({
      status: 'answered',
      endedAt: '2026-08-16T10:03:00.000Z'
    })
    expect(projected.participants[0].reason).toBeUndefined()
    expect(projected.participants[0].lastFailureReason).toBeUndefined()
  })

  it('ignores mismatched and legacy runs rather than inventing attempt state', () => {
    const before = round()
    expect(
      projectRoundParticipantFromChatRun(before, run({ ensembleParticipantId: 'someone-else' }))
    ).toBe(before)
    expect(
      projectRoundParticipantFromChatRun(before, run({ ensembleParticipantStatus: undefined }))
    ).toBe(before)
  })

  it('can hide a maintenance attempt id while still clearing its stale lifecycle fields', () => {
    const projected = projectRoundParticipantFromChatRun(round(), run(), {
      exposeRunId: false
    })!

    expect(projected.participants[0].status).toBe('running')
    expect(projected.participants[0].runId).toBeUndefined()
    expect(projected.participants[0].endedAt).toBeUndefined()
    expect(projected.participants[0].lastFailureReason).toBeUndefined()
  })
})
