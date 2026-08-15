import type { ChannelMember, ChannelStore, HumanChannelMember } from './ChannelStore'
import type { ChannelHumanPolicyRecord, ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import type { HumanCollaborationShare, HumanCollaborationStore } from './HumanCollaborationStore'
import type { HumanCollaborationPresenceStateOrUnknown } from './HumanCollaborationPresence'
import type { ResolveCollaboratorPresence } from './ExternalSeatResolution'

/**
 * Main-private seat projection. seatId is a native Channel member id unless
 * an exact migration policy binds the member to a legacy collaborator id.
 *
 * This type deliberately cannot carry source share ids, policy records, relay
 * rooms, keys, tokens, or migration digests. X2 may consume it inside main but
 * must not expose the compatibility identity through UI or IPC.
 */
export interface ChannelExternalSeat {
  readonly seatId: string
  readonly displayName: string
  readonly seatOrder?: number
  readonly colorIndex?: number
  readonly enabled: boolean
  readonly present: boolean
}

export type ChannelExternalSeatPresence =
  | HumanCollaborationPresenceStateOrUnknown
  | 'recovery_blocked'

/**
 * Narrow read seam that ChannelRuntime must implement before X2 composition.
 * unknown is the restart state until replay completes; it is absent, never
 * optimistically present. recovery_blocked refuses the whole projection.
 */
export interface ChannelExternalSeatRuntimeAuthority {
  memberPresence(channelId: string, memberId: string): ChannelExternalSeatPresence
}

export type ChannelExternalSeatResolution =
  | {
      readonly state: 'ready'
      readonly isShared: boolean
      readonly seats: readonly ChannelExternalSeat[]
    }
  | {
      readonly state: 'recovery_blocked'
    }

export type ChannelExternalSeatLegacyAuthority =
  | {
      readonly mode: 'transitional'
      readonly shareStore: Pick<HumanCollaborationStore, 'getShareForChat'>
      readonly resolvePresence: ResolveCollaboratorPresence
    }
  | {
      readonly mode: 'channel_only'
    }

export interface ChannelExternalSeatAuthorityOptions {
  readonly channelStore: Pick<ChannelStore, 'listChannels' | 'listMembers'>
  readonly humanPolicyStore: Pick<ChannelHumanPolicyStore, 'list'>
  readonly runtime: ChannelExternalSeatRuntimeAuthority
  /**
   * Transitional mode is explicit so omitting the People fallback can never
   * accidentally become the Channel-only seal. X4 changes this mode only after
   * restart equivalence and zero remaining People consumers are proven.
   */
  readonly legacy: ChannelExternalSeatLegacyAuthority
}

class ProjectionBlocked extends Error {}

function blocked(): never {
  throw new ProjectionBlocked('Channel external-seat authority requires recovery')
}

function sourceKey(sourceShareId: string, sourceCollaboratorId: string): string {
  return JSON.stringify([sourceShareId, sourceCollaboratorId])
}

function isActiveExternalHuman(
  member: ChannelMember,
  ownerMemberId: string
): member is HumanChannelMember {
  return member.kind === 'human' && member.status === 'active' && member.memberId !== ownerMemberId
}

function isPresent(state: ChannelExternalSeatPresence | undefined): boolean {
  if (state === 'recovery_blocked') blocked()
  return state === 'live' || state === 'grace'
}

function seatFromMember(
  member: HumanChannelMember,
  seatId: string,
  present: boolean
): ChannelExternalSeat {
  const presentation = member.presentation
  return {
    seatId,
    displayName: member.displayName,
    ...(presentation?.seatOrder === undefined ? {} : { seatOrder: presentation.seatOrder }),
    ...(presentation?.colorIndex === undefined ? {} : { colorIndex: presentation.colorIndex }),
    enabled: presentation?.seatDisabled !== true,
    present
  }
}

function seatFromLegacyParticipant(
  participant: HumanCollaborationShare['participants'][number],
  presence: ReturnType<ResolveCollaboratorPresence>
): ChannelExternalSeat {
  return {
    seatId: participant.collaboratorId,
    displayName: participant.displayName,
    ...(participant.seatOrder === undefined ? {} : { seatOrder: participant.seatOrder }),
    ...(participant.colorIndex === undefined ? {} : { colorIndex: participant.colorIndex }),
    enabled: participant.seatDisabled !== true,
    present: isPresent(presence)
  }
}

function compareSeats(left: ChannelExternalSeat, right: ChannelExternalSeat): number {
  const leftOrder = left.seatOrder ?? Number.MAX_SAFE_INTEGER
  const rightOrder = right.seatOrder ?? Number.MAX_SAFE_INTEGER
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  return left.seatId < right.seatId ? -1 : left.seatId > right.seatId ? 1 : 0
}

/**
 * Channel-native external-seat authority.
 *
 * It is a projection over the already-durable Channel metadata and migration
 * policy stores plus ChannelRuntime presence. It owns no persistence. During
 * transition it unions one exact enabled People share and dedupes only through
 * the durable source-share/source-collaborator to Channel-member binding.
 */
export class ChannelExternalSeatAuthority {
  constructor(private readonly options: ChannelExternalSeatAuthorityOptions) {}

  resolve(chatId: string): ChannelExternalSeatResolution {
    try {
      return this.resolveReady(chatId)
    } catch {
      // Store corruption, incomplete recovery, mapping ambiguity, and runtime
      // unavailability all have the same safe answer: callers must refuse work.
      return { state: 'recovery_blocked' }
    }
  }

  private resolveReady(chatId: string): Extract<ChannelExternalSeatResolution, { state: 'ready' }> {
    if (typeof chatId !== 'string' || !chatId.trim() || chatId.trim() !== chatId) blocked()

    const matchingChannels = this.options.channelStore
      .listChannels()
      .filter((channel) => channel.chatId === chatId)
    if (matchingChannels.length > 1) blocked()
    const matchedChannel = matchingChannels[0]
    const activeChannel = matchedChannel?.status === 'active' ? matchedChannel : undefined

    const seats: ChannelExternalSeat[] = []
    const seenSeatIds = new Set<string>()
    const channelSeatSources = new Set<string>()
    let policyBySource = new Map<string, ChannelHumanPolicyRecord>()
    let memberById = new Map<string, ChannelMember>()

    if (activeChannel) {
      const members = this.options.channelStore.listMembers(activeChannel.channelId)
      memberById = new Map()
      for (const member of members) {
        if (member.channelId !== activeChannel.channelId || memberById.has(member.memberId))
          blocked()
        memberById.set(member.memberId, member)
      }
      const owner = memberById.get(activeChannel.ownerMemberId)
      if (!owner || owner.kind !== 'human' || owner.status !== 'active') blocked()

      const policies = this.options.humanPolicyStore.list(activeChannel.channelId)
      const policyByMember = new Map<string, ChannelHumanPolicyRecord>()
      policyBySource = new Map()
      for (const policy of policies) {
        if (policy.channelId !== activeChannel.channelId || policyByMember.has(policy.memberId)) {
          blocked()
        }
        const member = memberById.get(policy.memberId)
        if (!member || member.kind !== 'human' || member.memberId === activeChannel.ownerMemberId) {
          blocked()
        }
        const key = sourceKey(policy.sourceShareId, policy.sourceCollaboratorId)
        if (policyBySource.has(key)) blocked()
        policyByMember.set(policy.memberId, policy)
        policyBySource.set(key, policy)
      }

      const activeExternalMembers = members
        .filter((member): member is HumanChannelMember =>
          isActiveExternalHuman(member, activeChannel.ownerMemberId)
        )
        .sort((left, right) => left.memberId.localeCompare(right.memberId))

      for (const member of activeExternalMembers) {
        const policy = policyByMember.get(member.memberId)
        const seatId = policy?.sourceCollaboratorId ?? member.memberId
        if (seenSeatIds.has(seatId)) blocked()
        const presence = this.options.runtime.memberPresence(
          activeChannel.channelId,
          member.memberId
        )
        seats.push(seatFromMember(member, seatId, isPresent(presence)))
        seenSeatIds.add(seatId)
        if (policy) {
          channelSeatSources.add(sourceKey(policy.sourceShareId, policy.sourceCollaboratorId))
        }
      }
    }

    let legacyShare: HumanCollaborationShare | null = null
    if (this.options.legacy.mode === 'transitional') {
      legacyShare = this.options.legacy.shareStore.getShareForChat(chatId)
      if (legacyShare && (legacyShare.chatId !== chatId || legacyShare.enabled !== true)) blocked()
      if (legacyShare && matchedChannel?.status === 'closed') blocked()

      if (legacyShare) {
        const activeParticipants = legacyShare.participants
          .filter((participant) => participant.status === 'active')
          .sort((left, right) => left.collaboratorId.localeCompare(right.collaboratorId))
        const activeParticipantKeys = new Set(
          activeParticipants.map((participant) =>
            sourceKey(legacyShare!.shareId, participant.collaboratorId)
          )
        )

        for (const policy of policyBySource.values()) {
          const key = sourceKey(policy.sourceShareId, policy.sourceCollaboratorId)
          if (
            channelSeatSources.has(key) &&
            policy.sourceShareId === legacyShare.shareId &&
            !activeParticipantKeys.has(key)
          ) {
            blocked()
          }
        }

        for (const participant of activeParticipants) {
          const key = sourceKey(legacyShare.shareId, participant.collaboratorId)
          const binding = policyBySource.get(key)
          if (binding) {
            const member = memberById.get(binding.memberId)
            if (
              !activeChannel ||
              !member ||
              !isActiveExternalHuman(member, activeChannel.ownerMemberId) ||
              !channelSeatSources.has(key)
            ) {
              blocked()
            }
            continue
          }
          if (seenSeatIds.has(participant.collaboratorId)) blocked()
          const presence = this.options.legacy.resolvePresence(participant.collaboratorId)
          seats.push(seatFromLegacyParticipant(participant, presence))
          seenSeatIds.add(participant.collaboratorId)
        }
      }
    }

    seats.sort(compareSeats)
    return {
      state: 'ready',
      isShared: Boolean(activeChannel || legacyShare),
      seats
    }
  }
}
