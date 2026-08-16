import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import {
  resolveBackgroundMentionRouting,
  resolveAssistantMentionRoutingPlan,
  resolveEnsembleCommunicationTargets
} from './EnsembleGroupMentionRouting'

function participant(
  id: string,
  order: number,
  stageRole: EnsembleParticipant['stageRole'],
  patch: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider: id.startsWith('grok') ? 'grok' : id.startsWith('claude') ? 'claude' : 'codex',
    enabled: true,
    role: id,
    instructions: '',
    order,
    stageRole,
    ...patch
  } as EnsembleParticipant
}

const ROSTER = [
  participant('boss', 1, 'worker'),
  participant('captain', 2, 'reviewer'),
  participant('scout-1', 3, 'scout'),
  participant('worker-1', 4, 'worker'),
  participant('worker-2', 5, 'worker'),
  participant('grok-bg', 6, 'background'),
  participant('any-seat', 7, undefined),
  participant('claude-disabled', 8, 'reviewer', { enabled: false })
]

describe('resolveAssistantMentionRoutingPlan', () => {
  it('keeps direct peer mentions but leaves an ordinary agent group tag presentation-only', () => {
    const plan = resolveAssistantMentionRoutingPlan({
      text: '@Workers compare with @captain.',
      participants: ROSTER,
      callerParticipantId: 'scout-1',
      canRouteGroups: false
    })

    expect(plan.participantMatches.map((match) => match.participant.id)).toEqual(['captain'])
    expect(plan.groupNotices).toEqual([
      { group: 'workers', token: '@Workers', reason: 'authority_required' }
    ])
  })

  it('expands an authorised group in roster order while excluding speaker and authority seats', () => {
    const plan = resolveAssistantMentionRoutingPlan({
      text: '@All validate this, then @BG run the soak.',
      participants: ROSTER,
      callerParticipantId: 'boss',
      canRouteGroups: true,
      excludedGroupParticipantIds: new Set(['boss', 'captain'])
    })

    expect(plan.participantMatches.map((match) => match.participant.id)).toEqual([
      'scout-1',
      'worker-1',
      'worker-2',
      'grok-bg',
      'any-seat',
      'grok-bg'
    ])
    expect(plan.groupNotices).toEqual([])
  })

  it('never widens a user-targeted DM, even for an authorised caller', () => {
    const plan = resolveAssistantMentionRoutingPlan({
      text: '@All join this.',
      participants: ROSTER,
      callerParticipantId: 'boss',
      canRouteGroups: true,
      dmTargetParticipantId: 'boss'
    })

    expect(plan.participantMatches).toEqual([])
    expect(plan.groupNotices).toEqual([{ group: 'all', token: '@All', reason: 'outside_dm_scope' }])
  })

  it('reports an authorised group with no eligible peer targets once', () => {
    const plan = resolveAssistantMentionRoutingPlan({
      text: '@Reviewers then @Reviewers again.',
      participants: ROSTER,
      callerParticipantId: 'boss',
      canRouteGroups: true,
      excludedGroupParticipantIds: new Set(['captain'])
    })

    expect(plan.participantMatches).toEqual([])
    expect(plan.groupNotices).toEqual([
      { group: 'reviewers', token: '@Reviewers', reason: 'no_eligible_targets' }
    ])
  })
})

describe('resolveEnsembleCommunicationTargets', () => {
  it('expands @All to every enabled recipient except the sender, including authority seats', () => {
    expect(
      resolveEnsembleCommunicationTargets({
        selectors: ['@All'],
        participants: ROSTER,
        senderParticipantId: 'worker-1'
      }).map((participant) => participant.id)
    ).toEqual(['boss', 'captain', 'scout-1', 'worker-2', 'grok-bg', 'any-seat'])
  })

  it('expands stage selectors and dedupes mixed explicit recipients in selector order', () => {
    expect(
      resolveEnsembleCommunicationTargets({
        selectors: ['@BG', '@worker-2', '@Workers'],
        participants: ROSTER,
        senderParticipantId: 'boss'
      }).map((participant) => participant.id)
    ).toEqual(['grok-bg', 'worker-2', 'worker-1'])
  })

  it('ignores unknown and disabled selectors and returns empty when nothing resolves', () => {
    expect(
      resolveEnsembleCommunicationTargets({
        selectors: ['@Unknown', '@claude-disabled'],
        participants: ROSTER,
        senderParticipantId: 'boss'
      })
    ).toEqual([])
  })
})

describe('resolveBackgroundMentionRouting', () => {
  const backgroundRoster = [
    ...ROSTER,
    participant('grok-bg-2', 9, 'background'),
    participant('disabled-bg', 10, 'background', { enabled: false })
  ]

  it('expands @BG and @All to every enabled background seat without ambiguity', () => {
    const plan = resolveBackgroundMentionRouting({
      text: '@BG collect traces, then @All inspect the result.',
      participants: backgroundRoster
    })

    expect([...plan.participantIds]).toEqual(['grok-bg', 'grok-bg-2'])
    expect(plan.ambiguities).toEqual([])
  })

  it('ignores foreground-only groups and preserves direct background aliases', () => {
    const plan = resolveBackgroundMentionRouting({
      text: '@Workers implement this while @grok-bg collects traces.',
      participants: backgroundRoster
    })

    expect([...plan.participantIds]).toEqual(['grok-bg'])
    expect(plan.ambiguities).toEqual([])
  })

  it('keeps ambiguous direct provider aliases unresolved', () => {
    const plan = resolveBackgroundMentionRouting({
      text: '@grok collect traces.',
      participants: backgroundRoster
    })

    expect(plan.participantIds.size).toBe(0)
    expect(plan.ambiguities).toHaveLength(1)
    expect([
      plan.ambiguities[0].participant.id,
      ...(plan.ambiguities[0].ambiguousAmong || []).map((candidate) => candidate.id)
    ]).toEqual(['grok-bg', 'grok-bg-2'])
  })
})
