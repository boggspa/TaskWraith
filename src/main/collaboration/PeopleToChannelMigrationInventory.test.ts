import { describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from '../store/types'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import type { Channel, ChannelInvite, ChannelMember } from './ChannelStore'
import {
  inventoryPeopleToChannelMigration,
  peopleToChannelLegacyContributionEvidence,
  PeopleToChannelMigrationInventoryError,
  readPeopleToChannelMigrationInventory,
  type PeopleToChannelInventoryChat,
  type PeopleToChannelMigrationInventoryInput
} from './PeopleToChannelMigrationInventory'
import {
  EXTERNAL_SEAT_TURN_KIND,
  HUMAN_COLLABORATOR_COMMENT_KIND
} from './HumanCollaboratorMessages'

const HOST_KEY = 'host-key-private-material'
const MEMBER_KEY = 'member-key-private-material'

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
        displayName: 'Private Person',
        publicKeyId: MEMBER_KEY,
        status: 'active',
        joinedAt: 120
      }
    ],
    invites: [
      {
        inviteId: 'invite_one',
        tokenHash: 'people-token-hash',
        createdAt: 110,
        expiresAt: 500,
        consumedAt: 120,
        collaboratorId: 'collaborator_one',
        roomId: 'people-private-room'
      }
    ],
    idempotency: {},
    contributionRules: contributionRulesForPreset('comments'),
    ...overrides
  }
}

function contribution(
  kind: typeof HUMAN_COLLABORATOR_COMMENT_KIND | typeof EXTERNAL_SEAT_TURN_KIND,
  sequence: number,
  content: string
): ChatMessage {
  return {
    id: `message_${sequence}`,
    role: 'system',
    content,
    timestamp: `2026-08-10T00:00:0${sequence}.000Z`,
    metadata: {
      kind,
      sourceTrust: 'external_untrusted',
      shareId: 'share_one',
      collaboratorId: 'collaborator_one',
      collaboratorDisplayName: 'Private Person',
      clientMessageId: `client_${sequence}`,
      sequence
    }
  }
}

function chat(overrides: Partial<PeopleToChannelInventoryChat> = {}): PeopleToChannelInventoryChat {
  return {
    appChatId: 'chat_one',
    title: 'Private chat title',
    scope: 'global',
    chatKind: 'single',
    messages: [
      contribution(HUMAN_COLLABORATOR_COMMENT_KIND, 1, 'private comment content'),
      contribution(EXTERNAL_SEAT_TURN_KIND, 2, 'private delivered content')
    ],
    ...overrides
  }
}

function existingChannel(): Channel {
  return {
    channelId: 'channel_existing',
    chatId: 'chat_one',
    ownerMemberId: 'owner_existing',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    membershipRevision: 2,
    messageCount: 0,
    display: { title: 'Existing title', status: 'active', memberCount: 2, messageCount: 0 }
  }
}

function existingMembers(): ChannelMember[] {
  return [
    {
      memberId: 'owner_existing',
      channelId: 'channel_existing',
      kind: 'human',
      displayName: 'Host',
      identityPublicKey: HOST_KEY,
      status: 'active',
      joinedAt: 1
    },
    {
      memberId: 'member_existing',
      channelId: 'channel_existing',
      kind: 'human',
      displayName: 'Private Person',
      identityPublicKey: MEMBER_KEY,
      status: 'active',
      roomId: 'channel-private-room',
      joinedAt: 2
    }
  ]
}

function inventoryInput(
  overrides: Partial<PeopleToChannelMigrationInventoryInput> = {}
): PeopleToChannelMigrationInventoryInput {
  return {
    hostIdentityPublicKey: HOST_KEY,
    people: { readMigrationSnapshot: () => ({ shares: [share()] }) },
    channels: {
      listChannels: () => [],
      listMembers: () => [],
      listInvites: () => []
    },
    chats: [chat()],
    ...overrides
  }
}

describe('PeopleToChannelMigrationInventory', () => {
  it('returns one validated source generation with the plan used to bind it', () => {
    const people = vi.fn(() => ({ shares: [share()] }))
    const input = inventoryInput({ people: { readMigrationSnapshot: people } })
    const read = readPeopleToChannelMigrationInventory(input)

    expect(people).toHaveBeenCalledTimes(1)
    expect(read.plan).toEqual(inventoryPeopleToChannelMigration(input))
    expect(read.source).toMatchObject({
      hostIdentityPublicKey: HOST_KEY,
      people: { shares: [{ shareId: 'share_one' }] },
      channels: { schemaVersion: 4, channels: [], members: [], invites: [] },
      chats: [{ chatId: 'chat_one', title: 'Private chat title' }]
    })
  })

  it('hashes legacy contribution content into a deterministic content-free plan', () => {
    const source = inventoryInput()
    const before = JSON.stringify(source.chats)
    const plan = inventoryPeopleToChannelMigration(source)
    const again = inventoryPeopleToChannelMigration(source)

    expect(plan).toEqual(again)
    expect(JSON.stringify(source.chats)).toBe(before)
    expect(plan.entries[0]).toMatchObject({
      disposition: 'create',
      blockers: [],
      source: {
        history: {
          commentCount: 1,
          externalSeatTurnCount: 1,
          highestSequence: 2
        }
      }
    })
    expect(plan.entries[0].source.history.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(peopleToChannelLegacyContributionEvidence(source.chats[0].messages![0])).toMatchObject({
      acceptedAt: 1786320001000
    })
    expect(plan.generalChats[0].disposition).toBe('covered_by_people')

    const serialized = JSON.stringify(plan)
    for (const privateValue of [
      'Private chat title',
      'Private Person',
      'private comment content',
      'private delivered content',
      'people-private-room',
      'people-token-hash',
      HOST_KEY,
      MEMBER_KEY
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('includes unshared General chats but excludes workspace, ensemble, linked, and workflow chats', () => {
    const plan = inventoryPeopleToChannelMigration(
      inventoryInput({
        people: { readMigrationSnapshot: () => ({ shares: [] }) },
        chats: [
          chat({ appChatId: 'general', messages: [] }),
          chat({ appChatId: 'workspace', scope: 'workspace', messages: [] }),
          chat({ appChatId: 'ensemble', chatKind: 'ensemble', messages: [] }),
          chat({
            appChatId: 'child',
            parentChatId: 'general',
            parentChatRelation: 'subThread',
            messages: []
          }),
          chat({ appChatId: 'workflow', messages: [] })
        ],
        workflowChatIds: ['workflow']
      })
    )

    expect(plan.entries).toEqual([])
    expect(plan.generalChats).toMatchObject([
      { source: { chatId: 'general' }, disposition: 'create', blockers: [] }
    ])
  })

  it('binds the plan digest to content without retaining the content', () => {
    const first = inventoryPeopleToChannelMigration(inventoryInput())
    const changed = inventoryPeopleToChannelMigration(
      inventoryInput({
        chats: [
          chat({
            messages: [contribution(HUMAN_COLLABORATOR_COMMENT_KIND, 1, 'changed private content')]
          })
        ]
      })
    )

    expect(changed.sourceDigest).not.toBe(first.sourceDigest)
    expect(JSON.stringify(changed)).not.toContain('changed private content')
  })

  it('collects existing Channel membership once per Channel for identity-safe merge planning', () => {
    const listChannels = vi.fn(() => [existingChannel()])
    const listMembers = vi.fn(() => existingMembers())
    const listInvites = vi.fn((): ChannelInvite[] => [])
    const plan = inventoryPeopleToChannelMigration(
      inventoryInput({ channels: { listChannels, listMembers, listInvites } })
    )

    expect(listChannels).toHaveBeenCalledTimes(1)
    expect(listMembers).toHaveBeenCalledWith('channel_existing')
    expect(listInvites).toHaveBeenCalledWith('channel_existing')
    expect(plan.entries[0]).toMatchObject({
      disposition: 'merge',
      blockers: [],
      target: {
        channelId: 'channel_existing',
        memberMappings: [
          {
            sourceCollaboratorId: 'collaborator_one',
            targetMemberId: 'member_existing',
            reusedExistingMember: true
          }
        ]
      }
    })
  })

  it('keeps all Chat surfaces eligible while marking workflow-owned chats ineligible', () => {
    for (const chats of [
      [chat({ chatKind: 'ensemble' })],
      [chat({ parentChatId: 'parent', parentChatRelation: 'subThread' })],
      [chat({ sideChatContext: { createdAt: 100 } })]
    ]) {
      const plan = inventoryPeopleToChannelMigration(inventoryInput({ chats }))
      expect(plan.entries[0].disposition).toBe('create')
      expect(plan.entries[0].blockers).not.toContain('source_chat_not_channel_eligible')
    }

    const workflow = inventoryPeopleToChannelMigration(
      inventoryInput({ workflowChatIds: ['chat_one'] })
    )
    expect(workflow.entries[0].blockers).toContain('source_chat_not_channel_eligible')
  })

  it('fails recovery closed on malformed or duplicated legacy contribution evidence', () => {
    const malformed = contribution(HUMAN_COLLABORATOR_COMMENT_KIND, 1, 'private')
    delete malformed.metadata!.clientMessageId
    expect(() =>
      inventoryPeopleToChannelMigration(
        inventoryInput({ chats: [chat({ messages: [malformed] })] })
      )
    ).toThrow(PeopleToChannelMigrationInventoryError)

    const duplicateSequence = contribution(
      HUMAN_COLLABORATOR_COMMENT_KIND,
      1,
      'different private row'
    )
    duplicateSequence.id = 'message_duplicate'
    duplicateSequence.metadata!.clientMessageId = 'client_duplicate'
    expect(() =>
      inventoryPeopleToChannelMigration(
        inventoryInput({
          chats: [
            chat({
              messages: [
                contribution(HUMAN_COLLABORATOR_COMMENT_KIND, 1, 'private'),
                duplicateSequence
              ]
            })
          ]
        })
      )
    ).toThrow(/sequences are duplicated/)

    const invalidTimestamp = contribution(HUMAN_COLLABORATOR_COMMENT_KIND, 1, 'private')
    invalidTimestamp.timestamp = 'not-a-timestamp'
    expect(() =>
      inventoryPeopleToChannelMigration(
        inventoryInput({ chats: [chat({ messages: [invalidTimestamp] })] })
      )
    ).toThrow(/timestamp is invalid/)
  })

  it('ignores unrelated transcript rows and accepts legacy kind-only People evidence', () => {
    const legacy = contribution(HUMAN_COLLABORATOR_COMMENT_KIND, 1, 'legacy private row')
    delete legacy.metadata!.sourceTrust
    const delivered = contribution(EXTERNAL_SEAT_TURN_KIND, 1, 'delivered legacy private row')
    delivered.id = 'message_delivered'
    const unrelated: ChatMessage = {
      id: 'ordinary',
      role: 'user',
      content: 'ordinary host content',
      timestamp: '2026-08-10T00:00:00.000Z'
    }
    const plan = inventoryPeopleToChannelMigration(
      inventoryInput({ chats: [chat({ messages: [unrelated, legacy, delivered] })] })
    )

    expect(plan.entries[0].source.history).toMatchObject({
      commentCount: 1,
      externalSeatTurnCount: 1,
      highestSequence: 1
    })
    expect(JSON.stringify(plan)).not.toContain('ordinary host content')
    expect(JSON.stringify(plan)).not.toContain('legacy private row')
    expect(JSON.stringify(plan)).not.toContain('delivered legacy private row')
  })
})
