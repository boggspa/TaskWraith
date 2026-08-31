import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../store/types'
import {
  formatAssistantGroupMentionRoutingNotice,
  resolveBackgroundMentionRouting,
  resolveAssistantMentionRoutingPlan,
  resolveEnsembleCommunicationAudience,
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
    expect(plan.hasAuthorityGroupRoute).toBe(false)
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
    expect(plan.hasAuthorityGroupRoute).toBe(false)
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

  it('keeps permitted authority groups collective and excludes only the caller', () => {
    const captain2 = participant('captain-2', 9, 'worker')
    const authority = {
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain', captain2.id]
    }
    const captains = resolveAssistantMentionRoutingPlan({
      text: '@Captains decide together.',
      participants: [...ROSTER, captain2],
      callerParticipantId: 'boss',
      canRouteGroups: true,
      excludedGroupParticipantIds: new Set(['boss', 'captain', captain2.id]),
      authority
    })
    expect(captains.participantMatches.map((match) => match.participant.id)).toEqual([
      'captain',
      captain2.id
    ])
    expect(captains.hasAuthorityGroupRoute).toBe(true)

    const management = resolveAssistantMentionRoutingPlan({
      text: '@Management review this.',
      participants: [...ROSTER, captain2],
      callerParticipantId: 'captain',
      canRouteGroups: true,
      excludedGroupParticipantIds: new Set(['boss', 'captain', captain2.id]),
      authority
    })
    expect(management.participantMatches.map((match) => match.participant.id)).toEqual([
      'boss',
      captain2.id
    ])
    expect(management.hasAuthorityGroupRoute).toBe(true)
  })
})

describe('formatAssistantGroupMentionRoutingNotice', () => {
  it.each([
    [
      'authority_required' as const,
      '@-mention: @Workers group routing requires Boss/Captain fan-out authority; no turns appended.'
    ],
    [
      'outside_dm_scope' as const,
      '@-mention: @Workers is outside this user-targeted round; no group turns appended.'
    ],
    [
      'no_eligible_targets' as const,
      '@-mention: @Workers matched no enabled eligible peer seats; no turns appended.'
    ]
  ])('formats %s as a visible routing boundary', (reason, expected) => {
    expect(
      formatAssistantGroupMentionRoutingNotice({ group: 'workers', token: '@Workers', reason })
    ).toBe(expected)
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

  it('expands configured authority selectors without trusting role labels', () => {
    expect(
      resolveEnsembleCommunicationTargets({
        selectors: ['@Captains', '@Management'],
        participants: ROSTER,
        senderParticipantId: 'worker-1',
        authority: { bossmanParticipantId: 'boss', captainParticipantIds: ['captain'] }
      }).map((participant) => participant.id)
    ).toEqual(['captain', 'boss'])
  })
})

describe('resolveEnsembleCommunicationAudience', () => {
  it.each(['@User', 'user', '@HUMAN', 'You'])(
    'recognizes the deliberate User alias %s',
    (alias) => {
      expect(
        resolveEnsembleCommunicationAudience({
          selectors: [alias],
          participants: ROSTER,
          senderParticipantId: 'worker-1'
        })
      ).toEqual({ participants: [], toUser: true })
    }
  )

  it('keeps @All roster-only and never adds the User implicitly', () => {
    const audience = resolveEnsembleCommunicationAudience({
      selectors: ['@All'],
      participants: ROSTER,
      senderParticipantId: 'worker-1'
    })

    expect(audience.toUser).toBe(false)
    expect(audience.participants.map((participant) => participant.id)).toEqual([
      'boss',
      'captain',
      'scout-1',
      'worker-2',
      'grok-bg',
      'any-seat'
    ])
  })

  it('dedupes mixed User aliases while preserving valid participant recipients', () => {
    const audience = resolveEnsembleCommunicationAudience({
      selectors: ['@User', '@worker-2', '@You', '@Unknown', '@claude-disabled'],
      participants: ROSTER,
      senderParticipantId: 'boss'
    })

    expect(audience.toUser).toBe(true)
    expect(audience.participants.map((participant) => participant.id)).toEqual(['worker-2'])
  })

  it('keeps an unknown-only audience unresolved for the caller to reject', () => {
    expect(
      resolveEnsembleCommunicationAudience({
        selectors: ['@SomeoneElse'],
        participants: ROSTER,
        senderParticipantId: 'boss'
      })
    ).toEqual({ participants: [], toUser: false })
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
      text: '@Workers and @Management decide while @grok-bg collects traces.',
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
