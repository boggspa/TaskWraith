import { createHash } from 'crypto'

import type { ChatMessage, ChatRecord } from '../store/types'
import type { HumanCollaborationShare, HumanCollaborationSnapshot } from './HumanCollaborationStore'
import {
  CHANNEL_SCHEMA_VERSION,
  type Channel,
  type ChannelInvite,
  type ChannelMember,
  type ChannelStore
} from './ChannelStore'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelLegacyContributionEvidence,
  type PeopleToChannelMigrationChat,
  type PeopleToChannelMigrationPlan
} from './PeopleToChannelMigrationPlan'
import {
  EXTERNAL_SEAT_TURN_KIND,
  HUMAN_COLLABORATOR_COMMENT_KIND
} from './HumanCollaboratorMessages'

export type PeopleToChannelInventoryChat = Pick<
  ChatRecord,
  | 'appChatId'
  | 'title'
  | 'scope'
  | 'chatKind'
  | 'parentChatId'
  | 'parentChatRelation'
  | 'sideChatContext'
  | 'messages'
>

export interface PeopleToChannelInventoryPeoplePort {
  /**
   * Deliberately not `HumanCollaborationStore.listShares()`: that legacy store
   * treats an unreadable file as an empty snapshot. Migration must use a strict
   * reader whose corruption path throws instead of erasing the donor inventory.
   */
  readMigrationSnapshot: () => HumanCollaborationSnapshot
}

export type PeopleToChannelInventoryChannelPort = Pick<
  ChannelStore,
  'listChannels' | 'listMembers' | 'listInvites'
>

export interface PeopleToChannelMigrationInventoryInput {
  hostIdentityPublicKey: string
  people: PeopleToChannelInventoryPeoplePort
  channels: PeopleToChannelInventoryChannelPort
  chats: readonly PeopleToChannelInventoryChat[]
  workflowChatIds?: readonly string[]
}

export class PeopleToChannelMigrationInventoryError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationInventoryError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PeopleToChannelMigrationInventoryError(`${label} is invalid`)
  }
  return value
}

function positiveSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PeopleToChannelMigrationInventoryError(
      'A legacy People contribution sequence is invalid'
    )
  }
  return value as number
}

function acceptedAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PeopleToChannelMigrationInventoryError(
      'A legacy People contribution timestamp is invalid'
    )
  }
  return parsed
}

export function peopleToChannelLegacyContributionEvidence(
  message: ChatMessage
): PeopleToChannelLegacyContributionEvidence | null {
  const metadata = message.metadata
  if (
    metadata?.kind !== HUMAN_COLLABORATOR_COMMENT_KIND &&
    metadata?.kind !== EXTERNAL_SEAT_TURN_KIND
  ) {
    return null
  }
  if (typeof message.content !== 'string') {
    throw new PeopleToChannelMigrationInventoryError(
      'A legacy People contribution content field is invalid'
    )
  }
  return {
    kind: metadata.kind === HUMAN_COLLABORATOR_COMMENT_KIND ? 'comment' : 'external-seat-turn',
    messageId: nonBlank(message.id, 'Legacy People contribution message id'),
    shareId: nonBlank(metadata.shareId, 'Legacy People contribution share id'),
    collaboratorId: nonBlank(metadata.collaboratorId, 'Legacy People contribution collaborator id'),
    clientMessageId: nonBlank(
      metadata.clientMessageId,
      'Legacy People contribution client message id'
    ),
    sequence: positiveSequence(metadata.sequence),
    acceptedAt: acceptedAt(message.timestamp),
    contentHash: sha256(message.content)
  }
}

export function peopleToChannelLegacyContributionEvidenceList(
  messages: readonly ChatMessage[]
): PeopleToChannelLegacyContributionEvidence[] {
  const evidence: PeopleToChannelLegacyContributionEvidence[] = []
  const messageIds = new Set<string>()
  const sequences = new Set<string>()
  const clientMessages = new Set<string>()
  for (const message of messages) {
    const entry = peopleToChannelLegacyContributionEvidence(message)
    if (!entry) continue
    // A reviewed contribution can legitimately appear once as a queued
    // comment and once as a delivered external-seat turn with the same source
    // sequence/client id. Uniqueness is per persisted row kind, not across the
    // two provenance regimes.
    const sequenceKey = `${entry.shareId}\u0000${entry.kind}\u0000${entry.sequence}`
    const clientKey = `${entry.shareId}\u0000${entry.kind}\u0000${entry.collaboratorId}\u0000${entry.clientMessageId}`
    if (messageIds.has(entry.messageId)) {
      throw new PeopleToChannelMigrationInventoryError(
        'Legacy People contribution message ids are duplicated'
      )
    }
    if (sequences.has(sequenceKey)) {
      throw new PeopleToChannelMigrationInventoryError(
        'Legacy People contribution sequences are duplicated'
      )
    }
    if (clientMessages.has(clientKey)) {
      throw new PeopleToChannelMigrationInventoryError(
        'Legacy People contribution client ids are duplicated'
      )
    }
    messageIds.add(entry.messageId)
    sequences.add(sequenceKey)
    clientMessages.add(clientKey)
    evidence.push(entry)
  }
  return evidence
}

function migrationChat(
  chat: PeopleToChannelInventoryChat,
  workflowChatIds: ReadonlySet<string>
): PeopleToChannelMigrationChat {
  return {
    chatId: nonBlank(chat.appChatId, 'Chat id'),
    title: typeof chat.title === 'string' ? chat.title : '',
    scope: chat.scope === 'global' ? 'global' : 'workspace',
    ...(chat.chatKind === 'ensemble' ? { chatKind: 'ensemble' as const } : {}),
    ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
    ...(chat.parentChatRelation ? { parentChatRelation: chat.parentChatRelation } : {}),
    ...(chat.sideChatContext ? { sideChat: true } : {}),
    ...(workflowChatIds.has(chat.appChatId) ? { workflowOwned: true } : {}),
    legacyContributions: peopleToChannelLegacyContributionEvidenceList(chat.messages ?? [])
  }
}

function peopleShares(port: PeopleToChannelInventoryPeoplePort): HumanCollaborationShare[] {
  const snapshot = port.readMigrationSnapshot()
  if (!snapshot || !Array.isArray(snapshot.shares)) {
    throw new PeopleToChannelMigrationInventoryError('People share inventory is invalid')
  }
  return snapshot.shares
}

function channelSnapshot(port: PeopleToChannelInventoryChannelPort): {
  schemaVersion: typeof CHANNEL_SCHEMA_VERSION
  channels: Channel[]
  members: ChannelMember[]
  invites: ChannelInvite[]
} {
  const channels = port.listChannels()
  if (!Array.isArray(channels)) {
    throw new PeopleToChannelMigrationInventoryError('Channel inventory is invalid')
  }
  const members: ChannelMember[] = []
  const invites: ChannelInvite[] = []
  for (const channel of channels) {
    const channelMembers = port.listMembers(channel.channelId)
    const channelInvites = port.listInvites(channel.channelId)
    if (!Array.isArray(channelMembers) || !Array.isArray(channelInvites)) {
      throw new PeopleToChannelMigrationInventoryError('Channel member inventory is invalid')
    }
    members.push(...channelMembers)
    invites.push(...channelInvites)
  }
  return { schemaVersion: CHANNEL_SCHEMA_VERSION, channels, members, invites }
}

/**
 * Strict, read-only production adapter for the P4 planner. Content exists only
 * long enough to derive SHA-256 evidence; the returned plan contains no title,
 * message, display-name, room, public-key, or invite-token bytes.
 */
export function inventoryPeopleToChannelMigration(
  input: PeopleToChannelMigrationInventoryInput
): PeopleToChannelMigrationPlan {
  const workflowChatIds = new Set(input.workflowChatIds ?? [])
  return createPeopleToChannelMigrationPlan({
    hostIdentityPublicKey: input.hostIdentityPublicKey,
    people: { shares: peopleShares(input.people) },
    channels: channelSnapshot(input.channels),
    chats: input.chats.map((chat) => migrationChat(chat, workflowChatIds))
  })
}
