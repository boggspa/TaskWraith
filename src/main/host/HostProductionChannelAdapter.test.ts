import { describe, expect, it, vi } from 'vitest'

import type { ChannelProductionService } from '../collaboration/ChannelProductionService'
import { ChannelError } from '../collaboration/ChannelStore'
import { createHostProductionChannelAdapter } from './HostProductionChannelAdapter'

function service(): Pick<
  ChannelProductionService,
  'status' | 'listChannels' | 'inspectChannel' | 'revokeMember' | 'closeChannel'
> {
  const channel = {
    channelId: 'channel-a',
    chatId: 'thread-a',
    ownerMemberId: 'owner-a',
    status: 'active' as const,
    createdAt: 1,
    updatedAt: 5,
    membershipRevision: 2,
    messageCount: 3,
    display: { title: 'Shared work', status: 'active' as const, memberCount: 2, messageCount: 3 },
    availability: 'ready' as const,
    roomId: 'must-not-project',
    inviteToken: 'must-not-project'
  }
  return {
    status: vi.fn(() => ({
      state: 'running' as const,
      channelCount: 1,
      recoveryBlockedChannelCount: 0,
      openRoomCount: 1
    })),
    listChannels: vi.fn(() => [channel]),
    inspectChannel: vi.fn(() => ({
      channel,
      members: [
        {
          memberId: 'owner-a',
          channelId: 'channel-a',
          kind: 'human' as const,
          displayName: 'Owner',
          status: 'active' as const,
          joinedAt: 1,
          presentation: { seatOrder: 1, colorIndex: 2, seatDisabled: true },
          identityPublicKey: 'must-not-project'
        }
      ],
      pendingAdmissionCount: 1,
      pendingHumanReviewCount: 2
    })),
    revokeMember: vi.fn(async ({ channelId, memberId }) => ({
      memberId,
      channelId,
      kind: 'human' as const,
      displayName: 'Member',
      status: 'revoked' as const,
      joinedAt: 2,
      revokedAt: 6
    })),
    closeChannel: vi.fn(async () => ({ ...channel, status: 'closed' as const }))
  } as never
}

describe('HostProductionChannelAdapter', () => {
  it('projects compact metadata without Channel resources or credentials', () => {
    const adapter = createHostProductionChannelAdapter({ getService: service })
    const projected = adapter.listChannels()

    expect(projected).toEqual([
      {
        channelId: 'channel-a',
        threadId: 'thread-a',
        ownerMemberId: 'owner-a',
        title: 'Shared work',
        status: 'active',
        availability: 'ready',
        membershipRevision: 2,
        memberCount: 2,
        messageCount: 3,
        updatedAt: 5,
        members: [
          {
            memberId: 'owner-a',
            kind: 'human',
            displayName: 'Owner',
            status: 'active'
          }
        ],
        pendingAdmissionCount: 1,
        pendingHumanReviewCount: 2
      }
    ])
    expect(JSON.stringify(projected)).not.toMatch(
      /roomId|inviteToken|identityPublicKey|seatDisabled/
    )
  })

  it('reports source absence honestly and maps Channel admin failures', async () => {
    const unavailable = createHostProductionChannelAdapter({ getService: () => null })
    expect(unavailable.listChannels()).toBeUndefined()
    await expect(unavailable.closeChannel('channel-a')).resolves.toMatchObject({
      ok: false,
      code: 'host_unavailable'
    })

    const active = service()
    active.revokeMember = vi.fn(async () => {
      throw new ChannelError('human_only', 'Agent removal requires signed owner revocation')
    })
    const adapter = createHostProductionChannelAdapter({ getService: () => active })
    await expect(
      adapter.revokeMember({ channelId: 'channel-a', memberId: 'agent-a' })
    ).resolves.toEqual({
      ok: false,
      code: 'human_only',
      message: 'Agent removal requires signed owner revocation'
    })
  })
})
