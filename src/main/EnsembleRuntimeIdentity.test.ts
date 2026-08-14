import { describe, expect, it } from 'vitest'
import type { EnsembleRoundState } from './store/types'
import {
  currentEnsembleRuntimeInstanceId,
  discardForeignEnsembleTurnTransition
} from './EnsembleRuntimeIdentity'

function round(runtimeInstanceId: string): EnsembleRoundState {
  return {
    roundId: 'round-1',
    status: 'running',
    prompt: 'go',
    startedAt: '2026-08-14T12:00:00.000Z',
    turnTransition: {
      phase: 'settling-provider',
      runtimeInstanceId,
      sourceParticipantId: 'seat-1',
      sourceRunId: 'run-1',
      startedAt: '2026-08-14T12:00:01.000Z'
    },
    participants: []
  }
}

describe('discardForeignEnsembleTurnTransition', () => {
  it('keeps a projection owned by this main-process runtime', () => {
    const current = round(currentEnsembleRuntimeInstanceId())

    expect(discardForeignEnsembleTurnTransition(current)).toBe(current)
  })

  it('drops a projection inherited from a previous main process', () => {
    const stale = round('previous-main-process')

    expect(discardForeignEnsembleTurnTransition(stale)).toEqual({
      ...stale,
      turnTransition: undefined
    })
    expect(discardForeignEnsembleTurnTransition(stale).turnTransition).toBeUndefined()
  })
})
