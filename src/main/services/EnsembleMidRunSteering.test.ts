import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant, EnsembleParticipantStatus } from '../store/types'
import { planEnsembleMidRunSteeringBoundary } from './EnsembleMidRunSteering'

function participant(
  id: string,
  order: number,
  overrides: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider: id === 'claude' ? 'claude' : 'codex',
    enabled: true,
    role: id,
    instructions: '',
    order,
    model: `${id}-model`,
    permissionPresetId: 'read_only',
    ...overrides
  }
}

function statuses(
  entries: Array<[string, EnsembleParticipantStatus]>
): Map<string, EnsembleParticipantStatus> {
  return new Map(entries)
}

describe('planEnsembleMidRunSteeringBoundary', () => {
  it('prefers the most recent eligible seat without consuming hop state', () => {
    const result = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1'],
      participants: [participant('codex', 1), participant('claude', 2)],
      participantStatusById: statuses([
        ['codex', 'answered'],
        ['claude', 'answered']
      ]),
      preferredParticipantIds: ['claude', 'codex']
    })

    expect(result.participant?.id).toBe('claude')
    expect(result.state?.attemptedParticipantIds).toEqual(new Set(['claude']))
    expect(result.exhausted).toBe(false)
  })

  it('tries another seat for the same pending signature after a rejection', () => {
    const first = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1'],
      participants: [participant('codex', 1), participant('claude', 2)],
      participantStatusById: statuses([
        ['codex', 'answered'],
        ['claude', 'answered']
      ]),
      preferredParticipantIds: ['claude', 'codex']
    })
    const second = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1'],
      participants: [participant('codex', 1), participant('claude', 2)],
      participantStatusById: statuses([
        ['codex', 'answered'],
        ['claude', 'failed']
      ]),
      preferredParticipantIds: ['claude', 'codex'],
      previousState: first.state
    })

    expect(second.participant?.id).toBe('codex')
    expect(second.state?.attemptedParticipantIds).toEqual(new Set(['claude', 'codex']))
  })

  it('resets attempts when a later interjection changes the pending signature', () => {
    const first = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1'],
      participants: [participant('codex', 1)],
      participantStatusById: statuses([['codex', 'answered']]),
      preferredParticipantIds: ['codex']
    })
    const next = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1', 'entry-2'],
      participants: [participant('codex', 1)],
      participantStatusById: statuses([['codex', 'answered']]),
      preferredParticipantIds: ['codex'],
      previousState: first.state
    })

    expect(next.participant?.id).toBe('codex')
    expect(next.state?.attemptedParticipantIds).toEqual(new Set(['codex']))
  })

  it('excludes background, disabled, targeted-away, and unavailable seats', () => {
    const result = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1'],
      participants: [
        participant('background', 1, { stageRole: 'background' }),
        participant('disabled', 2, { enabled: false }),
        participant('codex', 3),
        participant('claude', 4)
      ],
      participantStatusById: statuses([
        ['codex', 'unreachable'],
        ['claude', 'answered']
      ]),
      preferredParticipantIds: ['background', 'codex', 'claude'],
      dmTargetParticipantId: 'claude',
      unavailableParticipantIds: new Set(['codex'])
    })

    expect(result.participant?.id).toBe('claude')
  })

  it('allows skipped seats so an empty-result round can still receive a user interjection', () => {
    const result = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: ['entry-1'],
      participants: [participant('claude', 1)],
      participantStatusById: statuses([['claude', 'skipped']]),
      preferredParticipantIds: ['claude']
    })

    expect(result.participant?.id).toBe('claude')
    expect(result.exhausted).toBe(false)
  })
})
