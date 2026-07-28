import { describe, expect, it } from 'vitest'
import { resolveAuthoritySelection } from './EnsembleAuthorityRouting'
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
})
