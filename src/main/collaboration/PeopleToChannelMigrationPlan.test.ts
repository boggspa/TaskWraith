import { describe, expect, it } from 'vitest'

import type { HumanCollaborationShare, HumanCollaborationSnapshot } from './HumanCollaborationStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import {
  CHANNEL_SCHEMA_VERSION,
  type Channel,
  type ChannelMember,
  type ChannelStoreSnapshot
} from './ChannelStore'
import {
  PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS,
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationChat,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'

const HOST_KEY = 'host-public-key-material'

function share(overrides: Partial<HumanCollaborationShare> = {}): HumanCollaborationShare {
  return {
    shareId: 'share_one',
    chatId: 'chat_one',
    mode: 'comments',
    enabled: true,
    createdAt: 100,
    updatedAt: 200,
    nextSequence: 3,
    participants: [
      {
        collaboratorId: 'collaborator_one',
        displayName: 'Private Person Name',
        publicKeyId: 'collaborator-public-key-material',
        status: 'active',
        joinedAt: 120
      }
    ],
    invites: [
      {
        inviteId: 'invite_one',
        tokenHash: 'legacy-token-hash',
        createdAt: 110,
        expiresAt: 500,
        consumedAt: 120,
        collaboratorId: 'collaborator_one',
        roomId: 'private-room-id'
      }
    ],
    idempotency: { 'collaborator_one:client_one': 'message_one' },
    contributionRules: contributionRulesForPreset('comments'),
    ...overrides
  }
}

function chat(overrides: Partial<PeopleToChannelMigrationChat> = {}): PeopleToChannelMigrationChat {
  return {
    chatId: 'chat_one',
    title: 'Private chat title',
    chatKind: 'single',
    legacyContributions: [
      {
        kind: 'comment',
        messageId: 'message_one',
        shareId: 'share_one',
        collaboratorId: 'collaborator_one',
        clientMessageId: 'client_one',
        sequence: 1,
        contentHash: 'a'.repeat(64)
      },
      {
        kind: 'external-seat-turn',
        messageId: 'message_two',
        shareId: 'share_one',
        collaboratorId: 'collaborator_one',
        clientMessageId: 'client_two',
        sequence: 2,
        contentHash: 'b'.repeat(64)
      }
    ],
    ...overrides
  }
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: 'channel_existing',
    chatId: 'chat_one',
    ownerMemberId: 'owner_existing',
    status: 'active',
    createdAt: 50,
    updatedAt: 60,
    membershipRevision: 2,
    messageCount: 4,
    display: {
      title: 'Existing private title',
      status: 'active',
      memberCount: 2,
      messageCount: 4
    },
    ...overrides
  }
}

function channelMember(overrides: Partial<ChannelMember> = {}): ChannelMember {
  return {
    memberId: 'owner_existing',
    channelId: 'channel_existing',
    kind: 'human',
    displayName: 'Host',
    identityPublicKey: HOST_KEY,
    status: 'active',
    joinedAt: 50,
    ...overrides
  } as ChannelMember
}

function channelSnapshot(
  channels: Channel[] = [],
  members: ChannelMember[] = []
): ChannelStoreSnapshot {
  return {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
    channels,
    members,
    invites: []
  }
}

function input(
  overrides: Partial<PeopleToChannelMigrationPlanInput> = {}
): PeopleToChannelMigrationPlanInput {
  return {
    hostIdentityPublicKey: HOST_KEY,
    people: { shares: [share()] },
    channels: channelSnapshot(),
    chats: [chat()],
    ...overrides
  }
}

describe('PeopleToChannelMigrationPlan', () => {
  it('builds a deterministic, content-free create plan without mutating its inputs', () => {
    const source = input()
    const before = JSON.stringify(source)

    const plan = createPeopleToChannelMigrationPlan(source)
    const again = createPeopleToChannelMigrationPlan(source)

    expect(plan).toEqual(again)
    expect(JSON.stringify(source)).toBe(before)
    expect(plan.cutoverDecisions).toEqual(PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS)
    expect(plan.summary).toEqual({
      shares: 1,
      create: 1,
      merge: 0,
      retainLegacy: 0,
      blocked: 0,
      requiresResolution: 1
    })

    const entry = plan.entries[0]
    expect(entry).toMatchObject({
      disposition: 'create',
      readiness: 'requires_resolution',
      blockers: [],
      requirements: ['legacy_invite_retirement', 'legacy_projection_history'],
      source: {
        shareId: 'share_one',
        chatId: 'chat_one',
        participantCounts: { active: 1, pending: 0, revoked: 0 },
        inviteCount: 1,
        pendingInviteCount: 0,
        idempotencyEntryCount: 1,
        history: {
          commentCount: 1,
          externalSeatTurnCount: 1,
          highestSequence: 2
        }
      },
      target: {
        channelId: 'share_one',
        chatId: 'chat_one',
        existingChannel: false,
        memberMappings: [
          {
            sourceCollaboratorId: 'collaborator_one',
            targetMemberId: 'collaborator_one',
            sourceStatus: 'active',
            targetStatus: 'active',
            reusedExistingMember: false
          }
        ]
      }
    })
    expect(entry.target?.ownerMemberId).toMatch(/^owner_[a-f0-9]{32}$/)

    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain('Private chat title')
    expect(serialized).not.toContain('Private Person Name')
    expect(serialized).not.toContain('private-room-id')
    expect(serialized).not.toContain('collaborator-public-key-material')
    expect(serialized).not.toContain(HOST_KEY)
    expect(serialized).not.toContain('legacy-token-hash')
  })

  it('is stable across source array ordering and changes when title or evidence changes', () => {
    const firstShare = share({
      participants: [
        ...share().participants,
        {
          collaboratorId: 'collaborator_two',
          displayName: 'Second Person',
          publicKeyId: 'second-public-key',
          status: 'revoked',
          revokedAt: 180
        }
      ],
      invites: [
        ...share().invites,
        {
          inviteId: 'invite_two',
          tokenHash: 'old-token',
          createdAt: 90,
          expiresAt: 95,
          collaboratorId: 'collaborator_two',
          roomId: 'old-room'
        }
      ]
    })
    const ordered = input({ people: { shares: [firstShare] } })
    const reordered = input({
      people: {
        shares: [
          {
            ...firstShare,
            participants: [...firstShare.participants].reverse(),
            invites: [...firstShare.invites].reverse()
          }
        ]
      },
      chats: [
        {
          ...chat(),
          legacyContributions: [...(chat().legacyContributions ?? [])].reverse()
        }
      ]
    })

    const first = createPeopleToChannelMigrationPlan(ordered)
    const second = createPeopleToChannelMigrationPlan(reordered)
    expect(second).toEqual(first)

    const titleChanged = createPeopleToChannelMigrationPlan(
      input({ people: { shares: [firstShare] }, chats: [chat({ title: 'A changed title' })] })
    )
    expect(titleChanged.sourceDigest).not.toBe(first.sourceDigest)

    const evidenceChanged = createPeopleToChannelMigrationPlan(
      input({
        people: { shares: [firstShare] },
        chats: [
          chat({
            legacyContributions: [
              {
                ...(chat().legacyContributions ?? [])[0],
                contentHash: 'c'.repeat(64)
              }
            ]
          })
        ]
      })
    )
    expect(evidenceChanged.sourceDigest).not.toBe(first.sourceDigest)
  })

  it('maps a People identity onto an existing Channel member without replacing Channel state', () => {
    const existingChannel = channel()
    const existingHuman = channelMember({
      memberId: 'existing_human',
      displayName: 'Channel-side name',
      identityPublicKey: 'collaborator-public-key-material',
      roomId: 'existing-channel-room'
    })
    const plan = createPeopleToChannelMigrationPlan(
      input({
        channels: channelSnapshot([existingChannel], [channelMember(), existingHuman])
      })
    )

    const entry = plan.entries[0]
    expect(entry.disposition).toBe('merge')
    expect(entry.blockers).toEqual([])
    expect(entry.requirements).toEqual([
      'existing_channel_merge_manifest',
      'legacy_invite_retirement',
      'legacy_projection_history'
    ])
    expect(entry.target).toMatchObject({
      channelId: 'channel_existing',
      ownerMemberId: 'owner_existing',
      existingChannel: true,
      memberMappings: [
        {
          sourceCollaboratorId: 'collaborator_one',
          targetMemberId: 'existing_human',
          reusedExistingMember: true
        }
      ]
    })
    expect(JSON.stringify(entry.target)).not.toContain('existing-channel-room')
  })

  it('records every authority and presentation feature that Channels cannot yet represent', () => {
    const restricted = share({
      mode: 'readOnly',
      contributionRules: {
        ...contributionRulesForPreset('readOnly'),
        maxContributionBytes: 1024,
        allowedCollaboratorIds: ['collaborator_one'],
        auditLevel: 'detailed'
      },
      requiresHostApproval: true,
      fullHistory: true,
      participants: [
        {
          ...share().participants[0],
          status: 'pending',
          seatOrder: 4,
          colorIndex: 2,
          seatDisabled: true
        }
      ],
      invites: [
        {
          inviteId: 'pending_invite',
          tokenHash: 'pending-token',
          createdAt: 200,
          expiresAt: 500,
          roomId: 'pending-room'
        }
      ]
    })
    const plan = createPeopleToChannelMigrationPlan(input({ people: { shares: [restricted] } }))

    expect(plan.entries[0]).toMatchObject({
      disposition: 'create',
      readiness: 'requires_resolution',
      blockers: [],
      requirements: [
        'human_policy_projection',
        'legacy_invite_retirement',
        'legacy_projection_history',
        'member_presentation_projection',
        'pending_admission_reissue'
      ],
      source: {
        participantCounts: { active: 0, pending: 1, revoked: 0 },
        pendingInviteCount: 1,
        requiresHostApproval: true,
        fullHistory: true,
        policy: {
          preset: 'readOnly',
          maxContributionBytes: 1024,
          allowedCollaboratorIds: ['collaborator_one'],
          auditLevel: 'detailed'
        }
      }
    })
  })

  it('fails closed on malformed or ambiguous People sources', () => {
    const malformed: HumanCollaborationSnapshot = {
      shares: [
        share({ shareId: 'not/path-safe', invites: [] }),
        share({
          shareId: 'share_two',
          participants: [
            ...share().participants,
            {
              ...share().participants[0],
              collaboratorId: 'collaborator_two'
            }
          ]
        })
      ]
    }
    const plan = createPeopleToChannelMigrationPlan(input({ people: malformed }))

    expect(plan.entries).toHaveLength(2)
    expect(plan.entries[0].disposition).toBe('blocked')
    expect(plan.entries[0].blockers).toEqual(
      expect.arrayContaining([
        'duplicate_active_share_for_chat',
        'invalid_source_identifier',
        'missing_active_member_room'
      ])
    )
    expect(plan.entries[1].blockers).toEqual(
      expect.arrayContaining(['duplicate_active_share_for_chat', 'duplicate_participant_identity'])
    )
  })

  it('blocks ambiguous newest room bindings but preserves a standalone revocation', () => {
    const ambiguousRoom = share({
      invites: [
        {
          ...share().invites[0],
          inviteId: 'invite_a',
          roomId: 'room_a',
          createdAt: 300
        },
        {
          ...share().invites[0],
          inviteId: 'invite_b',
          roomId: 'room_b',
          createdAt: 300
        }
      ]
    })
    const ambiguousPlan = createPeopleToChannelMigrationPlan(
      input({ people: { shares: [ambiguousRoom] } })
    )
    expect(ambiguousPlan.entries[0].blockers).toContain('ambiguous_active_member_room')

    const revoked = share({
      participants: [
        {
          ...share().participants[0],
          status: 'revoked',
          revokedAt: 250
        }
      ]
    })
    const revokedPlan = createPeopleToChannelMigrationPlan(input({ people: { shares: [revoked] } }))
    expect(revokedPlan.entries[0].disposition).toBe('create')
    expect(revokedPlan.entries[0].blockers).not.toContain('target_revocation_conflict')
    expect(revokedPlan.entries[0].target?.memberMappings[0]).toMatchObject({
      sourceStatus: 'revoked',
      targetStatus: 'revoked'
    })
  })

  it('blocks non-General sources and invalid legacy evidence', () => {
    const plan = createPeopleToChannelMigrationPlan(
      input({
        chats: [
          chat({
            chatKind: 'ensemble',
            legacyContributions: [
              {
                ...(chat().legacyContributions ?? [])[0],
                contentHash: 'not-a-sha256'
              }
            ]
          })
        ]
      })
    )

    expect(plan.entries[0]).toMatchObject({
      disposition: 'blocked',
      readiness: 'blocked'
    })
    expect(plan.entries[0].blockers).toEqual([
      'invalid_legacy_evidence',
      'source_chat_not_channel_eligible'
    ])
  })

  it('blocks target authority conflicts and a closed Channel', () => {
    const existingChannel = channel({
      status: 'closed',
      display: { ...channel().display, status: 'closed' }
    })
    const plan = createPeopleToChannelMigrationPlan(
      input({
        channels: channelSnapshot(
          [existingChannel],
          [
            channelMember({ identityPublicKey: 'different-host-key' }),
            channelMember({
              memberId: 'revoked_identity',
              identityPublicKey: 'collaborator-public-key-material',
              status: 'revoked',
              revokedAt: 90
            })
          ]
        )
      })
    )

    expect(plan.entries[0].blockers).toEqual([
      'target_channel_closed',
      'target_identity_revoked',
      'target_owner_identity_mismatch'
    ])
  })

  it('blocks a merge that would exceed the eight-member ceiling', () => {
    const existingMembers: ChannelMember[] = [channelMember()]
    for (let index = 1; index < 8; index += 1) {
      existingMembers.push(
        channelMember({
          memberId: `existing_${index}`,
          displayName: `Existing ${index}`,
          identityPublicKey: `existing-key-${index}`
        })
      )
    }
    const plan = createPeopleToChannelMigrationPlan(
      input({
        channels: channelSnapshot(
          [channel({ display: { ...channel().display, memberCount: 8 } })],
          existingMembers
        )
      })
    )

    expect(plan.entries[0].blockers).toContain('channel_capacity_exceeded')
    expect(plan.entries[0].disposition).toBe('blocked')
  })

  it('retains disabled People records without proposing a target', () => {
    const disabled = share({
      enabled: false,
      participants: [
        {
          ...share().participants[0],
          status: 'revoked',
          revokedAt: 300
        }
      ]
    })
    const plan = createPeopleToChannelMigrationPlan(input({ people: { shares: [disabled] } }))

    expect(plan.entries[0]).toMatchObject({
      disposition: 'retain_legacy',
      readiness: 'ready',
      target: null,
      blockers: [],
      requirements: []
    })
    expect(plan.summary.retainLegacy).toBe(1)
  })
})
