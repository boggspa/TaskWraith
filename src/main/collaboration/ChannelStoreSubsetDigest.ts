import { createHash } from 'crypto'

import type { Channel, ChannelInvite, ChannelMember } from './ChannelStore'

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

/** Content digest for one Channel's complete metadata ownership subset. */
export function channelStoreSubsetDigest(
  channel: Channel,
  members: readonly ChannelMember[],
  invites: readonly ChannelInvite[]
): string {
  const canonical = JSON.stringify(
    canonicalize({
      channel,
      members: [...members].sort((left, right) => compareText(left.memberId, right.memberId)),
      invites: [...invites].sort((left, right) => compareText(left.inviteId, right.inviteId))
    })
  )
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
