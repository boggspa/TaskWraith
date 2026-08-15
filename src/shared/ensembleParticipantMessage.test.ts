import { describe, expect, it } from 'vitest'
import {
  isEnsembleParticipantAuthoredMessage,
  isEnsembleYieldMessage
} from './ensembleParticipantMessage'

describe('ensemble participant-authored system carriers', () => {
  it('recognizes yielded status codas on system or assistant carriers', () => {
    const metadata = {
      kind: 'ensembleParticipantStatus',
      ensembleStatus: 'yielded',
      ensembleParticipantId: 'orchestrator'
    }

    expect(isEnsembleYieldMessage({ role: 'system', metadata })).toBe(true)
    expect(isEnsembleYieldMessage({ role: 'assistant', metadata })).toBe(true)
  })

  it('leaves other participant statuses at system hierarchy', () => {
    for (const ensembleStatus of ['failed', 'skipped', 'sleeping']) {
      expect(
        isEnsembleYieldMessage({
          role: 'system',
          metadata: { kind: 'ensembleParticipantStatus', ensembleStatus }
        })
      ).toBe(false)
    }
    expect(
      isEnsembleYieldMessage({
        role: 'tool',
        metadata: { kind: 'ensembleParticipantStatus', ensembleStatus: 'yielded' }
      })
    ).toBe(false)
  })

  it('combines inter-seat notes and yield handoffs under one presentation policy', () => {
    expect(
      isEnsembleParticipantAuthoredMessage({
        role: 'system',
        metadata: { kind: 'ensembleSideMessage' }
      })
    ).toBe(true)
    expect(
      isEnsembleParticipantAuthoredMessage({
        role: 'system',
        metadata: { kind: 'ensembleParticipantStatus', ensembleStatus: 'yielded' }
      })
    ).toBe(true)
  })
})
