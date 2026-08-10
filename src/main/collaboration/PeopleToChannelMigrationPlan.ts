import { createHash } from 'crypto'

import type { HumanCollaborationSnapshot, HumanCollaborationShare } from './HumanCollaborationStore'
import {
  contributionRulesForPreset,
  effectiveContributionRules,
  type HumanContributionRules
} from './HumanContributionRules'
import {
  CHANNEL_SCHEMA_VERSION,
  MAX_CHANNEL_MEMBERS,
  type Channel,
  type ChannelMember,
  type ChannelStoreSnapshot
} from './ChannelStore'

export const PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION = 1

export const PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS = [
  'general_chat_scope',
  'legacy_projection_history',
  'people_retirement_timing'
] as const

export type PeopleToChannelCutoverDecision = (typeof PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS)[number]

export interface PeopleToChannelLegacyContributionEvidence {
  kind: 'comment' | 'external-seat-turn'
  messageId: string
  shareId: string
  collaboratorId: string
  clientMessageId: string
  sequence: number
  contentHash: string
}

/**
 * Content-bearing chat fields enter only so the planner can bind its source
 * digest to the exact title/history generation. The emitted plan never carries
 * title, display-name, room, public-key, or message content bytes.
 */
export interface PeopleToChannelMigrationChat {
  chatId: string
  title: string
  chatKind?: 'single' | 'ensemble'
  parentChatId?: string
  parentChatRelation?: string
  sideChat?: boolean
  workflowOwned?: boolean
  legacyContributions?: readonly PeopleToChannelLegacyContributionEvidence[]
}

export interface PeopleToChannelMigrationPlanInput {
  hostIdentityPublicKey: string
  people: HumanCollaborationSnapshot
  channels: ChannelStoreSnapshot
  chats: readonly PeopleToChannelMigrationChat[]
}

export type PeopleToChannelMigrationDisposition = 'create' | 'merge' | 'retain_legacy' | 'blocked'

export type PeopleToChannelMigrationReadiness = 'ready' | 'requires_resolution' | 'blocked'

export type PeopleToChannelMigrationBlocker =
  | 'ambiguous_active_member_room'
  | 'channel_capacity_exceeded'
  | 'channel_id_collision'
  | 'duplicate_active_share_for_chat'
  | 'duplicate_channel_for_chat'
  | 'duplicate_chat_inventory'
  | 'duplicate_participant_id'
  | 'duplicate_participant_identity'
  | 'duplicate_share_id'
  | 'host_identity_missing'
  | 'invalid_channel_schema'
  | 'invalid_legacy_evidence'
  | 'legacy_sequence_conflict'
  | 'invalid_source_identifier'
  | 'invalid_source_title'
  | 'invalid_target_identifier'
  | 'missing_active_member_room'
  | 'missing_source_chat'
  | 'source_chat_not_channel_eligible'
  | 'target_admission_conflict'
  | 'target_channel_closed'
  | 'target_identity_duplicated'
  | 'target_identity_revoked'
  | 'target_member_id_conflict'
  | 'target_owner_identity_mismatch'
  | 'target_owner_missing'
  | 'target_revocation_conflict'

export type PeopleToChannelMigrationRequirement =
  | 'existing_channel_merge_manifest'
  | 'human_policy_projection'
  | 'legacy_invite_retirement'
  | 'legacy_projection_history'
  | 'member_presentation_projection'
  | 'pending_admission_reissue'

export interface PeopleToChannelMigrationHistorySummary {
  commentCount: number
  externalSeatTurnCount: number
  highestSequence: number
  evidenceDigest: string
}

export interface PeopleToChannelMigrationSourceSummary {
  shareId: string
  chatId: string
  enabled: boolean
  sourceDigest: string
  participantCounts: Record<'active' | 'pending' | 'revoked', number>
  inviteCount: number
  pendingInviteCount: number
  idempotencyEntryCount: number
  nextSequence: number
  policy: HumanContributionRules
  requiresHostApproval: boolean
  fullHistory: boolean
  history: PeopleToChannelMigrationHistorySummary
}

export interface PeopleToChannelMemberMapping {
  sourceCollaboratorId: string
  targetMemberId: string
  sourceStatus: 'pending' | 'active' | 'revoked'
  targetStatus: 'pending' | 'active' | 'revoked'
  identityFingerprint: string
  displayNameFingerprint: string
  roomFingerprint?: string
  reusedExistingMember: boolean
}

export interface PeopleToChannelMigrationTarget {
  channelId: string
  chatId: string
  ownerMemberId: string
  hostIdentityFingerprint: string
  titleFingerprint: string
  existingChannel: boolean
  memberMappings: PeopleToChannelMemberMapping[]
}

export interface PeopleToChannelMigrationEntry {
  source: PeopleToChannelMigrationSourceSummary
  target: PeopleToChannelMigrationTarget | null
  disposition: PeopleToChannelMigrationDisposition
  readiness: PeopleToChannelMigrationReadiness
  blockers: PeopleToChannelMigrationBlocker[]
  requirements: PeopleToChannelMigrationRequirement[]
}

export interface PeopleToChannelMigrationPlan {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION
  planId: string
  sourceDigest: string
  hostIdentityFingerprint: string
  cutoverDecisions: readonly PeopleToChannelCutoverDecision[]
  entries: PeopleToChannelMigrationEntry[]
  summary: {
    shares: number
    create: number
    merge: number
    retainLegacy: number
    blocked: number
    requiresResolution: number
  }
}

const PATH_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_PATH_IDENTIFIER_LENGTH = 200
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function fingerprint(domain: string, value: string): string {
  return sha256(`${domain}\u0000${value}`)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  )
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort()
}

function pathIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PATH_IDENTIFIER_LENGTH &&
    PATH_IDENTIFIER_PATTERN.test(value)
  )
}

function boundedIdentifier(value: string): boolean {
  if (!value || value.length > 512 || value.trim() !== value) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function derivedOwnerMemberId(channelId: string, hostIdentityPublicKey: string): string {
  return `owner_${fingerprint('people-to-channel-owner', `${channelId}\u0000${hostIdentityPublicKey}`).slice(0, 32)}`
}

function sortedPeopleSnapshot(snapshot: HumanCollaborationSnapshot): unknown {
  return {
    shares: [...snapshot.shares]
      .sort((left, right) => compareText(left.shareId, right.shareId))
      .map((share) => ({
        ...share,
        participants: [...share.participants].sort((left, right) =>
          compareText(left.collaboratorId, right.collaboratorId)
        ),
        invites: [...share.invites].sort((left, right) =>
          compareText(left.inviteId, right.inviteId)
        ),
        idempotency: Object.fromEntries(
          Object.entries(share.idempotency).sort(([a], [b]) => compareText(a, b))
        )
      }))
  }
}

function sortedChannelSnapshot(snapshot: ChannelStoreSnapshot): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    channels: [...snapshot.channels].sort((left, right) =>
      compareText(left.channelId, right.channelId)
    ),
    members: [...snapshot.members].sort((left, right) =>
      compareText(
        `${left.channelId}\u0000${left.memberId}`,
        `${right.channelId}\u0000${right.memberId}`
      )
    ),
    invites: [...snapshot.invites].sort((left, right) => compareText(left.inviteId, right.inviteId))
  }
}

function sortedChats(chats: readonly PeopleToChannelMigrationChat[]): unknown {
  return [...chats]
    .sort((left, right) => compareText(left.chatId, right.chatId))
    .map((chat) => ({
      ...chat,
      legacyContributions: [...(chat.legacyContributions ?? [])].sort((left, right) =>
        compareText(
          `${left.shareId}\u0000${left.sequence}\u0000${left.messageId}`,
          `${right.shareId}\u0000${right.sequence}\u0000${right.messageId}`
        )
      )
    }))
}

function sourceDigest(input: PeopleToChannelMigrationPlanInput): string {
  return sha256(
    canonicalJson({
      hostIdentityPublicKey: input.hostIdentityPublicKey,
      people: sortedPeopleSnapshot(input.people),
      channels: sortedChannelSnapshot(input.channels),
      chats: sortedChats(input.chats)
    })
  )
}

function historySummary(
  shareId: string,
  chat: PeopleToChannelMigrationChat | undefined,
  blockers: PeopleToChannelMigrationBlocker[]
): PeopleToChannelMigrationHistorySummary {
  const evidence = (chat?.legacyContributions ?? [])
    .filter((entry) => entry.shareId === shareId)
    .sort((left, right) =>
      compareText(
        `${left.sequence}\u0000${left.messageId}`,
        `${right.sequence}\u0000${right.messageId}`
      )
    )
  if (
    evidence.some(
      (entry) =>
        !entry.messageId ||
        !entry.collaboratorId ||
        !entry.clientMessageId ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 1 ||
        !SHA256_PATTERN.test(entry.contentHash)
    )
  ) {
    blockers.push('invalid_legacy_evidence')
  }
  return {
    commentCount: evidence.filter((entry) => entry.kind === 'comment').length,
    externalSeatTurnCount: evidence.filter((entry) => entry.kind === 'external-seat-turn').length,
    highestSequence: evidence.reduce((highest, entry) => Math.max(highest, entry.sequence), 0),
    evidenceDigest: sha256(canonicalJson(evidence))
  }
}

function sourceSummary(
  share: HumanCollaborationShare,
  chat: PeopleToChannelMigrationChat | undefined,
  blockers: PeopleToChannelMigrationBlocker[]
): PeopleToChannelMigrationSourceSummary {
  const policy = effectiveContributionRules(share)
  const history = historySummary(share.shareId, chat, blockers)
  const participantCounts = { active: 0, pending: 0, revoked: 0 }
  for (const participant of share.participants) participantCounts[participant.status] += 1
  return {
    shareId: share.shareId,
    chatId: share.chatId,
    enabled: share.enabled,
    sourceDigest: sha256(
      canonicalJson({
        share: sortedPeopleSnapshot({ shares: [share] }),
        chat: chat ? sortedChats([chat]) : null,
        history
      })
    ),
    participantCounts,
    inviteCount: share.invites.length,
    pendingInviteCount: share.invites.filter((invite) => invite.consumedAt === undefined).length,
    idempotencyEntryCount: Object.keys(share.idempotency).length,
    nextSequence: share.nextSequence,
    policy,
    requiresHostApproval: share.requiresHostApproval === true,
    fullHistory: share.fullHistory === true,
    history
  }
}

function isEligibleSharedSourceChat(chat: PeopleToChannelMigrationChat): boolean {
  // P4 has two independent scopes: every ACTIVE People share migrates, while
  // the separate solo backfill decision applies to General chats. People can
  // already be attached to an Ensemble or linked child, and rejecting those
  // would strand the exact live capability P4 is meant to preserve. Workflows
  // remain outside the Chat-surface Channels scope.
  return chat.workflowOwned !== true
}

function latestParticipantRoom(
  share: HumanCollaborationShare,
  collaboratorId: string
): { roomId: string | null; ambiguous: boolean } {
  const candidates = share.invites
    .filter((invite) => invite.collaboratorId === collaboratorId && Boolean(invite.roomId))
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || compareText(left.inviteId, right.inviteId)
    )
  const latest = candidates[0]
  if (!latest?.roomId) return { roomId: null, ambiguous: false }
  return {
    roomId: latest.roomId,
    ambiguous: candidates.some(
      (candidate) => candidate.createdAt === latest.createdAt && candidate.roomId !== latest.roomId
    )
  }
}

function matchingMembers(
  members: readonly ChannelMember[],
  identityPublicKey: string
): ChannelMember[] {
  return members.filter((member) => member.identityPublicKey === identityPublicKey)
}

function buildMemberMappings(args: {
  share: HumanCollaborationShare
  existingChannel: Channel | undefined
  existingMembers: readonly ChannelMember[]
  blockers: PeopleToChannelMigrationBlocker[]
}): PeopleToChannelMemberMapping[] {
  const { share, existingChannel, existingMembers, blockers } = args
  const participantIds = new Set<string>()
  const participantIdentities = new Set<string>()
  const mappings: PeopleToChannelMemberMapping[] = []

  for (const participant of [...share.participants].sort((left, right) =>
    compareText(left.collaboratorId, right.collaboratorId)
  )) {
    if (!pathIdentifier(participant.collaboratorId)) blockers.push('invalid_source_identifier')
    if (participantIds.has(participant.collaboratorId)) blockers.push('duplicate_participant_id')
    if (participantIdentities.has(participant.publicKeyId)) {
      blockers.push('duplicate_participant_identity')
    }
    participantIds.add(participant.collaboratorId)
    participantIdentities.add(participant.publicKeyId)

    const identityMatches = matchingMembers(existingMembers, participant.publicKeyId)
    if (identityMatches.length > 1) blockers.push('target_identity_duplicated')
    const existing = identityMatches[0]
    if (existing?.kind === 'agent') blockers.push('target_member_id_conflict')
    if (existing?.status === 'revoked' && participant.status !== 'revoked') {
      blockers.push('target_identity_revoked')
    }
    if (existing && existing.status !== 'revoked' && participant.status === 'revoked') {
      blockers.push('target_revocation_conflict')
    }
    if (existing?.status === 'pending' && participant.status === 'active') {
      blockers.push('target_admission_conflict')
    }

    const targetMemberId = existing?.memberId ?? participant.collaboratorId
    const idCollision = existingMembers.find(
      (member) =>
        member.memberId === targetMemberId && member.identityPublicKey !== participant.publicKeyId
    )
    if (idCollision) blockers.push('target_member_id_conflict')

    const room = latestParticipantRoom(share, participant.collaboratorId)
    if (room.ambiguous) blockers.push('ambiguous_active_member_room')
    const roomId = room.roomId
    if (participant.status === 'active' && !roomId && !existing?.roomId) {
      blockers.push('missing_active_member_room')
    }
    mappings.push({
      sourceCollaboratorId: participant.collaboratorId,
      targetMemberId,
      sourceStatus: participant.status,
      targetStatus: existing?.status ?? participant.status,
      identityFingerprint: fingerprint(
        'people-to-channel-member-identity',
        participant.publicKeyId
      ),
      displayNameFingerprint: fingerprint(
        'people-to-channel-display-name',
        participant.displayName
      ),
      ...((existing?.roomId ?? roomId)
        ? { roomFingerprint: fingerprint('people-to-channel-room', existing?.roomId ?? roomId!) }
        : {}),
      reusedExistingMember: Boolean(existing && existingChannel)
    })
  }

  const occupied = existingMembers.filter((member) => member.status !== 'revoked').length
  const additions = mappings.filter(
    (mapping) => mapping.targetStatus !== 'revoked' && !mapping.reusedExistingMember
  ).length
  if (occupied + additions > MAX_CHANNEL_MEMBERS) blockers.push('channel_capacity_exceeded')
  return mappings
}

function requirementsFor(
  share: HumanCollaborationShare,
  source: PeopleToChannelMigrationSourceSummary,
  existingChannel: Channel | undefined
): PeopleToChannelMigrationRequirement[] {
  const requirements: PeopleToChannelMigrationRequirement[] = []
  if (existingChannel) requirements.push('existing_channel_merge_manifest')
  if (
    canonicalJson(source.policy) !== canonicalJson(contributionRulesForPreset('comments')) ||
    source.requiresHostApproval
  ) {
    requirements.push('human_policy_projection')
  }
  if (
    share.participants.some(
      (participant) =>
        participant.seatOrder !== undefined ||
        participant.colorIndex !== undefined ||
        participant.seatDisabled === true
    )
  ) {
    requirements.push('member_presentation_projection')
  }
  if (
    share.participants.length > 0 ||
    source.history.commentCount > 0 ||
    source.history.externalSeatTurnCount > 0 ||
    source.fullHistory
  ) {
    requirements.push('legacy_projection_history')
  }
  if (source.participantCounts.pending > 0 || source.pendingInviteCount > 0) {
    requirements.push('pending_admission_reissue')
  }
  if (source.inviteCount > 0) requirements.push('legacy_invite_retirement')
  return uniqueSorted(requirements)
}

function entryForShare(args: {
  share: HumanCollaborationShare
  input: PeopleToChannelMigrationPlanInput
  chatsById: ReadonlyMap<string, PeopleToChannelMigrationChat[]>
  channelsByChatId: ReadonlyMap<string, Channel[]>
  activeShareCountByChatId: ReadonlyMap<string, number>
  shareIdCount: ReadonlyMap<string, number>
}): PeopleToChannelMigrationEntry {
  const { share, input, chatsById, channelsByChatId, activeShareCountByChatId, shareIdCount } = args
  const blockers: PeopleToChannelMigrationBlocker[] = []
  const chatMatches = chatsById.get(share.chatId) ?? []
  const chat = chatMatches[0]
  if (!pathIdentifier(share.shareId) || !boundedIdentifier(share.chatId)) {
    blockers.push('invalid_source_identifier')
  }
  if ((shareIdCount.get(share.shareId) ?? 0) > 1) blockers.push('duplicate_share_id')

  const source = sourceSummary(share, chat, blockers)
  if (source.history.highestSequence >= source.nextSequence) {
    blockers.push('legacy_sequence_conflict')
  }
  if (!share.enabled) {
    return {
      source,
      target: null,
      disposition: blockers.length > 0 ? 'blocked' : 'retain_legacy',
      readiness: blockers.length > 0 ? 'blocked' : 'ready',
      blockers: uniqueSorted(blockers),
      requirements: []
    }
  }

  if (chatMatches.length > 1) blockers.push('duplicate_chat_inventory')
  if (!chat) blockers.push('missing_source_chat')
  else {
    if (!isEligibleSharedSourceChat(chat)) blockers.push('source_chat_not_channel_eligible')
    if (!chat.title.trim() || chat.title.length > 200) blockers.push('invalid_source_title')
  }
  if (input.channels.schemaVersion !== CHANNEL_SCHEMA_VERSION) {
    blockers.push('invalid_channel_schema')
  }
  if (!input.hostIdentityPublicKey.trim()) blockers.push('host_identity_missing')
  if ((activeShareCountByChatId.get(share.chatId) ?? 0) > 1) {
    blockers.push('duplicate_active_share_for_chat')
  }

  const channelMatches = channelsByChatId.get(share.chatId) ?? []
  if (channelMatches.length > 1) blockers.push('duplicate_channel_for_chat')
  const existingChannel = channelMatches[0]
  const collision = input.channels.channels.find(
    (channel) => channel.channelId === share.shareId && channel.chatId !== share.chatId
  )
  if (!existingChannel && collision) blockers.push('channel_id_collision')
  if (existingChannel?.status === 'closed') blockers.push('target_channel_closed')

  const channelId = existingChannel?.channelId ?? share.shareId
  if (!pathIdentifier(channelId)) blockers.push('invalid_target_identifier')
  const existingMembers = existingChannel
    ? input.channels.members.filter((member) => member.channelId === existingChannel.channelId)
    : []
  let ownerMemberId = derivedOwnerMemberId(channelId, input.hostIdentityPublicKey)
  if (existingChannel) {
    ownerMemberId = existingChannel.ownerMemberId
    const owner = existingMembers.find(
      (member) => member.memberId === existingChannel.ownerMemberId
    )
    if (!owner) blockers.push('target_owner_missing')
    else if (
      owner.kind !== 'human' ||
      owner.status !== 'active' ||
      owner.identityPublicKey !== input.hostIdentityPublicKey
    ) {
      blockers.push('target_owner_identity_mismatch')
    }
  }

  const memberMappings = buildMemberMappings({
    share,
    existingChannel,
    existingMembers,
    blockers
  })
  const requirements = requirementsFor(share, source, existingChannel)
  const target: PeopleToChannelMigrationTarget = {
    channelId,
    chatId: share.chatId,
    ownerMemberId,
    hostIdentityFingerprint: fingerprint(
      'people-to-channel-host-identity',
      input.hostIdentityPublicKey
    ),
    titleFingerprint: fingerprint('people-to-channel-title', chat?.title ?? ''),
    existingChannel: Boolean(existingChannel),
    memberMappings
  }
  const uniqueBlockers = uniqueSorted(blockers)
  return {
    source,
    target,
    disposition: uniqueBlockers.length > 0 ? 'blocked' : existingChannel ? 'merge' : 'create',
    readiness:
      uniqueBlockers.length > 0
        ? 'blocked'
        : requirements.length > 0
          ? 'requires_resolution'
          : 'ready',
    blockers: uniqueBlockers,
    requirements
  }
}

/**
 * Build a deterministic, read-only migration inventory. It never opens a
 * store, writes a receipt, mutates either snapshot, or decides the three
 * product-level cutover questions. Execution must re-read the source and match
 * both `sourceDigest` values before applying any result.
 */
export function createPeopleToChannelMigrationPlan(
  input: PeopleToChannelMigrationPlanInput
): PeopleToChannelMigrationPlan {
  const digest = sourceDigest(input)
  const chatsById = new Map<string, PeopleToChannelMigrationChat[]>()
  for (const chat of input.chats) {
    const matches = chatsById.get(chat.chatId)
    if (matches) matches.push(chat)
    else chatsById.set(chat.chatId, [chat])
  }
  const channelsByChatId = new Map<string, Channel[]>()
  for (const channel of input.channels.channels) {
    const matches = channelsByChatId.get(channel.chatId)
    if (matches) matches.push(channel)
    else channelsByChatId.set(channel.chatId, [channel])
  }
  const activeShareCountByChatId = new Map<string, number>()
  const shareIdCount = new Map<string, number>()
  for (const share of input.people.shares) {
    shareIdCount.set(share.shareId, (shareIdCount.get(share.shareId) ?? 0) + 1)
    if (!share.enabled) continue
    activeShareCountByChatId.set(
      share.chatId,
      (activeShareCountByChatId.get(share.chatId) ?? 0) + 1
    )
  }

  const entries = [...input.people.shares]
    .sort((left, right) => compareText(left.shareId, right.shareId))
    .map((share) =>
      entryForShare({
        share,
        input,
        chatsById,
        channelsByChatId,
        activeShareCountByChatId,
        shareIdCount
      })
    )
  return {
    schemaVersion: PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION,
    planId: fingerprint(
      'people-to-channel-migration-plan',
      `${PEOPLE_TO_CHANNEL_MIGRATION_PLAN_VERSION}\u0000${digest}`
    ),
    sourceDigest: digest,
    hostIdentityFingerprint: fingerprint(
      'people-to-channel-host-identity',
      input.hostIdentityPublicKey
    ),
    cutoverDecisions: PEOPLE_TO_CHANNEL_CUTOVER_DECISIONS,
    entries,
    summary: {
      shares: entries.length,
      create: entries.filter((entry) => entry.disposition === 'create').length,
      merge: entries.filter((entry) => entry.disposition === 'merge').length,
      retainLegacy: entries.filter((entry) => entry.disposition === 'retain_legacy').length,
      blocked: entries.filter((entry) => entry.disposition === 'blocked').length,
      requiresResolution: entries.filter((entry) => entry.readiness === 'requires_resolution')
        .length
    }
  }
}
