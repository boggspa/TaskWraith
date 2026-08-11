import { describe, expect, it } from 'vitest'

import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import {
  CHANNEL_SCHEMA_VERSION,
  type Channel,
  type ChannelMember,
  type ChannelStoreSnapshot
} from './ChannelStore'
import {
  PeopleToChannelMigrationMaterializationError,
  materializePeopleToChannels
} from './PeopleToChannelMigrationMaterializer'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'

const HOST_KEY = Buffer.alloc(32, 5).toString('base64')
const ACTIVE_KEY = Buffer.alloc(32, 6).toString('base64')
const PENDING_KEY = Buffer.alloc(32, 7).toString('base64')
const REVOKED_KEY = Buffer.alloc(32, 8).toString('base64')

function share(overrides: Partial<HumanCollaborationShare> = {}): HumanCollaborationShare {
  return {
    shareId: 'share_one',
    chatId: 'chat_one',
    mode: 'comments',
    enabled: true,
    createdAt: 100,
    updatedAt: 300,
    nextSequence: 1,
    participants: [
      {
        collaboratorId: 'active_person',
        displayName: 'Active Person',
        publicKeyId: ACTIVE_KEY,
        status: 'active',
        joinedAt: 150,
        seatOrder: 2,
        colorIndex: 3
      },
      {
        collaboratorId: 'pending_person',
        displayName: 'Pending Person',
        publicKeyId: PENDING_KEY,
        status: 'pending',
        seatOrder: 1,
        colorIndex: 5,
        seatDisabled: true
      },
      {
        collaboratorId: 'revoked_person',
        displayName: 'Revoked Person',
        publicKeyId: REVOKED_KEY,
        status: 'revoked',
        revokedAt: 250,
        seatOrder: 4,
        colorIndex: 7,
        seatDisabled: true
      }
    ],
    invites: [
      {
        inviteId: 'active_invite',
        tokenHash: 'private-active-token-hash',
        createdAt: 120,
        expiresAt: 2_000,
        consumedAt: 150,
        collaboratorId: 'active_person',
        roomId: 'active_room'
      },
      {
        inviteId: 'open_invite',
        tokenHash: 'private-open-token-hash',
        createdAt: 900,
        expiresAt: 2_000,
        roomId: 'old_open_room'
      },
      {
        inviteId: 'expired_invite',
        tokenHash: 'private-expired-token-hash',
        createdAt: 400,
        expiresAt: 800,
        roomId: 'expired_room'
      }
    ],
    idempotency: {},
    contributionRules: contributionRulesForPreset('requestHostAction'),
    requiresHostApproval: true,
    fullHistory: true,
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
    reference: { kind: 'chat', id: 'chat_one' },
    display: {
      title: 'Existing Channel',
      status: 'active',
      memberCount: 2,
      messageCount: 4
    },
    ...overrides
  }
}

function member(overrides: Partial<ChannelMember> = {}): ChannelMember {
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

function source(
  overrides: Partial<PeopleToChannelMigrationPlanInput> = {}
): PeopleToChannelMigrationPlanInput {
  return {
    hostIdentityPublicKey: HOST_KEY,
    people: { shares: [share()] },
    channels: channelSnapshot(),
    chats: [{ chatId: 'chat_one', title: 'Private Source Title', chatKind: 'ensemble' }],
    ...overrides
  }
}

describe('PeopleToChannelMigrationMaterializer', () => {
  it('builds a deterministic create batch without importing pending invites or tokens', () => {
    const inventory = source()
    const plan = createPeopleToChannelMigrationPlan(inventory)
    const before = JSON.stringify(inventory)
    const materialized = materializePeopleToChannels({
      plan,
      source: inventory,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })
    const again = materializePeopleToChannels({
      plan,
      source: inventory,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })

    expect(materialized).toEqual(again)
    expect(JSON.stringify(inventory)).toBe(before)
    expect(materialized).toMatchObject({
      planId: plan.planId,
      sourceDigest: plan.sourceDigest,
      migrationAt: 1_000,
      migratedShareIds: ['share_one'],
      retainedShareIds: [],
      mutations: [
        {
          mode: 'create',
          beforeDigest: null,
          channel: {
            channelId: 'share_one',
            chatId: 'chat_one',
            status: 'active',
            membershipRevision: 3,
            messageCount: 0,
            reference: { kind: 'chat', id: 'chat_one' },
            display: {
              title: 'Private Source Title',
              memberCount: 2,
              messageCount: 0
            }
          },
          invites: []
        }
      ],
      pendingAdmissionReissues: [
        {
          sourceShareId: 'share_one',
          channelId: 'share_one',
          pendingCollaboratorIds: ['pending_person'],
          pendingCollaboratorLabels: [
            { sourceCollaboratorId: 'pending_person', recipientLabel: 'Pending Person' }
          ],
          pendingMemberPresentations: [
            {
              sourceCollaboratorId: 'pending_person',
              presentation: { seatOrder: 1, colorIndex: 5, seatDisabled: true }
            }
          ],
          openInviteCount: 1,
          policy: {
            requiresHostApproval: true,
            fullHistory: true
          }
        }
      ]
    })
    expect(materialized.materializationDigest).toMatch(/^[a-f0-9]{64}$/)
    const members = materialized.mutations[0].members
    expect(members).toHaveLength(3)
    expect(
      members.find((entry) => entry.memberId === plan.entries[0].target!.ownerMemberId)
    ).toMatchObject({
      displayName: 'Host Person',
      identityPublicKey: HOST_KEY,
      status: 'active'
    })
    expect(members.find((entry) => entry.identityPublicKey === ACTIVE_KEY)).toMatchObject({
      status: 'active',
      roomId: 'active_room',
      joinedAt: 150,
      presentation: { seatOrder: 2, colorIndex: 3 }
    })
    expect(members.find((entry) => entry.identityPublicKey === REVOKED_KEY)).toMatchObject({
      status: 'revoked',
      revokedAt: 250,
      presentation: { seatOrder: 4, colorIndex: 7, seatDisabled: true }
    })
    expect(members.some((entry) => entry.identityPublicKey === PENDING_KEY)).toBe(false)
    expect(materialized.policies).toHaveLength(1)
    expect(materialized.policies[0]).toMatchObject({
      sourceCollaboratorId: 'active_person',
      requiresHostApproval: true,
      fullHistory: true,
      rules: { preset: 'requestHostAction', providerDispatch: 'never' }
    })

    const serialized = JSON.stringify(materialized.pendingAdmissionReissues)
    expect(serialized).not.toContain('private-open-token-hash')
    expect(serialized).not.toContain('old_open_room')
    expect(serialized).not.toContain('private-expired-token-hash')
  })

  it('materializes unshared General chats and recognizes existing General Channels', () => {
    const inventory = source({
      people: { shares: [] },
      chats: [
        {
          chatId: 'general_new',
          title: 'New General',
          scope: 'global',
          chatKind: 'single'
        },
        {
          chatId: 'general_ensemble',
          title: 'Global ensemble',
          scope: 'global',
          chatKind: 'ensemble'
        }
      ]
    })
    const plan = createPeopleToChannelMigrationPlan(inventory)
    const materialized = materializePeopleToChannels({
      plan,
      source: inventory,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })

    expect(materialized).toMatchObject({
      migratedShareIds: [],
      retainedShareIds: [],
      generalChatIds: ['general_new'],
      backfilledGeneralChatIds: ['general_new'],
      existingGeneralChatIds: []
    })
    expect(materialized.mutations).toHaveLength(1)
    expect(materialized.mutations[0]).toMatchObject({
      mode: 'create',
      beforeDigest: null,
      channel: {
        channelId: expect.stringMatching(/^channel_[a-f0-9]{32}$/),
        chatId: 'general_new',
        membershipRevision: 1,
        messageCount: 0,
        display: { title: 'New General', memberCount: 1, messageCount: 0 }
      },
      members: [
        {
          memberId: expect.stringMatching(/^owner_[a-f0-9]{32}$/),
          displayName: 'Host Person',
          identityPublicKey: HOST_KEY,
          status: 'active'
        }
      ],
      invites: []
    })

    const existingChannel = channel({ chatId: 'general_existing' })
    const existingInventory = source({
      people: { shares: [] },
      chats: [{ chatId: 'general_existing', title: 'Existing', scope: 'global' }],
      channels: channelSnapshot([existingChannel], [member()])
    })
    const existingMaterialized = materializePeopleToChannels({
      plan: createPeopleToChannelMigrationPlan(existingInventory),
      source: existingInventory,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })
    expect(existingMaterialized).toMatchObject({
      mutations: [],
      generalChatIds: ['general_existing'],
      backfilledGeneralChatIds: [],
      existingGeneralChatIds: ['general_existing']
    })
  })

  it('merges source presentation into an existing identity without dropping host-only state', () => {
    const existingChannel = channel()
    const existingMember = member({
      memberId: 'member_existing',
      displayName: 'Existing Name',
      identityPublicKey: ACTIVE_KEY,
      roomId: 'existing_room',
      presentation: { seatOrder: 2, seatDisabled: true }
    })
    const people = share({
      participants: [share().participants[0]],
      invites: [share().invites[0]],
      contributionRules: contributionRulesForPreset('comments'),
      requiresHostApproval: undefined,
      fullHistory: undefined
    })
    const inventory = source({
      people: { shares: [people] },
      channels: channelSnapshot([existingChannel], [member(), existingMember])
    })
    const plan = createPeopleToChannelMigrationPlan(inventory)
    const materialized = materializePeopleToChannels({
      plan,
      source: inventory,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })

    expect(materialized.mutations[0]).toMatchObject({
      mode: 'merge',
      beforeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      channel: existingChannel,
      members: [existingMember, member()]
    })
    expect(materialized.policies).toMatchObject([
      {
        channelId: 'channel_existing',
        memberId: 'member_existing',
        sourceCollaboratorId: 'active_person'
      }
    ])
    expect(
      materialized.mutations[0].members.find((entry) => entry.memberId === 'member_existing')
    ).toMatchObject({
      presentation: { seatOrder: 2, colorIndex: 3, seatDisabled: true }
    })

    const conflictingPeople = share({
      participants: [{ ...share().participants[0], seatOrder: 6 }],
      invites: [share().invites[0]],
      contributionRules: contributionRulesForPreset('comments'),
      requiresHostApproval: undefined,
      fullHistory: undefined
    })
    const conflictingInventory = source({
      people: { shares: [conflictingPeople] },
      channels: channelSnapshot([existingChannel], [member(), existingMember])
    })
    expect(() =>
      materializePeopleToChannels({
        plan: createPeopleToChannelMigrationPlan(conflictingInventory),
        source: conflictingInventory,
        hostDisplayName: 'Host Person',
        migrationAt: 1_000
      })
    ).toThrow(/presentation conflicts/)
  })

  it('adds a new merge member while preserving existing messages and authority', () => {
    const existingChannel = channel({
      display: { ...channel().display, memberCount: 1 }
    })
    const people = share({
      participants: [share().participants[0]],
      invites: [share().invites[0]],
      contributionRules: contributionRulesForPreset('comments'),
      requiresHostApproval: undefined,
      fullHistory: undefined
    })
    const inventory = source({
      people: { shares: [people] },
      channels: channelSnapshot([existingChannel], [member()])
    })
    const plan = createPeopleToChannelMigrationPlan(inventory)
    const materialized = materializePeopleToChannels({
      plan,
      source: inventory,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })

    expect(materialized.mutations[0].channel).toMatchObject({
      channelId: 'channel_existing',
      ownerMemberId: 'owner_existing',
      messageCount: 4,
      membershipRevision: 3,
      updatedAt: 1_000,
      display: { title: 'Existing Channel', memberCount: 2, messageCount: 4 }
    })
    expect(materialized.mutations[0].members).toHaveLength(2)
  })

  it('retains disabled shares and rejects stale plans or invalid execution identity', () => {
    const disabled = source({ people: { shares: [share({ enabled: false })] }, chats: [] })
    const disabledPlan = createPeopleToChannelMigrationPlan(disabled)
    const retained = materializePeopleToChannels({
      plan: disabledPlan,
      source: disabled,
      hostDisplayName: 'Host Person',
      migrationAt: 1_000
    })
    expect(retained).toMatchObject({
      mutations: [],
      policies: [],
      migratedShareIds: [],
      retainedShareIds: ['share_one']
    })

    const inventory = source()
    const plan = createPeopleToChannelMigrationPlan(inventory)
    const changed = source({ chats: [{ chatId: 'chat_one', title: 'Changed title' }] })
    expect(() =>
      materializePeopleToChannels({
        plan,
        source: changed,
        hostDisplayName: 'Host Person',
        migrationAt: 1_000
      })
    ).toThrow(PeopleToChannelMigrationMaterializationError)
    expect(() =>
      materializePeopleToChannels({
        plan,
        source: inventory,
        hostDisplayName: ' Host Person ',
        migrationAt: 1_000
      })
    ).toThrow(/display name/)
  })
})
