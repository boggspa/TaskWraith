import { describe, expect, it } from 'vitest'
import {
  isEnsembleParticipantAuthoredMessage,
  isEnsembleYieldMessage
} from './ensembleParticipantMessage'
import {
  isEnsembleSideMessageToUser,
  sideMessageLaneMetadataForAudience
} from './ensembleSideMessage'

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

  it('recognizes only a valid participant carrier addressed to the User', () => {
    const metadata = { kind: 'ensembleSideMessage', toUser: true }

    expect(isEnsembleSideMessageToUser({ role: 'system', metadata })).toBe(true)
    expect(isEnsembleSideMessageToUser({ role: 'assistant', metadata })).toBe(true)
    expect(isEnsembleParticipantAuthoredMessage({ role: 'system', metadata })).toBe(true)
    expect(isEnsembleSideMessageToUser({ role: 'tool', metadata })).toBe(false)
    expect(isEnsembleSideMessageToUser({ role: 'error', metadata })).toBe(false)
  })

  it('moves a User-directed lane id to source provenance without changing wave metadata', () => {
    const laneMetadata = {
      ensembleLaneId: 'lane-1',
      ensembleLaneIntent: 'read' as const,
      ensembleFanoutWaveId: 'wave-1',
      ensembleFanoutLabel: 'User Fan-Out',
      ensembleFanoutCategory: 'user' as const
    }

    expect(sideMessageLaneMetadataForAudience(laneMetadata, true)).toEqual({
      ensembleSourceLaneId: 'lane-1',
      ensembleLaneIntent: 'read',
      ensembleFanoutWaveId: 'wave-1',
      ensembleFanoutLabel: 'User Fan-Out',
      ensembleFanoutCategory: 'user'
    })
    expect(sideMessageLaneMetadataForAudience(laneMetadata, false)).toBe(laneMetadata)
  })
})
