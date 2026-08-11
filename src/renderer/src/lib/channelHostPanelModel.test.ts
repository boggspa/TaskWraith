import { describe, expect, it, vi } from 'vitest'
import type {
  ChannelIpcApi,
  ChannelIpcChannel,
  ChannelIpcChangeEvent,
  ChannelIpcHumanReview,
  ChannelIpcInviteResult,
  ChannelIpcMigrationHandoff,
  ChannelIpcMember,
  ChannelIpcMessage,
  ChannelIpcPendingAdmission,
  ChannelIpcReadInput,
  ChannelIpcResult
} from '../../../shared/collaboration/ChannelIpc'
import { CHANNEL_WIRE_PROTOCOL } from '../../../shared/collaboration/ChannelWireProtocol'
import {
  ChannelHostPanelController,
  CHANNEL_INVITE_PAYLOAD_TYPE,
  CHANNEL_INVITE_PAYLOAD_VERSION,
  buildChannelInvitePayload,
  findChannelForChat,
  serializeChannelInvite
} from './channelHostPanelModel'

function channel(overrides: Partial<ChannelIpcChannel> = {}): ChannelIpcChannel {
  return {
    channelId: 'channel-1',
    chatId: 'chat-1',
    ownerMemberId: 'member-host',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    membershipRevision: 1,
    messageCount: 0,
    reference: { kind: 'chat', id: 'chat-1' },
    display: { title: 'Design room', status: 'active', memberCount: 1, messageCount: 0 },
    availability: 'ready',
    ...overrides
  }
}

function member(overrides: Partial<ChannelIpcMember> = {}): ChannelIpcMember {
  return {
    memberId: 'member-host',
    channelId: 'channel-1',
    kind: 'human',
    displayName: 'Chris',
    status: 'active',
    joinedAt: 1,
    ...overrides
  }
}

function message(sequence: number, overrides: Partial<ChannelIpcMessage> = {}): ChannelIpcMessage {
  return {
    channelId: 'channel-1',
    sequence,
    messageId: `message-${sequence}`,
    authorMemberId: 'member-host',
    clientMessageId: `client-${sequence}`,
    kind: 'human.text',
    content: `Message ${sequence}`,
    acceptedAt: sequence * 1_000,
    contentHash: `${sequence}`.padStart(64, '0'),
    ...overrides
  }
}

function pendingAdmission(
  overrides: Partial<ChannelIpcPendingAdmission> = {}
): ChannelIpcPendingAdmission {
  return {
    memberId: 'member-alex',
    displayName: 'Alex',
    confirmCode: '123456',
    expiresAt: 120_000,
    ...overrides
  }
}

function humanReview(overrides: Partial<ChannelIpcHumanReview> = {}): ChannelIpcHumanReview {
  return {
    reviewId: 'review-1',
    channelId: 'channel-1',
    memberId: 'member-alex',
    displayName: 'Alex',
    content: 'Please review this.',
    contentBytes: 19,
    state: 'queued',
    enqueuedAt: 5_000,
    expiresAt: 65_000,
    ...overrides
  }
}

function ok<T>(value: T): ChannelIpcResult<T> {
  return { ok: true, value }
}

function migrationHandoff(
  overrides: Partial<ChannelIpcMigrationHandoff> = {}
): ChannelIpcMigrationHandoff {
  return {
    invitations: [
      {
        channelId: 'channel-1',
        purpose: 'pending-collaborator',
        recipientLabel: 'Alex Pending',
        expiresAt: 60_000,
        status: 'ready',
        invite: {
          channelId: 'channel-1',
          inviteId: 'migrated-invite-1',
          inviteToken: 'migrated-one-shot-token',
          roomId: 'migrated-room-1',
          expiresAt: 60_000,
          relayUrls: ['wss://relay.example'],
          hostRoomOpened: true
        }
      }
    ],
    retiredInvitationCount: 0,
    relayUnavailableInvitationCount: 0,
    ...overrides
  }
}

function createApi(overrides: Partial<ChannelIpcApi> = {}): ChannelIpcApi {
  const room = channel()
  return {
    list: async () => ok([room]),
    read: async () =>
      ok({
        channel: room,
        members: [member()],
        pendingAdmissions: [],
        records: [],
        highWaterSequence: 0
      }),
    audit: async () => ok([]),
    create: async () => ok(room),
    issueInvite: async () =>
      ok({
        channelId: room.channelId,
        inviteId: 'invite-1',
        inviteToken: 'one-shot-token',
        roomId: 'room-1',
        expiresAt: 20_000,
        relayUrls: ['wss://relay.example'],
        hostRoomOpened: true
      }),
    migrationHandoff: async () => ok(null),
    append: async ({ clientMessageId, content }) =>
      ok({
        record: message(1, { clientMessageId, content }),
        deduplicated: false
      }),
    revokeMember: async ({ memberId }) =>
      ok(member({ memberId, displayName: 'Alex', status: 'revoked', revokedAt: 10 })),
    listHumanReviews: async () => ok([]),
    approveHumanReview: async ({ reviewId }) =>
      ok({ reviewId, record: message(1), deduplicated: false }),
    denyHumanReview: async ({ reviewId }) => ok({ reviewId, denied: true }),
    close: async () =>
      ok(
        channel({
          status: 'closed',
          display: { title: 'Design room', status: 'closed', memberCount: 1, messageCount: 0 }
        })
      ),
    onChanged: () => () => undefined,
    ...overrides
  }
}

function invite(overrides: Partial<ChannelIpcInviteResult> = {}): ChannelIpcInviteResult {
  return {
    channelId: 'channel-1',
    inviteId: 'invite-1',
    inviteToken: 'one-shot-token',
    roomId: 'room-1',
    expiresAt: 50_000,
    relayUrls: ['wss://relay.example', 'wss://relay.example', 'wss://relay-two.example'],
    hostRoomOpened: true,
    ...overrides
  }
}

describe('Channel invite projection', () => {
  it('serializes the portable, human-SAS invite without unrelated host state', () => {
    const projected = buildChannelInvitePayload(invite(), 'chat-1')

    expect(projected).toEqual({
      type: CHANNEL_INVITE_PAYLOAD_TYPE,
      v: CHANNEL_INVITE_PAYLOAD_VERSION,
      protocol: CHANNEL_WIRE_PROTOCOL,
      channelId: 'channel-1',
      chatId: 'chat-1',
      inviteId: 'invite-1',
      inviteToken: 'one-shot-token',
      roomId: 'room-1',
      expiresAt: 50_000,
      relayUrl: 'wss://relay.example',
      relayUrls: ['wss://relay.example', 'wss://relay-two.example'],
      requiresOutOfBandSas: true
    })
    expect(JSON.parse(serializeChannelInvite(invite(), 'chat-1'))).toEqual(projected)
    expect(serializeChannelInvite(invite(), 'chat-1')).not.toContain('hostRoomOpened')
  })

  it('selects only the Channel owned by the current chat', () => {
    const other = channel({ channelId: 'other', chatId: 'chat-2' })
    expect(findChannelForChat([other, channel()], 'chat-1')?.channelId).toBe('channel-1')
    expect(findChannelForChat([other], 'chat-1')).toBeNull()
  })
})

describe('ChannelHostPanelController', () => {
  it('subscribes before its first read and incrementally applies change notifications', async () => {
    let changed: ((event: ChannelIpcChangeEvent) => void) | null = null
    const unsubscribe = vi.fn()
    const readInputs: ChannelIpcReadInput[] = []
    const api = createApi({
      read: async (input) => {
        readInputs.push(input)
        const records = input.resumeAfter === 0 ? [message(1)] : [message(2)]
        return ok({
          channel: channel({
            messageCount: 2,
            display: { title: 'Design room', status: 'active', memberCount: 1, messageCount: 2 }
          }),
          members: [member()],
          pendingAdmissions: [],
          records,
          highWaterSequence: 2
        })
      },
      onChanged: (callback) => {
        changed = callback
        return unsubscribe
      }
    })
    const controller = new ChannelHostPanelController({ api, chatId: 'chat-1' })

    await controller.start()
    expect(readInputs[0]).toMatchObject({ channelId: 'channel-1', resumeAfter: 0 })
    expect(controller.snapshot().records.map((record) => record.sequence)).toEqual([1])

    const notify = changed as unknown as (event: ChannelIpcChangeEvent) => void
    notify({ channelId: 'channel-1', reason: 'message' })
    await controller.retry()
    expect(readInputs.some((input) => input.resumeAfter === 1)).toBe(true)
    expect(controller.snapshot().records.map((record) => record.sequence)).toEqual([1, 2])

    controller.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('projects the transient host SAS and removes it on the canonical refresh', async () => {
    let pending = [pendingAdmission()]
    const controller = new ChannelHostPanelController({
      api: createApi({
        read: async () =>
          ok({
            channel: channel(),
            members: [
              member(),
              member({ memberId: 'member-alex', displayName: 'Alex', status: 'pending' })
            ],
            pendingAdmissions: pending,
            records: [],
            highWaterSequence: 0
          })
      }),
      chatId: 'chat-1'
    })

    await controller.start()
    expect(controller.snapshot().pendingAdmissions).toEqual([pendingAdmission()])

    pending = []
    await controller.retry()
    expect(controller.snapshot().pendingAdmissions).toEqual([])
  })

  it('creates only on an explicit owner name and refreshes the canonical projection', async () => {
    const create = vi.fn(async () => ok(channel()))
    const controller = new ChannelHostPanelController({
      api: createApi({ list: async () => ok([]), create }),
      chatId: 'chat-1'
    })
    await controller.start()

    expect(await controller.create('   ')).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(controller.snapshot().error).toContain('name')

    expect(await controller.create('  Chris  ')).toBe(true)
    expect(create).toHaveBeenCalledWith({ chatId: 'chat-1', ownerDisplayName: 'Chris' })
    expect(controller.snapshot().notice).toContain('Channel created')
  })

  it('copies a fresh invite while keeping the one-shot payload visible on clipboard denial', async () => {
    const copied: string[] = []
    const controller = new ChannelHostPanelController({
      api: createApi(),
      chatId: 'chat-1',
      copyText: async (text) => {
        copied.push(text)
        throw new Error('denied')
      }
    })
    await controller.start()

    expect(await controller.issueInvite()).toBe(true)
    expect(copied).toHaveLength(1)
    expect(controller.snapshot().invite?.payload).toContain('one-shot-token')
    expect(controller.snapshot().invite?.copied).toBe(false)
    expect(controller.snapshot().notice).toContain('field below')

    controller.clearInvite()
    expect(controller.snapshot().invite).toBeNull()
  })

  it('warns without discarding an invite when the host relay room did not open', async () => {
    const api = createApi({
      issueInvite: async () => ok(invite({ hostRoomOpened: false }))
    })
    const controller = new ChannelHostPanelController({
      api,
      chatId: 'chat-1',
      copyText: async () => undefined
    })
    await controller.start()

    expect(await controller.issueInvite()).toBe(true)
    expect(controller.snapshot().invite?.hostRoomOpened).toBe(false)
    expect(controller.snapshot().notice).toContain('could not open its relay room')
  })

  it('rechecks and copies only a currently relay-ready migrated invitation', async () => {
    const copied: string[] = []
    let handoff = migrationHandoff()
    const getHandoff = vi.fn(async ({ chatId }: { chatId: string }) => {
      expect(chatId).toBe('chat-1')
      return ok(handoff)
    })
    const controller = new ChannelHostPanelController({
      api: createApi({ migrationHandoff: getHandoff }),
      chatId: 'chat-1',
      copyText: async (text) => {
        copied.push(text)
      }
    })

    await controller.start()
    expect(controller.snapshot().migrationHandoff?.invitations).toMatchObject([
      { recipientLabel: 'Alex Pending', status: 'ready' }
    ])
    expect(await controller.copyMigratedInvite('migrated-invite-1')).toBe(true)
    expect(copied).toHaveLength(1)
    expect(copied[0]).toContain('migrated-one-shot-token')
    expect(controller.snapshot()).toMatchObject({
      copiedMigrationInviteId: 'migrated-invite-1',
      notice: 'Migrated invitation for Alex Pending copied.'
    })

    handoff = migrationHandoff({
      invitations: [
        {
          channelId: 'channel-1',
          purpose: 'pending-collaborator',
          recipientLabel: 'Alex Pending',
          expiresAt: 60_000,
          status: 'relay_unavailable',
          invite: null
        }
      ],
      relayUnavailableInvitationCount: 1
    })
    expect(await controller.copyMigratedInvite('migrated-invite-1')).toBe(false)
    expect(copied).toHaveLength(1)
    expect(controller.snapshot().copiedMigrationInviteId).toBeNull()
    expect(controller.snapshot().error).toContain('no longer ready')
    expect(JSON.stringify(controller.snapshot().migrationHandoff)).not.toContain(
      'migrated-one-shot-token'
    )
    expect(getHandoff).toHaveBeenCalledTimes(3)
  })

  it('does not render a fallback token when copying a migrated invitation is denied', async () => {
    const controller = new ChannelHostPanelController({
      api: createApi({ migrationHandoff: async () => ok(migrationHandoff()) }),
      chatId: 'chat-1',
      copyText: async () => {
        throw new Error('clipboard denied')
      }
    })

    await controller.start()
    expect(await controller.copyMigratedInvite('migrated-invite-1')).toBe(false)
    expect(controller.snapshot().copiedMigrationInviteId).toBeNull()
    expect(controller.snapshot().error).toContain('Clipboard access is unavailable')
    expect(JSON.stringify(controller.snapshot().migrationHandoff)).not.toContain('payload')
  })

  it('reuses the exact append id after an ambiguous transport failure', async () => {
    const attempts: string[] = []
    let committed = false
    const api = createApi({
      read: async () =>
        ok({
          channel: channel({ messageCount: committed ? 1 : 0 }),
          members: [member()],
          pendingAdmissions: [],
          records: committed
            ? [message(1, { clientMessageId: attempts[0], content: 'Hello' })]
            : [],
          highWaterSequence: committed ? 1 : 0
        }),
      append: async (input) => {
        attempts.push(input.clientMessageId)
        if (attempts.length === 1) throw new Error('connection dropped after commit')
        committed = true
        return ok({
          record: message(1, { clientMessageId: input.clientMessageId, content: input.content }),
          deduplicated: true
        })
      }
    })
    const controller = new ChannelHostPanelController({
      api,
      chatId: 'chat-1',
      createClientMessageId: () => 'host:stable-id'
    })
    await controller.start()

    expect(await controller.append(' Hello ')).toBe(false)
    expect(controller.snapshot().error).toBe(
      'The Channel request could not be completed. Try again.'
    )
    expect(controller.snapshot().error).not.toContain('connection dropped')
    expect(await controller.append('Hello')).toBe(true)
    expect(attempts).toEqual(['host:stable-id', 'host:stable-id'])
    expect(controller.snapshot().notice).toBe('Message already posted.')
    expect(controller.snapshot().records).toHaveLength(1)
  })

  it('never asks main to revoke the owner and retains closed Channel history', async () => {
    const revokeMember = vi.fn(createApi().revokeMember)
    const close = vi.fn(async (_input: { channelId: string }) =>
      ok(
        channel({
          status: 'closed',
          messageCount: 1,
          display: { title: 'Design room', status: 'closed', memberCount: 2, messageCount: 1 }
        })
      )
    )
    let closed = false
    const api = createApi({
      list: async () =>
        ok([
          channel(
            closed
              ? {
                  status: 'closed',
                  messageCount: 1,
                  display: {
                    title: 'Design room',
                    status: 'closed',
                    memberCount: 2,
                    messageCount: 1
                  }
                }
              : {}
          )
        ]),
      read: async () =>
        ok({
          channel: channel(
            closed
              ? {
                  status: 'closed',
                  messageCount: 1,
                  display: {
                    title: 'Design room',
                    status: 'closed',
                    memberCount: 2,
                    messageCount: 1
                  }
                }
              : { messageCount: 1 }
          ),
          members: [member(), member({ memberId: 'member-alex', displayName: 'Alex' })],
          pendingAdmissions: [],
          records: [message(1)],
          highWaterSequence: 1
        }),
      revokeMember,
      close: async (input) => {
        closed = true
        return close(input)
      }
    })
    const controller = new ChannelHostPanelController({ api, chatId: 'chat-1' })
    await controller.start()

    expect(await controller.revokeMember('member-host')).toBe(false)
    expect(revokeMember).not.toHaveBeenCalled()
    expect(await controller.close()).toBe(true)
    expect(controller.snapshot().channel?.status).toBe('closed')
    expect(controller.snapshot().records.map((record) => record.sequence)).toEqual([1])
  })

  it('approves or declines only through the scoped review API and refreshes canonical state', async () => {
    let reviews = [humanReview(), humanReview({ reviewId: 'review-2', content: 'Decline me.' })]
    let approved = false
    const approveHumanReview = vi.fn(async ({ reviewId }: { reviewId: string }) => {
      approved = true
      reviews = reviews.filter((review) => review.reviewId !== reviewId)
      return ok({
        reviewId,
        record: message(1, { content: 'Please review this.' }),
        deduplicated: false
      })
    })
    const denyHumanReview = vi.fn(async ({ reviewId }: { reviewId: string }) => {
      reviews = reviews.filter((review) => review.reviewId !== reviewId)
      return ok({ reviewId, denied: true as const })
    })
    const controller = new ChannelHostPanelController({
      api: createApi({
        read: async () =>
          ok({
            channel: channel({ messageCount: approved ? 1 : 0 }),
            members: [member(), member({ memberId: 'member-alex', displayName: 'Alex' })],
            pendingAdmissions: [],
            records: approved ? [message(1, { content: 'Please review this.' })] : [],
            highWaterSequence: approved ? 1 : 0
          }),
        listHumanReviews: async () => ok(reviews),
        approveHumanReview,
        denyHumanReview
      }),
      chatId: 'chat-1'
    })

    await controller.start()
    expect(controller.snapshot().humanReviews.map((review) => review.reviewId)).toEqual([
      'review-1',
      'review-2'
    ])
    expect(await controller.approveHumanReview('review-1')).toBe(true)
    expect(approveHumanReview).toHaveBeenCalledWith({
      channelId: 'channel-1',
      reviewId: 'review-1'
    })
    expect(controller.snapshot()).toMatchObject({
      humanReviews: [{ reviewId: 'review-2' }],
      records: [{ sequence: 1, content: 'Please review this.' }],
      notice: 'Reviewed message posted.'
    })

    expect(await controller.denyHumanReview('review-2')).toBe(true)
    expect(denyHumanReview).toHaveBeenCalledWith({
      channelId: 'channel-1',
      reviewId: 'review-2'
    })
    expect(controller.snapshot()).toMatchObject({
      humanReviews: [],
      notice: 'Reviewed message declined.'
    })
  })
})
