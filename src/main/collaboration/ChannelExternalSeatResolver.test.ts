import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { ChannelExternalSeatResolverService } from './ChannelExternalSeatResolver'
import { resolveChannelExternalSeatsForChat } from './ChannelExternalSeatResolver'

function service(
  args: {
    state?: 'running' | 'stopped'
    includeExternal?: boolean
    recoveryBlocked?: boolean
  } = {}
): ChannelExternalSeatResolverService {
  const channel = {
    channelId: 'channel-1',
    chatId: 'chat-1',
    status: 'active',
    ownerMemberId: 'owner-1'
  }
  const members = [
    {
      channelId: channel.channelId,
      memberId: channel.ownerMemberId,
      kind: 'human',
      status: 'active',
      displayName: 'Owner'
    },
    ...(args.includeExternal
      ? [
          {
            channelId: channel.channelId,
            memberId: 'external-1',
            kind: 'human',
            status: 'active',
            displayName: 'External'
          }
        ]
      : [])
  ]
  return {
    status: () => ({ state: args.state ?? 'running' }) as never,
    externalSeatChannelStore: () =>
      ({
        listChannels: () => [channel],
        listMembers: () => members
      }) as never,
    externalSeatHumanPolicyStore: () => ({ list: () => [] }) as never,
    externalSeatRuntimeAuthority: () => ({
      channelAuthorityState: () => (args.recoveryBlocked ? 'recovery_blocked' : 'ready'),
      memberPresence: () => 'live'
    })
  }
}

describe('resolveChannelExternalSeatsForChat', () => {
  it('keeps the X4 Channel-only seal and has no People fallback port', () => {
    const source = readFileSync(
      new URL('./ChannelExternalSeatResolver.ts', import.meta.url),
      'utf8'
    )
    expect(source).toContain("legacy: { mode: 'channel_only' }")
    expect(source).not.toContain("mode: 'transitional'")
    expect(source).not.toContain('shareStore:')
    expect(source).not.toContain('resolvePresence:')
  })

  it('returns strict null when the production authority cannot be enumerated', () => {
    expect(resolveChannelExternalSeatsForChat({ chatId: 'chat-1', service: null })).toBeNull()
    expect(
      resolveChannelExternalSeatsForChat({
        chatId: 'chat-1',
        service: service({ state: 'stopped' })
      })
    ).toBeNull()
    expect(resolveChannelExternalSeatsForChat({ chatId: '', service: service() })).toBeNull()
    expect(
      resolveChannelExternalSeatsForChat({
        chatId: 'chat-1',
        service: service({ recoveryBlocked: true })
      })
    ).toBeNull()
  })

  it('returns a strict empty array for a readable owner-only Channel', () => {
    expect(resolveChannelExternalSeatsForChat({ chatId: 'chat-1', service: service() })).toEqual([])
  })

  it('returns the real Channel-native external seat when membership is readable', () => {
    expect(
      resolveChannelExternalSeatsForChat({
        chatId: 'chat-1',
        service: service({ includeExternal: true })
      })
    ).toEqual([
      expect.objectContaining({
        seatId: 'external-1',
        displayName: 'External',
        enabled: true,
        present: true
      })
    ])
  })
})
