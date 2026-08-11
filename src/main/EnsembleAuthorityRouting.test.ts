import { describe, expect, it } from 'vitest'
import {
  applyQueuedAuthorityRosterSelection,
  collectAuthorityOnlyContinuationCandidateIds,
  preservesInitialPassRoster,
  resolveAuthoritySelection,
  shouldAttachContinuousAuthoritySelectionCheckpoint,
  shouldResummonAuthorityForUnresolvedRouting
} from './EnsembleAuthorityRouting'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../shared/ensembleLimits'
import type { EnsembleParticipant } from './store/types'

const participants: EnsembleParticipant[] = [
  {
    id: 'boss',
    provider: 'claude',
    enabled: true,
    role: 'Boss',
    order: 1,
    instructions: 'Coordinate.',
    permissionPresetId: 'default'
  },
  {
    id: 'worker',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    order: 2,
    instructions: 'Implement.',
    permissionPresetId: 'workspace_write'
  },
  {
    id: 'reviewer',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    order: 3,
    instructions: 'Review.',
    permissionPresetId: 'read_only'
  }
]

describe('resolveAuthoritySelection', () => {
  it('keeps explicitly selected pending roles in selector order and skips the rest', () => {
    const result = resolveAuthoritySelection({
      participantRoles: ['Reviewer', 'Worker'],
      participants,
      pendingParticipants: participants.slice(1),
      callerParticipantId: 'boss'
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.selected.map((participant) => participant.id)).toEqual(['reviewer', 'worker'])
    expect(result.skipped).toEqual([])
  })

  it('rejects an omitted keep-list rather than silently treating it as all participants', () => {
    expect(
      resolveAuthoritySelection({
        participants,
        pendingParticipants: participants.slice(1),
        callerParticipantId: 'boss'
      })
    ).toEqual({ ok: false, error: 'missing_selection' })
  })

  it('rejects a selected participant that is no longer pending', () => {
    expect(
      resolveAuthoritySelection({
        participantIds: ['worker'],
        participants,
        pendingParticipants: [participants[2]],
        callerParticipantId: 'boss'
      })
    ).toEqual({ ok: false, error: 'not_pending_selector', selector: 'worker' })
  })

  it('rejects an ambiguous role rather than selecting an arbitrary participant', () => {
    const duplicateReviewer: EnsembleParticipant = {
      ...participants[2],
      id: 'reviewer-2'
    }
    expect(
      resolveAuthoritySelection({
        participantRoles: ['Reviewer'],
        participants: [...participants, duplicateReviewer],
        pendingParticipants: [participants[2], duplicateReviewer],
        callerParticipantId: 'boss'
      })
    ).toEqual({ ok: false, error: 'ambiguous_selector', selector: 'Reviewer' })
  })

  it('keeps every pending seat in a full-capacity participant panel', () => {
    const fullPanel = Array.from({ length: MAX_ENSEMBLE_PARTICIPANTS }, (_, index) => ({
      id: index === 0 ? 'boss' : `worker-${index}`,
      provider: index === 0 ? ('claude' as const) : ('codex' as const),
      enabled: true,
      role: index === 0 ? 'Boss' : `Worker ${index}`,
      order: index + 1,
      instructions: index === 0 ? 'Coordinate.' : `Implement lane ${index}.`,
      permissionPresetId: index === 0 ? ('default' as const) : ('workspace_write' as const)
    }))
    const pendingParticipants = fullPanel.slice(1)

    const result = resolveAuthoritySelection({
      participantIds: pendingParticipants.map((participant) => participant.id),
      participants: fullPanel,
      pendingParticipants,
      callerParticipantId: 'boss'
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.selected).toHaveLength(MAX_ENSEMBLE_PARTICIPANTS - 1)
    expect(result.skipped).toEqual([])
  })
})

describe('Continuous Boss ownership helpers', () => {
  it('attaches a Continuous selection checkpoint whenever serial seats remain', () => {
    expect(
      shouldAttachContinuousAuthoritySelectionCheckpoint({
        orchestrationMode: 'continuous',
        remainingParticipantCount: 2
      })
    ).toBe(true)
    expect(
      shouldAttachContinuousAuthoritySelectionCheckpoint({
        orchestrationMode: 'continuous',
        remainingParticipantCount: 0
      })
    ).toBe(false)
    expect(
      shouldAttachContinuousAuthoritySelectionCheckpoint({
        orchestrationMode: 'turn_bound',
        remainingParticipantCount: 2
      })
    ).toBe(false)
  })

  it('preserves Turn-bound first-pass roster but lifts Continuous pass 1', () => {
    expect(
      preservesInitialPassRoster({ orchestrationMode: 'turn_bound', continuationPass: 1 })
    ).toBe(true)
    expect(
      preservesInitialPassRoster({ orchestrationMode: 'continuous', continuationPass: 1 })
    ).toBe(false)
    expect(
      preservesInitialPassRoster({ orchestrationMode: 'continuous', continuationPass: 2 })
    ).toBe(false)
  })

  it('re-summons Continuous authority only for unmet selectionRequired checkpoints', () => {
    expect(
      shouldResummonAuthorityForUnresolvedRouting({
        orchestrationMode: 'continuous',
        selectionRequired: true,
        decision: undefined
      })
    ).toBe(true)
    expect(
      shouldResummonAuthorityForUnresolvedRouting({
        orchestrationMode: 'continuous',
        selectionRequired: true,
        decision: 'mentioned'
      })
    ).toBe(false)
    expect(
      shouldResummonAuthorityForUnresolvedRouting({
        orchestrationMode: 'turn_bound',
        selectionRequired: true,
        decision: undefined
      })
    ).toBe(false)
  })

  it('collects authority-only fan-out, yield-return, and optional synthesizer seats', () => {
    expect(
      collectAuthorityOnlyContinuationCandidateIds({
        fannedOutParticipantIds: ['reviewer'],
        fanoutReservedParticipantIds: ['builder'],
        yieldReturnParticipantIds: ['boss', 'worker'],
        synthesizerParticipantId: 'synth'
      }).sort()
    ).toEqual(['boss', 'builder', 'reviewer', 'synth', 'worker'])
  })

  it('does not admit prior speakers alone for authority-only auto-continue', () => {
    expect(
      collectAuthorityOnlyContinuationCandidateIds({
        fannedOutParticipantIds: [],
        fanoutReservedParticipantIds: [],
        yieldReturnParticipantIds: []
      })
    ).toEqual([])
  })
})

describe('applyQueuedAuthorityRosterSelection', () => {
  const displayName = (participant: EnsembleParticipant): string =>
    participant.role || participant.id

  it('filters the next pass narrowing-style, keeping roster order and the queuing authority', () => {
    const outcome = applyQueuedAuthorityRosterSelection({
      queued: {
        participantRoles: ['Reviewer'],
        authorityLabel: 'Boss',
        callerParticipantId: 'boss',
        queuedAtPass: 5
      },
      roster: participants,
      participants,
      displayName
    })

    expect(outcome.applied).toBe(true)
    if (!outcome.applied) return
    expect(outcome.roster.map((participant) => participant.id)).toEqual(['boss', 'reviewer'])
    expect(outcome.note).toBe(
      'Boss selection queued during pass 5 applied: keeping Boss, Reviewer; not dispatching Worker this pass.'
    )
  })

  it('reports an already-matching queue without inventing exclusions', () => {
    const outcome = applyQueuedAuthorityRosterSelection({
      queued: {
        participantIds: ['worker', 'reviewer'],
        authorityLabel: 'Captain',
        callerParticipantId: 'boss',
        queuedAtPass: 2
      },
      roster: participants,
      participants,
      displayName
    })

    expect(outcome.applied).toBe(true)
    if (!outcome.applied) return
    expect(outcome.roster.map((participant) => participant.id)).toEqual([
      'boss',
      'worker',
      'reviewer'
    ])
    expect(outcome.note).toBe(
      'Captain selection queued during pass 2 applied: it already matches this pass (Boss, Worker, Reviewer).'
    )
  })

  it('fails open when a queued selector no longer resolves', () => {
    expect(
      applyQueuedAuthorityRosterSelection({
        queued: {
          participantRoles: ['Ghost'],
          authorityLabel: 'Boss',
          callerParticipantId: 'boss',
          queuedAtPass: 4
        },
        roster: participants,
        participants,
        displayName
      })
    ).toEqual({
      applied: false,
      note: 'Boss selection queued during pass 4 could not be applied ("Ghost" no longer resolves to a participant); continuing with the standard pass.'
    })
  })

  it('fails open when the kept seat is excluded from the formed pass', () => {
    expect(
      applyQueuedAuthorityRosterSelection({
        queued: {
          participantIds: ['worker'],
          authorityLabel: 'Boss',
          callerParticipantId: 'boss',
          queuedAtPass: 3
        },
        roster: participants.filter((participant) => participant.id !== 'worker'),
        participants,
        displayName
      })
    ).toEqual({
      applied: false,
      note: 'Boss selection queued during pass 3 could not be applied ("worker" is not in this pass); continuing with the standard pass.'
    })
  })
})
