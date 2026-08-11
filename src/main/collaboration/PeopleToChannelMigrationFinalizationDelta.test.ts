import { createHash } from 'crypto'

import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '../store/types'
import type { HumanCollaborationShare } from './HumanCollaborationStore'
import { contributionRulesForPreset } from './HumanContributionRules'
import type { ChannelMessage } from './ChannelMessageLog'
import { CHANNEL_SCHEMA_VERSION, type ChannelStoreSnapshot } from './ChannelStore'
import {
  PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
  type PeopleToChannelMigrationExecution
} from './PeopleToChannelMigrationExecutionStore'
import {
  PeopleToChannelMigrationFinalizationDeltaError,
  buildPeopleToChannelMigrationFinalizationDelta
} from './PeopleToChannelMigrationFinalizationDelta'
import { materializePeopleToChannelMigrationHistory } from './PeopleToChannelMigrationHistory'
import {
  peopleToChannelLegacyContributionEvidenceList,
  type PeopleToChannelInventoryChat
} from './PeopleToChannelMigrationInventory'
import { materializePeopleToChannels } from './PeopleToChannelMigrationMaterializer'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput
} from './PeopleToChannelMigrationPlan'
import { HUMAN_COLLABORATOR_COMMENT_KIND } from './HumanCollaboratorMessages'

const HOST_KEY = Buffer.alloc(32, 1).toString('base64')
const MEMBER_KEY = Buffer.alloc(32, 2).toString('base64')
const INITIAL_MIGRATION_AT = 500

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function planDigest(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)))
}

function contribution(args: {
  id: string
  sequence: number
  acceptedAt: number
  content: string
}): ChatMessage {
  return {
    id: args.id,
    role: 'system',
    content: args.content,
    timestamp: new Date(args.acceptedAt).toISOString(),
    metadata: {
      kind: HUMAN_COLLABORATOR_COMMENT_KIND,
      sourceTrust: 'external_untrusted',
      shareId: 'share_one',
      collaboratorId: 'collaborator_one',
      collaboratorDisplayName: 'Private Person',
      clientMessageId: `client_${args.sequence}`,
      sequence: args.sequence
    }
  }
}

function share(overrides: Partial<HumanCollaborationShare> = {}): HumanCollaborationShare {
  return {
    shareId: 'share_one',
    chatId: 'chat_one',
    mode: 'comments',
    enabled: true,
    createdAt: 50,
    updatedAt: 200,
    nextSequence: 2,
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
        tokenHash: 'legacy-token-hash',
        createdAt: 60,
        expiresAt: 20_000,
        consumedAt: 100,
        collaboratorId: 'collaborator_one',
        roomId: 'room_one'
      }
    ],
    idempotency: {},
    contributionRules: contributionRulesForPreset('comments'),
    ...overrides
  }
}

function donor(messages: ChatMessage[]): PeopleToChannelInventoryChat {
  return {
    appChatId: 'chat_one',
    title: 'Private migration chat',
    scope: 'global',
    chatKind: 'single',
    messages
  }
}

function source(args: {
  peopleShare: HumanCollaborationShare
  channels: ChannelStoreSnapshot
  messages: ChatMessage[]
}): PeopleToChannelMigrationPlanInput {
  return {
    hostIdentityPublicKey: HOST_KEY,
    people: { shares: [args.peopleShare] },
    channels: args.channels,
    chats: [
      {
        chatId: 'chat_one',
        title: 'Private migration chat',
        scope: 'global',
        chatKind: 'single',
        legacyContributions: peopleToChannelLegacyContributionEvidenceList(args.messages)
      }
    ]
  }
}

function initialExecution(): {
  execution: PeopleToChannelMigrationExecution
  currentChannels: ChannelStoreSnapshot
  existingMessages: ChannelMessage[]
  before: ChatMessage
} {
  const before = contribution({
    id: 'before_soak',
    sequence: 1,
    acceptedAt: 200,
    content: 'before soak contribution'
  })
  const initialSource = source({
    peopleShare: share(),
    channels: { schemaVersion: CHANNEL_SCHEMA_VERSION, channels: [], members: [], invites: [] },
    messages: [before]
  })
  const plan = createPeopleToChannelMigrationPlan(initialSource)
  const base = materializePeopleToChannels({
    plan,
    source: initialSource,
    hostDisplayName: 'Private Host',
    migrationAt: INITIAL_MIGRATION_AT
  })
  const history = materializePeopleToChannelMigrationHistory({
    plan,
    base,
    donorChats: [donor([before])],
    existingLogs: [],
    legacyProjectionHistory: 'import-then-reset'
  })
  const metadata = history.metadataMutations[0]
  return {
    execution: {
      schemaVersion: PEOPLE_TO_CHANNEL_EXECUTION_STORE_VERSION,
      planDigest: planDigest(plan),
      hostDisplayName: 'Private Host',
      plan,
      base,
      history
    },
    currentChannels: {
      schemaVersion: CHANNEL_SCHEMA_VERSION,
      channels: [metadata.channel],
      members: metadata.members,
      invites: metadata.invites
    },
    existingMessages: history.logMutations[0].messages,
    before
  }
}

describe('PeopleToChannelMigrationFinalizationDelta', () => {
  it('rebuilds an encrypted-ready terminal execution and imports only the soak delta', () => {
    const initial = initialExecution()
    const after = contribution({
      id: 'after_soak',
      sequence: 2,
      acceptedAt: 700,
      content: 'terminal delta contribution'
    })
    const current = source({
      peopleShare: share({ updatedAt: 700, nextSequence: 3 }),
      channels: initial.currentChannels,
      messages: [initial.before, after]
    })
    const result = buildPeopleToChannelMigrationFinalizationDelta({
      initial: initial.execution,
      current,
      donorChats: [donor([initial.before, after])],
      existingLogs: [
        {
          channelId: initial.currentChannels.channels[0].channelId,
          messages: initial.existingMessages,
          digest: sha256(JSON.stringify(initial.existingMessages))
        }
      ],
      hostDisplayName: 'Private Host',
      migrationAt: 1_000
    })

    expect(result).toMatchObject({
      initialPlanId: initial.execution.plan.planId,
      initialPlanDigest: initial.execution.planDigest,
      initialMigrationAt: INITIAL_MIGRATION_AT,
      execution: {
        plan: {
          planId: expect.not.stringMatching(new RegExp(`^${initial.execution.plan.planId}$`))
        },
        base: { migrationAt: 1_000 },
        history: { importedContributionCount: 1 }
      }
    })
    expect(result.execution.history.logMutations).toHaveLength(1)
    expect(result.execution.history.logMutations[0]).toMatchObject({
      importedCount: 1,
      beforeDigest: sha256(JSON.stringify(initial.existingMessages)),
      messages: [
        expect.objectContaining({ content: 'before soak contribution', sequence: 1 }),
        expect.objectContaining({
          content: 'terminal delta contribution',
          sequence: 2,
          acceptedAt: 700
        })
      ]
    })
  })

  it('blocks a post-soak People row when its source share is no longer executable', () => {
    const initial = initialExecution()
    const after = contribution({
      id: 'after_disabled',
      sequence: 2,
      acceptedAt: 700,
      content: 'must not be dropped'
    })
    const current = source({
      peopleShare: share({ enabled: false, updatedAt: 700, nextSequence: 3 }),
      channels: initial.currentChannels,
      messages: [initial.before, after]
    })

    expect(() =>
      buildPeopleToChannelMigrationFinalizationDelta({
        initial: initial.execution,
        current,
        donorChats: [donor([initial.before, after])],
        existingLogs: [],
        hostDisplayName: 'Private Host',
        migrationAt: 1_000
      })
    ).toThrow(PeopleToChannelMigrationFinalizationDeltaError)
    expect(() =>
      buildPeopleToChannelMigrationFinalizationDelta({
        initial: initial.execution,
        current,
        donorChats: [donor([initial.before, after])],
        existingLogs: [],
        hostDisplayName: 'Private Host',
        migrationAt: 1_000
      })
    ).toThrow(/no executable Channel target/)
  })

  it('requires a strictly later finalization boundary', () => {
    const initial = initialExecution()
    const current = source({
      peopleShare: share(),
      channels: initial.currentChannels,
      messages: [initial.before]
    })

    expect(() =>
      buildPeopleToChannelMigrationFinalizationDelta({
        initial: initial.execution,
        current,
        donorChats: [donor([initial.before])],
        existingLogs: [],
        hostDisplayName: 'Private Host',
        migrationAt: INITIAL_MIGRATION_AT
      })
    ).toThrow(/finalization inputs are invalid/)
  })
})
