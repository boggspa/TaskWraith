import { createHash } from 'crypto'

import type { HumanCollaborationInvite, HumanCollaborationShare } from './HumanCollaborationStore'
import type { HumanContributionRules } from './HumanContributionRules'
import type { ChannelHumanMigrationPolicyInput } from './ChannelHumanPolicyStore'
import type { Channel, ChannelInvite, ChannelMember, HumanChannelMember } from './ChannelStore'
import { channelStoreSubsetDigest } from './ChannelStoreSubsetDigest'
import {
  createPeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlan,
  type PeopleToChannelMigrationPlanInput,
  type PeopleToChannelMigrationRequirement
} from './PeopleToChannelMigrationPlan'

export { channelStoreSubsetDigest as peopleToChannelChannelSubsetDigest } from './ChannelStoreSubsetDigest'

export const PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION = 1

export interface PeopleToChannelChannelMutation {
  mode: 'create' | 'merge'
  beforeDigest: string | null
  channel: Channel
  members: ChannelMember[]
  invites: ChannelInvite[]
}

export interface PeopleToChannelPendingAdmissionPolicy {
  sourceDigest: string
  rules: HumanContributionRules
  requiresHostApproval: boolean
  fullHistory: boolean
}

export interface PeopleToChannelPendingAdmissionReissue {
  sourceShareId: string
  channelId: string
  pendingCollaboratorIds: string[]
  openInviteCount: number
  policy: PeopleToChannelPendingAdmissionPolicy
}

export interface PeopleToChannelMigrationMaterialization {
  schemaVersion: typeof PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION
  planId: string
  sourceDigest: string
  migrationAt: number
  mutations: PeopleToChannelChannelMutation[]
  policies: ChannelHumanMigrationPolicyInput[]
  pendingAdmissionReissues: PeopleToChannelPendingAdmissionReissue[]
  migratedShareIds: string[]
  retainedShareIds: string[]
  requirements: PeopleToChannelMigrationRequirement[]
  materializationDigest: string
}

export class PeopleToChannelMigrationMaterializationError extends Error {
  readonly code = 'recovery_blocked'

  constructor(message: string) {
    super(message)
    this.name = 'PeopleToChannelMigrationMaterializationError'
  }
}

function blocked(message: string): never {
  throw new PeopleToChannelMigrationMaterializationError(message)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function fingerprint(domain: string, value: string): string {
  return sha256(`${domain}\u0000${value}`)
}

function safeMigrationTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) blocked('Migration timestamp is invalid')
  return value
}

function boundedDisplayName(value: string): string {
  if (!value || value.trim() !== value || value.length > 120) {
    blocked('Migration host display name is invalid')
  }
  return value
}

function latestRoom(
  invites: readonly HumanCollaborationInvite[],
  collaboratorId: string
): string | undefined {
  return [...invites]
    .filter((invite) => invite.collaboratorId === collaboratorId && Boolean(invite.roomId))
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt || compareText(left.inviteId, right.inviteId)
    )[0]?.roomId
}

function memberFromSource(args: {
  share: HumanCollaborationShare
  channelId: string
  targetMemberId: string
  participant: HumanCollaborationShare['participants'][number]
}): HumanChannelMember {
  const { share, channelId, targetMemberId, participant } = args
  if (!participant.publicKeyId || !participant.displayName) {
    blocked('Migration participant identity is incomplete')
  }
  if (participant.status === 'pending') blocked('Pending People members must be reissued')
  if (participant.status === 'active' && participant.joinedAt === undefined) {
    blocked('Active People member has no admission timestamp')
  }
  if (participant.status === 'revoked' && participant.revokedAt === undefined) {
    blocked('Revoked People member has no revocation timestamp')
  }
  const roomId =
    participant.status === 'active'
      ? latestRoom(share.invites, participant.collaboratorId)
      : undefined
  if (participant.status === 'active' && !roomId) {
    blocked('Active People member has no relay room')
  }
  const joinedAt =
    participant.joinedAt ?? Math.min(share.createdAt, participant.revokedAt ?? share.createdAt)
  return {
    memberId: targetMemberId,
    channelId,
    kind: 'human',
    displayName: participant.displayName,
    identityPublicKey: participant.publicKeyId,
    status: participant.status,
    ...(roomId ? { roomId } : {}),
    joinedAt,
    ...(participant.revokedAt === undefined ? {} : { revokedAt: participant.revokedAt })
  }
}

function materializationDigest(
  value: Omit<PeopleToChannelMigrationMaterialization, 'materializationDigest'>
): string {
  return sha256(canonicalJson(value))
}

/**
 * Builds the exact in-memory Channel state that a later transactional writer
 * may apply. The result contains identity/display/room bytes and therefore
 * must never be persisted as a migration intent or receipt; only its digest is
 * recovery evidence.
 */
export function materializePeopleToChannels(input: {
  plan: PeopleToChannelMigrationPlan
  source: PeopleToChannelMigrationPlanInput
  hostDisplayName: string
  migrationAt: number
}): PeopleToChannelMigrationMaterialization {
  const migrationAt = safeMigrationTime(input.migrationAt)
  const hostDisplayName = boundedDisplayName(input.hostDisplayName)
  const regenerated = createPeopleToChannelMigrationPlan(input.source)
  if (canonicalJson(regenerated) !== canonicalJson(input.plan)) {
    blocked('Migration plan no longer matches its source inventory')
  }
  if (
    input.plan.entries.some((entry) => entry.disposition === 'blocked' || entry.blockers.length > 0)
  ) {
    blocked('Blocked migration plan cannot be materialized')
  }

  const shares = new Map(input.source.people.shares.map((share) => [share.shareId, share]))
  const chats = new Map(input.source.chats.map((chat) => [chat.chatId, chat]))
  const mutations: PeopleToChannelChannelMutation[] = []
  const policies: ChannelHumanMigrationPolicyInput[] = []
  const pendingAdmissionReissues: PeopleToChannelPendingAdmissionReissue[] = []
  const migratedShareIds: string[] = []
  const retainedShareIds: string[] = []
  const requirements = new Set<PeopleToChannelMigrationRequirement>()

  for (const entry of input.plan.entries) {
    if (entry.disposition === 'retain_legacy') {
      retainedShareIds.push(entry.source.shareId)
      continue
    }
    const share = shares.get(entry.source.shareId)
    const chat = share ? chats.get(share.chatId) : undefined
    const target = entry.target
    if (!share || !share.enabled || !chat || !target) {
      blocked('Executable migration entry has incomplete source state')
    }
    if (
      target.hostIdentityFingerprint !==
        fingerprint('people-to-channel-host-identity', input.source.hostIdentityPublicKey) ||
      target.titleFingerprint !== fingerprint('people-to-channel-title', chat.title)
    ) {
      blocked('Migration target fingerprints no longer match source content')
    }
    const existingChannel = input.source.channels.channels.find(
      (channel) => channel.channelId === target.channelId
    )
    if ((entry.disposition === 'merge') !== Boolean(existingChannel)) {
      blocked('Migration disposition no longer matches Channel state')
    }
    const existingMembers = existingChannel
      ? input.source.channels.members.filter(
          (member) => member.channelId === existingChannel.channelId
        )
      : []
    const existingInvites = existingChannel
      ? input.source.channels.invites.filter(
          (invite) => invite.channelId === existingChannel.channelId
        )
      : []
    const finalMembers = existingMembers.map(clone)
    if (!existingChannel) {
      if (
        input.source.channels.members.some((member) => member.memberId === target.ownerMemberId)
      ) {
        blocked('Migration owner member id collides with Channel state')
      }
      finalMembers.push({
        memberId: target.ownerMemberId,
        channelId: target.channelId,
        kind: 'human',
        displayName: hostDisplayName,
        identityPublicKey: input.source.hostIdentityPublicKey,
        status: 'active',
        joinedAt: migrationAt
      })
    }

    const pendingCollaboratorIds: string[] = []
    let addedMembers = 0
    for (const participant of [...share.participants].sort((left, right) =>
      compareText(left.collaboratorId, right.collaboratorId)
    )) {
      const mapping = target.memberMappings.find(
        (candidate) => candidate.sourceCollaboratorId === participant.collaboratorId
      )
      if (
        !mapping ||
        mapping.identityFingerprint !==
          fingerprint('people-to-channel-member-identity', participant.publicKeyId) ||
        mapping.displayNameFingerprint !==
          fingerprint('people-to-channel-display-name', participant.displayName)
      ) {
        blocked('Migration member mapping no longer matches source identity')
      }
      if (participant.status === 'pending') {
        if (!mapping.reusedExistingMember) pendingCollaboratorIds.push(participant.collaboratorId)
        continue
      }
      let targetMember = finalMembers.find((member) => member.memberId === mapping.targetMemberId)
      if (mapping.reusedExistingMember) {
        if (
          !targetMember ||
          targetMember.kind !== 'human' ||
          targetMember.identityPublicKey !== participant.publicKeyId ||
          targetMember.status !== mapping.targetStatus
        ) {
          blocked('Reused Channel member no longer matches migration authority')
        }
      } else {
        if (
          targetMember ||
          input.source.channels.members.some((member) => member.memberId === mapping.targetMemberId)
        ) {
          blocked('Migration member id collides with Channel state')
        }
        targetMember = memberFromSource({
          share,
          channelId: target.channelId,
          targetMemberId: mapping.targetMemberId,
          participant
        })
        if (
          targetMember.roomId &&
          (input.source.channels.members.some((member) => member.roomId === targetMember!.roomId) ||
            input.source.channels.invites.some((invite) => invite.roomId === targetMember!.roomId))
        ) {
          blocked('Migration member room collides with Channel state')
        }
        finalMembers.push(targetMember)
        addedMembers += 1
      }
      if (participant.status === 'active') {
        policies.push({
          channelId: target.channelId,
          memberId: mapping.targetMemberId,
          sourceShareId: share.shareId,
          sourceCollaboratorId: participant.collaboratorId,
          sourceDigest: entry.source.sourceDigest,
          rules: clone(entry.source.policy),
          requiresHostApproval: entry.source.requiresHostApproval,
          fullHistory: entry.source.fullHistory
        })
      }
    }

    const openInviteCount = share.invites.filter(
      (invite) => invite.consumedAt === undefined && invite.expiresAt > migrationAt
    ).length
    if (pendingCollaboratorIds.length > 0 || openInviteCount > 0) {
      pendingAdmissionReissues.push({
        sourceShareId: share.shareId,
        channelId: target.channelId,
        pendingCollaboratorIds,
        openInviteCount,
        policy: {
          sourceDigest: entry.source.sourceDigest,
          rules: clone(entry.source.policy),
          requiresHostApproval: entry.source.requiresHostApproval,
          fullHistory: entry.source.fullHistory
        }
      })
    }

    finalMembers.sort((left, right) => compareText(left.memberId, right.memberId))
    const activeCount = finalMembers.filter((member) => member.status === 'active').length
    const channel: Channel = existingChannel
      ? {
          ...clone(existingChannel),
          ...(addedMembers > 0
            ? {
                updatedAt: Math.max(existingChannel.updatedAt, migrationAt),
                membershipRevision: existingChannel.membershipRevision + addedMembers,
                display: { ...existingChannel.display, memberCount: activeCount }
              }
            : {})
        }
      : {
          channelId: target.channelId,
          chatId: share.chatId,
          ownerMemberId: target.ownerMemberId,
          status: 'active',
          createdAt: migrationAt,
          updatedAt: migrationAt,
          membershipRevision: Math.max(1, finalMembers.length),
          messageCount: 0,
          reference: { kind: 'chat', id: share.chatId },
          display: {
            title: chat.title,
            status: 'active',
            memberCount: activeCount,
            messageCount: 0
          }
        }
    mutations.push({
      mode: existingChannel ? 'merge' : 'create',
      beforeDigest: existingChannel
        ? channelStoreSubsetDigest(existingChannel, existingMembers, existingInvites)
        : null,
      channel,
      members: finalMembers,
      invites: existingInvites.map(clone)
    })
    migratedShareIds.push(share.shareId)
    entry.requirements.forEach((requirement) => requirements.add(requirement))
  }

  const withoutDigest: Omit<PeopleToChannelMigrationMaterialization, 'materializationDigest'> = {
    schemaVersion: PEOPLE_TO_CHANNEL_MATERIALIZATION_VERSION,
    planId: input.plan.planId,
    sourceDigest: input.plan.sourceDigest,
    migrationAt,
    mutations: mutations.sort((left, right) =>
      compareText(left.channel.channelId, right.channel.channelId)
    ),
    policies: policies.sort((left, right) =>
      compareText(
        `${left.channelId}\u0000${left.memberId}`,
        `${right.channelId}\u0000${right.memberId}`
      )
    ),
    pendingAdmissionReissues: pendingAdmissionReissues.sort((left, right) =>
      compareText(left.sourceShareId, right.sourceShareId)
    ),
    migratedShareIds: migratedShareIds.sort(compareText),
    retainedShareIds: retainedShareIds.sort(compareText),
    requirements: [...requirements].sort()
  }
  return {
    ...withoutDigest,
    materializationDigest: materializationDigest(withoutDigest)
  }
}
