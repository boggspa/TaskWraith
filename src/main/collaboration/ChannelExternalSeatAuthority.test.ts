import { describe, expect, it } from 'vitest'
import type { Channel, ChannelMember, HumanChannelMember } from './ChannelStore'
import type { ChannelHumanPolicyRecord } from './ChannelHumanPolicyStore'
import {
  ChannelExternalSeatAuthority,
  type ChannelExternalSeatAuthorityOptions,
  type ChannelExternalSeatPresence
} from './ChannelExternalSeatAuthority'

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    channelId: 'channel-1',
    chatId: 'chat-1',
    ownerMemberId: 'owner-1',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    membershipRevision: 1,
    messageCount: 0,
    display: {
      title: 'Shared chat',
      status: overrides.status ?? 'active',
      memberCount: 1,
      messageCount: 0
    },
    ...overrides
  }
}

function makeHumanMember(overrides: Partial<HumanChannelMember> = {}): HumanChannelMember {
  return {
    memberId: 'member-1',
    channelId: 'channel-1',
    kind: 'human',
    displayName: 'Alex',
    identityPublicKey: 'identity-1',
    status: 'active',
    joinedAt: 1,
    ...overrides
  }
}

function makePolicy(overrides: Partial<ChannelHumanPolicyRecord> = {}): ChannelHumanPolicyRecord {
  return {
    schemaVersion: 1,
    migrationPlanId: 'a'.repeat(64),
    channelId: 'channel-1',
    memberId: 'member-1',
    sourceShareId: 'share-1',
    sourceCollaboratorId: 'legacy-alex',
    sourceDigest: 'b'.repeat(64),
    rules: {
      appendText: true,
      requestHostAction: false,
      providerDispatch: 'never',
      maxMessageBytes: 1_000,
      maxMessagesPerMinute: 10
    },
    requiresHostApproval: false,
    fullHistory: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ChannelHumanPolicyRecord
}

function harness(
  input: {
    channels?: Channel[]
    members?: ChannelMember[]
    policies?: ChannelHumanPolicyRecord[]
    channelPresence?: (channelId: string, memberId: string) => ChannelExternalSeatPresence
    channelAuthorityState?: (channelId: string) => 'ready' | 'recovery_blocked'
    overrides?: Partial<ChannelExternalSeatAuthorityOptions>
  } = {}
): ChannelExternalSeatAuthority {
  const channels = input.channels ?? []
  const members = input.members ?? []
  const policies = input.policies ?? []
  return new ChannelExternalSeatAuthority({
    channelStore: {
      listChannels: () => channels,
      listMembers: (channelId) => members.filter((member) => member.channelId === channelId)
    },
    humanPolicyStore: {
      list: (channelId) => policies.filter((policy) => policy.channelId === channelId)
    },
    runtime: {
      channelAuthorityState: input.channelAuthorityState ?? (() => 'ready'),
      memberPresence: input.channelPresence ?? (() => 'unknown')
    },
    legacy: { mode: 'channel_only' },
    ...input.overrides
  })
}

describe('ChannelExternalSeatAuthority', () => {
  it('consults scoped recovery even when an active Channel has no external seats', () => {
    const channel = makeChannel()
    const consultedChannelIds: string[] = []
    const input = {
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId })]
    }

    const blockedResult = harness({
      ...input,
      channelAuthorityState: (channelId) => {
        consultedChannelIds.push(channelId)
        return 'recovery_blocked'
      }
    }).resolve(channel.chatId)

    expect(consultedChannelIds).toEqual([channel.channelId])
    expect(blockedResult).toEqual({ state: 'recovery_blocked' })

    expect(
      harness({
        ...input,
        channelAuthorityState: () => 'ready'
      }).resolve(channel.chatId)
    ).toEqual({ state: 'ready', isShared: true, seats: [] })
  })

  it('distinguishes a ready unshared chat from recovery-blocked authority', () => {
    expect(harness().resolve('chat-1')).toEqual({
      state: 'ready',
      isShared: false,
      seats: []
    })

    expect(
      harness({
        overrides: {
          channelStore: {
            listChannels: () => {
              throw new Error('corrupt')
            },
            listMembers: () => []
          }
        }
      }).resolve('chat-1')
    ).toEqual({ state: 'recovery_blocked' })
  })

  it('projects every active non-owner human member and no other member kind or status', () => {
    const channel = makeChannel()
    const members: ChannelMember[] = [
      makeHumanMember({ memberId: channel.ownerMemberId, displayName: 'Owner' }),
      makeHumanMember({
        memberId: 'native-active',
        displayName: 'Native human',
        presentation: { seatOrder: 3, colorIndex: 6, seatDisabled: true }
      }),
      makeHumanMember({ memberId: 'native-pending', status: 'pending' }),
      makeHumanMember({ memberId: 'native-revoked', status: 'revoked', revokedAt: 2 }),
      {
        memberId: 'agent-1',
        channelId: channel.channelId,
        kind: 'agent',
        displayName: 'Agent',
        identityPublicKey: 'agent-key',
        status: 'active',
        joinedAt: 1,
        agentSeatId: 'agent-seat',
        keyGeneration: 1
      }
    ]
    const result = harness({
      channels: [channel],
      members,
      channelPresence: (_channelId, memberId) => (memberId === 'native-active' ? 'grace' : 'live')
    }).resolve(channel.chatId)

    expect(result).toEqual({
      state: 'ready',
      isShared: true,
      seats: [
        {
          seatId: 'native-active',
          displayName: 'Native human',
          seatOrder: 3,
          colorIndex: 6,
          enabled: false,
          present: true
        }
      ]
    })
  })

  it('uses the exact policy binding as the private compatibility seat identity', () => {
    const channel = makeChannel()
    const member = makeHumanMember({
      memberId: 'channel-member',
      presentation: { seatOrder: 2, colorIndex: 4 }
    })
    const result = harness({
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId }), member],
      policies: [makePolicy({ memberId: member.memberId })],
      channelPresence: () => 'live'
    }).resolve(channel.chatId)

    expect(result).toEqual({
      state: 'ready',
      isShared: true,
      seats: [
        {
          seatId: 'legacy-alex',
          displayName: 'Alex',
          seatOrder: 2,
          colorIndex: 4,
          enabled: true,
          present: true
        }
      ]
    })
    expect(Object.keys(result.state === 'ready' ? (result.seats[0] ?? {}) : {})).toEqual([
      'seatId',
      'displayName',
      'seatOrder',
      'colorIndex',
      'enabled',
      'present'
    ])
  })

  it('projects mapped and native Channel seats without synthesizing legacy participants', () => {
    const channel = makeChannel()
    const mapped = makeHumanMember({
      memberId: 'mapped-member',
      displayName: 'Mapped Channel member',
      presentation: { seatOrder: 2 }
    })
    const native = makeHumanMember({
      memberId: 'native-member',
      displayName: 'Native Channel member',
      identityPublicKey: 'identity-2',
      presentation: { seatOrder: 5 }
    })
    const result = harness({
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId }), mapped, native],
      policies: [makePolicy({ memberId: mapped.memberId })],
      channelPresence: () => 'live'
    }).resolve(channel.chatId)

    expect(result).toEqual({
      state: 'ready',
      isShared: true,
      seats: [
        {
          seatId: 'legacy-alex',
          displayName: 'Mapped Channel member',
          seatOrder: 2,
          enabled: true,
          present: true
        },
        {
          seatId: 'native-member',
          displayName: 'Native Channel member',
          seatOrder: 5,
          enabled: true,
          present: true
        }
      ]
    })
  })

  it('does not treat migration policy data as shared without an active Channel', () => {
    expect(harness({ policies: [makePolicy()] }).resolve('chat-1')).toEqual({
      state: 'ready',
      isShared: false,
      seats: []
    })
  })

  it('does not serve a closed Channel and blocks malformed active ownership', () => {
    const closed = makeChannel({
      status: 'closed',
      display: {
        title: 'Closed chat',
        status: 'closed',
        memberCount: 1,
        messageCount: 0
      }
    })
    expect(
      harness({
        channels: [closed],
        members: [makeHumanMember({ memberId: closed.ownerMemberId })]
      }).resolve(closed.chatId)
    ).toEqual({ state: 'ready', isShared: false, seats: [] })

    const active = makeChannel()
    expect(
      harness({
        channels: [active],
        members: [makeHumanMember({ memberId: 'not-the-owner' })]
      }).resolve(active.chatId)
    ).toEqual({ state: 'recovery_blocked' })
  })

  it('starts with no phantom presence after restart until Channel replay is live', () => {
    const channel = makeChannel()
    const member = makeHumanMember({ memberId: 'native-active' })
    const result = harness({
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId }), member],
      channelPresence: () => 'unknown'
    }).resolve(channel.chatId)

    expect(result.state).toBe('ready')
    if (result.state !== 'ready') throw new Error('expected ready authority')
    expect(result.seats[0]?.present).toBe(false)
  })

  it('blocks rather than serving partial seats when runtime recovery is incomplete', () => {
    const channel = makeChannel()
    const result = harness({
      channels: [channel],
      members: [
        makeHumanMember({ memberId: channel.ownerMemberId }),
        makeHumanMember({ memberId: 'native-active' })
      ],
      channelPresence: () => 'recovery_blocked'
    }).resolve(channel.chatId)

    expect(result).toEqual({ state: 'recovery_blocked' })
  })

  it('does not project an inactive policy-bound member', () => {
    const channel = makeChannel()
    const revoked = makeHumanMember({
      memberId: 'mapped-member',
      status: 'revoked',
      revokedAt: 2
    })
    const result = harness({
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId }), revoked],
      policies: [makePolicy({ memberId: revoked.memberId })]
    }).resolve(channel.chatId)

    expect(result).toEqual({ state: 'ready', isShared: true, seats: [] })
  })

  it('keeps NUL-containing migration source identities structurally distinct', () => {
    const channel = makeChannel()
    const left = makeHumanMember({ memberId: 'mapped-left', displayName: 'Left' })
    const right = makeHumanMember({
      memberId: 'mapped-right',
      displayName: 'Right',
      identityPublicKey: 'identity-2'
    })
    const result = harness({
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId }), left, right],
      policies: [
        makePolicy({
          memberId: left.memberId,
          sourceShareId: 'a\u0000b',
          sourceCollaboratorId: 'c'
        }),
        makePolicy({
          memberId: right.memberId,
          sourceShareId: 'a',
          sourceCollaboratorId: 'b\u0000c',
          sourceDigest: 'c'.repeat(64)
        })
      ],
      channelPresence: () => 'live'
    }).resolve(channel.chatId)

    expect(result).toEqual({
      state: 'ready',
      isShared: true,
      seats: [
        {
          seatId: 'b\u0000c',
          displayName: 'Right',
          enabled: true,
          present: true
        },
        {
          seatId: 'c',
          displayName: 'Left',
          enabled: true,
          present: true
        }
      ]
    })
  })

  it('blocks duplicate source bindings and seat-id collisions', () => {
    const channel = makeChannel()
    const left = makeHumanMember({ memberId: 'member-left' })
    const right = makeHumanMember({ memberId: 'member-right', identityPublicKey: 'identity-2' })
    expect(
      harness({
        channels: [channel],
        members: [makeHumanMember({ memberId: channel.ownerMemberId }), left, right],
        policies: [
          makePolicy({ memberId: left.memberId }),
          makePolicy({ memberId: right.memberId, sourceDigest: 'c'.repeat(64) })
        ]
      }).resolve(channel.chatId)
    ).toEqual({ state: 'recovery_blocked' })

    expect(
      harness({
        channels: [channel],
        members: [
          makeHumanMember({ memberId: channel.ownerMemberId }),
          makeHumanMember({ memberId: 'legacy-alex' }),
          makeHumanMember({ memberId: 'mapped-member', identityPublicKey: 'identity-2' })
        ],
        policies: [
          makePolicy({
            memberId: 'mapped-member',
            sourceCollaboratorId: 'legacy-alex'
          })
        ]
      }).resolve(channel.chatId)
    ).toEqual({ state: 'recovery_blocked' })
  })

  it('fails closed when any Channel authority store is unreadable', () => {
    const channel = makeChannel()
    const member = makeHumanMember({ memberId: 'native-active' })
    const base = {
      channels: [channel],
      members: [makeHumanMember({ memberId: channel.ownerMemberId }), member]
    }

    expect(
      harness({
        ...base,
        overrides: {
          humanPolicyStore: {
            list: () => {
              throw new Error('corrupt policy')
            }
          }
        }
      }).resolve(channel.chatId)
    ).toEqual({ state: 'recovery_blocked' })

    expect(
      harness({
        ...base,
        overrides: {
          channelStore: {
            listChannels: () => [channel],
            listMembers: () => {
              throw new Error('corrupt members')
            }
          }
        }
      }).resolve(channel.chatId)
    ).toEqual({ state: 'recovery_blocked' })
  })
})
