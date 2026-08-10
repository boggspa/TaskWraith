import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '../store/types'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import type { ChannelMessage } from './ChannelMessageLog'
import {
  CHANNEL_SCHEMA_VERSION,
  type Channel,
  type ChannelMember,
  type ChannelStoreSnapshot
} from './ChannelStore'
import {
  materializePeopleToChannelMigrationHistory,
  PeopleToChannelMigrationHistoryError,
  type PeopleToChannelExistingLogSnapshot
} from './PeopleToChannelMigrationHistory'
import {
  peopleToChannelLegacyContributionEvidenceList,
  type PeopleToChannelInventoryChat
} from './PeopleToChannelMigrationInventory'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'
import {
  materializePeopleToChannels,
  type PeopleToChannelMigrationMaterialization
} from './PeopleToChannelMigrationMaterializer'
import {
  EXTERNAL_SEAT_TURN_KIND,
  HUMAN_COLLABORATOR_COMMENT_KIND
} from './HumanCollaboratorMessages'

const HOST_KEY = 'host-key-material'
const MEMBER_KEY = 'member-key-material'
const MIGRATION_AT = 500

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function contribution(args: {
  id: string
  kind: typeof HUMAN_COLLABORATOR_COMMENT_KIND | typeof EXTERNAL_SEAT_TURN_KIND
  sequence: number
  acceptedAt: number
  content: string
  clientMessageId?: string
  collaboratorId?: string
}): ChatMessage {
  return {
    id: args.id,
    role: 'system',
    content: args.content,
    timestamp: new Date(args.acceptedAt).toISOString(),
    metadata: {
      kind: args.kind,
      sourceTrust: 'external_untrusted',
      shareId: 'share_one',
      collaboratorId: args.collaboratorId ?? 'collaborator_one',
      collaboratorDisplayName: 'Private Person',
      clientMessageId: args.clientMessageId ?? `client_${args.sequence}`,
      sequence: args.sequence
    }
  }
}

function defaultDonorMessages(): ChatMessage[] {
  return [
    contribution({
      id: 'queued_one',
      kind: HUMAN_COLLABORATOR_COMMENT_KIND,
      sequence: 1,
      acceptedAt: 140,
      content: 'same contribution'
    }),
    contribution({
      id: 'delivered_one',
      kind: EXTERNAL_SEAT_TURN_KIND,
      sequence: 1,
      acceptedAt: 160,
      content: 'same contribution'
    }),
    contribution({
      id: 'queued_two',
      kind: HUMAN_COLLABORATOR_COMMENT_KIND,
      sequence: 2,
      acceptedAt: 130,
      content: 'open /Users/alice/private.txt now'
    })
  ]
}

function share(overrides: Partial<HumanCollaborationShare> = {}): HumanCollaborationShare {
  return {
    shareId: 'share_one',
    chatId: 'chat_one',
    mode: 'comments',
    enabled: true,
    createdAt: 50,
    updatedAt: 200,
    nextSequence: 3,
    participants: [
      {
        collaboratorId: 'collaborator_one',
        displayName: 'Private Person',
        publicKeyId: MEMBER_KEY,
        status: 'active',
        joinedAt: 100
      }
    ],
    invites: [
      {
        inviteId: 'invite_one',
        tokenHash: 'private-token-hash',
        createdAt: 60,
        expiresAt: 1_000,
        consumedAt: 100,
        collaboratorId: 'collaborator_one',
        roomId: 'private-room'
      }
    ],
    idempotency: {},
    contributionRules: contributionRulesForPreset('comments'),
    ...overrides
  }
}

function donorChat(messages: ChatMessage[]): PeopleToChannelInventoryChat {
  return {
    appChatId: 'chat_one',
    title: 'Private title',
    scope: 'global',
    chatKind: 'single',
    messages
  }
}

function channelSnapshot(
  channels: Channel[] = [],
  members: ChannelMember[] = []
): ChannelStoreSnapshot {
  return { schemaVersion: CHANNEL_SCHEMA_VERSION, channels, members, invites: [] }
}

function existingChannel(): Channel {
  return {
    channelId: 'channel_existing',
    chatId: 'chat_one',
    ownerMemberId: 'owner_existing',
    status: 'active',
    createdAt: 10,
    updatedAt: 90,
    membershipRevision: 2,
    messageCount: 1,
    reference: { kind: 'chat', id: 'chat_one' },
    display: {
      title: 'Existing private title',
      status: 'active',
      memberCount: 2,
      messageCount: 1
    }
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
      joinedAt: 10
    },
    {
      memberId: 'member_existing',
      channelId: 'channel_existing',
      kind: 'human',
      displayName: 'Existing person',
      identityPublicKey: MEMBER_KEY,
      status: 'active',
      roomId: 'existing-room',
      joinedAt: 80
    }
  ]
}

function prefixMessage(): ChannelMessage {
  const content = 'existing Channel prefix'
  return {
    channelId: 'channel_existing',
    sequence: 1,
    messageId: 'existing_message',
    authorMemberId: 'owner_existing',
    clientMessageId: 'existing_client',
    kind: 'human.text',
    content,
    acceptedAt: 70,
    contentHash: sha256(content)
  }
}

function logSnapshot(
  channelId: string,
  messages: ChannelMessage[]
): PeopleToChannelExistingLogSnapshot {
  return { channelId, messages, digest: sha256(JSON.stringify(messages)) }
}

function fixture(
  args: {
    messages?: ChatMessage[]
    peopleShare?: HumanCollaborationShare
    existing?: boolean
  } = {}
): {
  plan: ReturnType<typeof createPeopleToChannelMigrationPlan>
  base: PeopleToChannelMigrationMaterialization
  donor: PeopleToChannelInventoryChat
} {
  const messages = args.messages ?? defaultDonorMessages()
  const donor = donorChat(messages)
  const source: PeopleToChannelMigrationPlanInput = {
    hostIdentityPublicKey: HOST_KEY,
    people: { shares: [args.peopleShare ?? share()] },
    channels: args.existing
      ? channelSnapshot([existingChannel()], existingMembers())
      : channelSnapshot(),
    chats: [
      {
        chatId: donor.appChatId,
        title: donor.title,
        scope: donor.scope,
        chatKind: donor.chatKind,
        legacyContributions: peopleToChannelLegacyContributionEvidenceList(messages)
      }
    ]
  }
  const plan = createPeopleToChannelMigrationPlan(source)
  const base = materializePeopleToChannels({
    plan,
    source,
    hostDisplayName: 'Host',
    migrationAt: MIGRATION_AT
  })
  return { plan, base, donor }
}

function materialize(
  args: {
    built?: ReturnType<typeof fixture>
    donorChats?: PeopleToChannelInventoryChat[]
    existingLogs?: PeopleToChannelExistingLogSnapshot[]
  } = {}
) {
  const built = args.built ?? fixture()
  return materializePeopleToChannelMigrationHistory({
    plan: built.plan,
    base: built.base,
    donorChats: args.donorChats ?? [built.donor],
    existingLogs: args.existingLogs ?? [],
    legacyProjectionHistory: 'import-then-reset'
  })
}

describe('PeopleToChannelMigrationHistory', () => {
  it('imports deterministic redacted history, deduplicates delivery, and resets sequence', () => {
    const built = fixture()
    const result = materialize({ built })
    const reordered = materialize({
      built,
      donorChats: [{ ...built.donor, messages: [...built.donor.messages!].reverse() }]
    })

    expect(result).toEqual(reordered)
    expect(result.importedContributionCount).toBe(2)
    expect(result.executionDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.metadataMutations[0].channel).toMatchObject({
      messageCount: 2,
      updatedAt: MIGRATION_AT,
      display: { messageCount: 2 }
    })
    expect(result.logMutations).toHaveLength(1)
    expect(result.logMutations[0]).toMatchObject({
      importedCount: 2,
      beforeDigest: sha256('[]')
    })
    expect(result.logMutations[0].messages).toMatchObject([
      {
        sequence: 1,
        kind: 'human.text',
        content: 'open [redacted-path] now',
        acceptedAt: 130
      },
      {
        sequence: 2,
        kind: 'human.text',
        content: 'same contribution',
        acceptedAt: 160
      }
    ])
    for (const message of result.logMutations[0].messages) {
      expect(message.messageId).toMatch(/^migration_[a-f0-9]{40}$/)
      expect(message.clientMessageId).toMatch(/^migration_[a-f0-9]{64}$/)
      expect(message.messageId).not.toMatch(/queued|delivered/)
      expect(message.clientMessageId).not.toMatch(/^client_/)
      expect(message.contentHash).toBe(sha256(message.content))
    }
  })

  it('preserves a merge prefix and regenerates the exact result after the desired suffix exists', () => {
    const messages = [
      contribution({
        id: 'legacy_one',
        kind: HUMAN_COLLABORATOR_COMMENT_KIND,
        sequence: 1,
        acceptedAt: 120,
        content: 'legacy contribution'
      })
    ]
    const built = fixture({ messages, existing: true })
    const prefix = prefixMessage()
    const first = materialize({
      built,
      existingLogs: [logSnapshot('channel_existing', [prefix])]
    })
    const desired = first.logMutations[0]
    const resumed = materialize({
      built,
      existingLogs: [logSnapshot('channel_existing', desired.messages)]
    })

    expect(desired.messages[0]).toEqual(prefix)
    expect(desired.messages[1]).toMatchObject({
      channelId: 'channel_existing',
      sequence: 2,
      acceptedAt: 120,
      content: 'legacy contribution'
    })
    expect(desired.beforeDigest).toBe(sha256(JSON.stringify([prefix])))
    expect(first).toEqual(resumed)
    expect(first.metadataMutations[0].channel).toMatchObject({
      messageCount: 2,
      updatedAt: MIGRATION_AT,
      display: { messageCount: 2 }
    })
  })

  it('blocks donor content or time that no longer matches the frozen evidence', () => {
    const built = fixture()
    const changedContent = clone(built.donor)
    changedContent.messages![0].content = 'changed after planning'
    expect(() => materialize({ built, donorChats: [changedContent] })).toThrow(
      /evidence no longer matches/
    )

    const changedTime = clone(built.donor)
    changedTime.messages![0].timestamp = new Date(141).toISOString()
    expect(() => materialize({ built, donorChats: [changedTime] })).toThrow(
      /evidence no longer matches/
    )
  })

  it('blocks conflicting queued and delivered copies of one People sequence', () => {
    const messages = [
      contribution({
        id: 'queued',
        kind: HUMAN_COLLABORATOR_COMMENT_KIND,
        sequence: 1,
        acceptedAt: 120,
        content: 'queued content'
      }),
      contribution({
        id: 'delivered',
        kind: EXTERNAL_SEAT_TURN_KIND,
        sequence: 1,
        acceptedAt: 130,
        content: 'different delivered content'
      })
    ]
    const built = fixture({ messages, peopleShare: share({ nextSequence: 2 }) })

    expect(() => materialize({ built })).toThrow(/duplicates carry different content/)
  })

  it('blocks legacy contributions outside the target human membership interval', () => {
    const messages = [
      contribution({
        id: 'at_revocation',
        kind: HUMAN_COLLABORATOR_COMMENT_KIND,
        sequence: 1,
        acceptedAt: 150,
        content: 'too late'
      })
    ]
    const revoked = share({
      nextSequence: 2,
      participants: [
        {
          ...share().participants[0],
          status: 'revoked',
          joinedAt: 100,
          revokedAt: 150
        }
      ]
    })
    const built = fixture({ messages, peopleShare: revoked })

    expect(() => materialize({ built })).toThrow(/outside target membership history/)
  })

  it('blocks content that is empty or oversized under Channel persistence rules', () => {
    const whitespace = [
      contribution({
        id: 'whitespace',
        kind: HUMAN_COLLABORATOR_COMMENT_KIND,
        sequence: 1,
        acceptedAt: 120,
        content: '   '
      })
    ]
    expect(() =>
      materialize({
        built: fixture({ messages: whitespace, peopleShare: share({ nextSequence: 2 }) })
      })
    ).toThrow(/empty after redaction/)

    const oversized = [
      contribution({
        id: 'oversized',
        kind: HUMAN_COLLABORATOR_COMMENT_KIND,
        sequence: 1,
        acceptedAt: 120,
        content: 'x'.repeat(8_001)
      })
    ]
    expect(() =>
      materialize({
        built: fixture({ messages: oversized, peopleShare: share({ nextSequence: 2 }) })
      })
    ).toThrow(/exceeds the Channel message limit/)
  })

  it('blocks stale logs, missing merge snapshots, extra snapshots, and tampered base state', () => {
    const messages = [
      contribution({
        id: 'legacy_one',
        kind: HUMAN_COLLABORATOR_COMMENT_KIND,
        sequence: 1,
        acceptedAt: 120,
        content: 'legacy contribution'
      })
    ]
    const built = fixture({ messages, existing: true })
    expect(() => materialize({ built })).toThrow(/has no log snapshot/)

    const prefix = prefixMessage()
    const staleContent = 'concurrent Channel row'
    const stale: ChannelMessage = {
      channelId: 'channel_existing',
      sequence: 2,
      messageId: 'concurrent_message',
      authorMemberId: 'owner_existing',
      clientMessageId: 'concurrent_client',
      kind: 'human.text',
      content: staleContent,
      acceptedAt: 300,
      contentHash: sha256(staleContent)
    }
    expect(() =>
      materialize({
        built,
        existingLogs: [logSnapshot('channel_existing', [prefix, stale])]
      })
    ).toThrow(/prefix no longer matches/)

    const created = fixture()
    expect(() =>
      materialize({
        built: created,
        existingLogs: [logSnapshot('unrelated_channel', [])]
      })
    ).toThrow(/outside the People migration plan/)

    const tampered = clone(created)
    tampered.base.mutations[0].channel.messageCount = 99
    expect(() => materialize({ built: tampered })).toThrow(PeopleToChannelMigrationHistoryError)
    expect(() => materialize({ built: tampered })).toThrow(/digest does not match/)
  })
})
