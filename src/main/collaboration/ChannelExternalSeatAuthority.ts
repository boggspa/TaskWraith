import type { ChannelMember, ChannelStore, HumanChannelMember } from './ChannelStore'
import type { ChannelHumanPolicyRecord, ChannelHumanPolicyStore } from './ChannelHumanPolicyStore'
import type { HumanCollaborationPresenceStateOrUnknown } from './HumanCollaborationPresence'

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
  channelAuthorityState(channelId: string): 'ready' | 'recovery_blocked'
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

export type ChannelExternalSeatLegacyAuthority = {
  readonly mode: 'channel_only'
}

export interface ChannelExternalSeatAuthorityOptions {
  readonly channelStore: Pick<ChannelStore, 'listChannels' | 'listMembers'>
  readonly humanPolicyStore: Pick<ChannelHumanPolicyStore, 'list'>
  readonly runtime: ChannelExternalSeatRuntimeAuthority
  /**
   * Channel-only is explicit so legacy People reads cannot return by omission.
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
 * policy stores plus ChannelRuntime presence. It owns no persistence and reads
 * no legacy People state.
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
    if (
      activeChannel &&
      this.options.runtime.channelAuthorityState(activeChannel.channelId) !== 'ready'
    ) {
      blocked()
    }

    const seats: ChannelExternalSeat[] = []
    const seenSeatIds = new Set<string>()
    const seenPolicySources = new Set<string>()

    if (activeChannel) {
      const members = this.options.channelStore.listMembers(activeChannel.channelId)
      const memberById = new Map<string, ChannelMember>()
      for (const member of members) {
        if (member.channelId !== activeChannel.channelId || memberById.has(member.memberId))
          blocked()
        memberById.set(member.memberId, member)
      }
      const owner = memberById.get(activeChannel.ownerMemberId)
      if (!owner || owner.kind !== 'human' || owner.status !== 'active') blocked()

      const policies = this.options.humanPolicyStore.list(activeChannel.channelId)
      const policyByMember = new Map<string, ChannelHumanPolicyRecord>()
      for (const policy of policies) {
        if (policy.channelId !== activeChannel.channelId || policyByMember.has(policy.memberId)) {
          blocked()
        }
        const member = memberById.get(policy.memberId)
        if (!member || member.kind !== 'human' || member.memberId === activeChannel.ownerMemberId) {
          blocked()
        }
        const key = sourceKey(policy.sourceShareId, policy.sourceCollaboratorId)
        if (seenPolicySources.has(key)) blocked()
        policyByMember.set(policy.memberId, policy)
        seenPolicySources.add(key)
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
      }
    }

    seats.sort(compareSeats)
    return {
      state: 'ready',
      isShared: Boolean(activeChannel),
      seats
    }
  }
}
