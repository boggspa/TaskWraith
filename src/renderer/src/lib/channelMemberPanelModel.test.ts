import { describe, expect, it, vi } from 'vitest'
import type {
  ChannelMemberIpcApi,
  ChannelMemberIpcChangeEvent,
  ChannelMemberIpcChannel,
  ChannelMemberIpcMember,
  ChannelMemberIpcMembershipSummary,
  ChannelMemberIpcMessage,
  ChannelMemberIpcResult,
  ChannelMemberIpcSnapshot
} from '../../../shared/collaboration/ChannelMemberIpc'
import {
  CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
  CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION
} from '../../../shared/collaboration/ChannelMemberIpc'
import { CHANNEL_WIRE_PROTOCOL } from '../../../shared/collaboration/ChannelWireProtocol'
import { ChannelMemberPanelController, parseChannelInviteText } from './channelMemberPanelModel'

function channel(overrides: Partial<ChannelMemberIpcChannel> = {}): ChannelMemberIpcChannel {
  return {
    channelId: 'channel-a',
    hostChatId: 'host-chat-a',
    memberId: 'member-b',
    displayName: 'Member B',
    title: 'Design room',
    status: 'active',
    savedAt: 1_000,
    updatedAt: 1_100,
    ...overrides
  }
}

function summary(
  overrides: Partial<ChannelMemberIpcMembershipSummary> = {}
): ChannelMemberIpcMembershipSummary {
  return { ...channel(), active: true, ...overrides }
}

function member(overrides: Partial<ChannelMemberIpcMember> = {}): ChannelMemberIpcMember {
  return {
    memberId: 'member-b',
    kind: 'human',
    displayName: 'Member B',
    status: 'active',
    joinedAt: 1_000,
    ...overrides
  }
}

function message(
  sequence: number,
  overrides: Partial<ChannelMemberIpcMessage> = {}
): ChannelMemberIpcMessage {
  return {
    channelId: 'channel-a',
    sequence,
    messageId: `message-${sequence}`,
    authorMemberId: 'owner-a',
    clientMessageId: `client-${sequence}`,
    kind: 'human.text',
    content: `Message ${sequence}`,
    acceptedAt: sequence * 1_000,
    contentHash: `${sequence}`.padStart(64, '0'),
    ...overrides
  }
}

function snapshot(overrides: Partial<ChannelMemberIpcSnapshot> = {}): ChannelMemberIpcSnapshot {
  return {
    phase: 'connected',
    connected: true,
    channel: channel(),
    members: [
      member({ memberId: 'owner-a', displayName: 'Host' }),
      member({ memberId: 'member-b', displayName: 'Member B' })
    ],
    records: [message(1)],
    highWaterSequence: 1,
    error: null,
    ...overrides
  }
}

function ok<T>(value: T): ChannelMemberIpcResult<T> {
  return { ok: true, value }
}

function createApi(overrides: Partial<ChannelMemberIpcApi> = {}): ChannelMemberIpcApi {
  let current = snapshot()
  return {
    list: async () => ok([summary()]),
    snapshot: async () => ok(current),
    beginJoin: async () => ok({ confirmCode: '123456' }),
    confirmJoin: async () => ok(current),
    reconnect: async () => ok(current),
    append: async ({ content, clientMessageId }) =>
      ok({
        record: message(current.highWaterSequence + 1, { content, clientMessageId }),
        deduplicated: false
      }),
    resume: async () => ok(current),
    disconnect: async () => {
      current = snapshot({ phase: 'disconnected', connected: false })
      return ok(current)
    },
    resetLocalHistory: async () => {
      current = snapshot({ phase: 'disconnected', connected: false, records: [] })
      return ok(current)
    },
    forget: async () => {
      current = snapshot({
        phase: 'idle',
        connected: false,
        channel: null,
        members: [],
        records: [],
        highWaterSequence: 0
      })
      return ok(current)
    },
    onChanged: () => () => undefined,
    ...overrides
  }
}

function inviteText(): string {
  return JSON.stringify({
    type: CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
    v: CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION,
    protocol: CHANNEL_WIRE_PROTOCOL,
    channelId: 'channel-a',
    chatId: 'host-chat-a',
    inviteId: 'invite-a',
    inviteToken: 'one-shot-token',
    roomId: 'room-a',
    expiresAt: 20_000,
    relayUrl: 'wss://relay.example',
    relayUrls: ['wss://relay.example'],
    requiresOutOfBandSas: true
  })
}

describe('ChannelMemberPanelController', () => {
  it('subscribes before its first snapshot and serializes event refreshes', async () => {
    const order: string[] = []
    let changed: ((event: ChannelMemberIpcChangeEvent) => void) | null = null
    const unsubscribe = vi.fn()
    const api = createApi({
      list: async () => {
        order.push('list')
        return ok([summary()])
      },
      snapshot: async () => {
        order.push('snapshot')
        return ok(snapshot())
      },
      onChanged: (callback) => {
        order.push('subscribe')
        changed = callback
        return unsubscribe
      }
    })
    const controller = new ChannelMemberPanelController({ api })

    await controller.start()
    expect(order[0]).toBe('subscribe')
    expect(controller.snapshot().channel?.channelId).toBe('channel-a')

    const notify = changed as unknown as (event: ChannelMemberIpcChangeEvent) => void
    notify({ channelId: 'channel-a', reason: 'snapshot' })
    await controller.refresh()
    expect(order.filter((entry) => entry === 'snapshot').length).toBeGreaterThanOrEqual(3)

    controller.dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('parses a portable invite, trims the human name, and retains only the SAS code', async () => {
    let current = snapshot({
      phase: 'idle',
      connected: false,
      channel: null,
      members: [],
      records: [],
      highWaterSequence: 0
    })
    const beginJoin = vi.fn(async () => {
      current = snapshot({
        phase: 'awaiting_sas',
        connected: false,
        channel: null,
        members: [],
        records: [],
        highWaterSequence: 0
      })
      return ok({ confirmCode: '123456' })
    })
    const controller = new ChannelMemberPanelController({
      api: createApi({ snapshot: async () => ok(current), beginJoin })
    })
    await controller.start()

    expect(parseChannelInviteText('[]')).toBeNull()
    expect(await controller.beginJoin('{broken', 'Member B')).toBe(false)
    expect(beginJoin).not.toHaveBeenCalled()

    expect(await controller.beginJoin(inviteText(), '  Member B  ')).toBe(true)
    expect(beginJoin).toHaveBeenCalledWith({
      invite: expect.objectContaining({
        type: CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
        inviteToken: 'one-shot-token'
      }),
      displayName: 'Member B'
    })
    expect(controller.snapshot().phase).toBe('awaiting_sas')
    expect(controller.snapshot().confirmCode).toBe('123456')
    expect(JSON.stringify(controller.snapshot())).not.toContain('one-shot-token')
  })

  it('requires the displayed SAS step before confirming and then clears it', async () => {
    let current = snapshot({
      phase: 'idle',
      connected: false,
      channel: null,
      members: [],
      records: [],
      highWaterSequence: 0
    })
    const confirmJoin = vi.fn(async () => {
      current = snapshot()
      return ok(current)
    })
    const api = createApi({
      snapshot: async () => ok(current),
      beginJoin: async () => {
        current = snapshot({
          phase: 'awaiting_sas',
          connected: false,
          channel: null,
          members: [],
          records: [],
          highWaterSequence: 0
        })
        return ok({ confirmCode: '654321' })
      },
      confirmJoin
    })
    const controller = new ChannelMemberPanelController({ api })
    await controller.start()

    expect(await controller.confirmJoin()).toBe(false)
    expect(confirmJoin).not.toHaveBeenCalled()
    await controller.beginJoin(inviteText(), 'Member B')
    expect(await controller.confirmJoin()).toBe(true)
    expect(confirmJoin).toHaveBeenCalledWith()
    expect(controller.snapshot().confirmCode).toBeNull()
    expect(controller.snapshot().connected).toBe(true)
  })

  it('keeps offline history readable when a pinned reconnect cannot reach the host', async () => {
    const reconnect = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'host_unavailable' as const, message: 'raw transport detail' }
    }))
    const offline = snapshot({ phase: 'disconnected', connected: false, records: [message(1)] })
    const controller = new ChannelMemberPanelController({
      api: createApi({ snapshot: async () => ok(offline), reconnect })
    })
    await controller.start()

    expect(await controller.reconnect('channel-a')).toBe(false)
    expect(reconnect).toHaveBeenCalledWith({ channelId: 'channel-a' })
    expect(controller.snapshot().records).toEqual([message(1)])
    expect(controller.snapshot().error).toContain('saved history remains readable offline')
    expect(controller.snapshot().error).not.toContain('raw transport')
  })

  it('opens a non-active revoked membership as retained read-only history', async () => {
    let current = snapshot({ phase: 'disconnected', connected: false })
    let memberships = [
      summary(),
      summary({
        channelId: 'channel-revoked',
        title: 'Old room',
        status: 'revoked',
        active: false
      })
    ]
    const reconnect = vi.fn(async () => {
      current = snapshot({
        phase: 'revoked',
        connected: false,
        channel: channel({
          channelId: 'channel-revoked',
          title: 'Old room',
          status: 'revoked'
        }),
        records: [
          message(1, {
            channelId: 'channel-revoked',
            content: 'Retained after revoke'
          })
        ],
        error: { code: 'revoked', message: 'This Channel membership is no longer active.' }
      })
      memberships = [
        summary({ active: false }),
        summary({
          channelId: 'channel-revoked',
          title: 'Old room',
          status: 'revoked',
          active: true
        })
      ]
      return ok(current)
    })
    const controller = new ChannelMemberPanelController({
      api: createApi({
        list: async () => ok(memberships),
        snapshot: async () => ok(current),
        reconnect
      })
    })
    await controller.start()

    expect(await controller.reconnect('channel-revoked')).toBe(true)
    expect(reconnect).toHaveBeenCalledWith({ channelId: 'channel-revoked' })
    expect(controller.snapshot()).toMatchObject({
      phase: 'revoked',
      connected: false,
      channel: { channelId: 'channel-revoked', status: 'revoked' },
      records: [{ content: 'Retained after revoke' }]
    })
    expect(controller.snapshot().notice).toContain('retained read-only history')
  })

  it('reuses the exact append id after an ambiguous local response failure', async () => {
    const ids: string[] = []
    let current = snapshot({ records: [], highWaterSequence: 0 })
    const append = vi.fn(async (input: { content: string; clientMessageId: string }) => {
      ids.push(input.clientMessageId)
      if (ids.length === 1) throw new Error('socket failed after durable commit')
      current = snapshot({
        records: [message(1, { content: input.content, clientMessageId: input.clientMessageId })],
        highWaterSequence: 1
      })
      return ok({ record: current.records[0], deduplicated: true })
    })
    const controller = new ChannelMemberPanelController({
      api: createApi({ snapshot: async () => ok(current), append }),
      createClientMessageId: () => 'member:stable-id'
    })
    await controller.start()

    expect(await controller.append('  Hello  ')).toBe(false)
    expect(controller.snapshot().error).not.toContain('socket failed')
    expect(await controller.append('Hello')).toBe(true)
    expect(ids).toEqual(['member:stable-id', 'member:stable-id'])
    expect(controller.snapshot().notice).toBe('Message already posted.')
    expect(controller.snapshot().records).toHaveLength(1)
  })

  it('acknowledges host-review receipts without projecting an unapproved row', async () => {
    let duplicate = false
    const append = vi.fn(async () =>
      ok({
        queuedForHostReview: true as const,
        deduplicated: duplicate,
        review: {
          reviewId: 'review-1',
          state: 'queued' as const,
          enqueuedAt: 1_000,
          expiresAt: 2_000
        }
      })
    )
    const controller = new ChannelMemberPanelController({
      api: createApi({ append }),
      createClientMessageId: () => 'member:review-id'
    })
    await controller.start()

    expect(await controller.append('Please review')).toBe(true)
    expect(controller.snapshot()).toMatchObject({
      notice: 'Message queued for host review.',
      records: [{ sequence: 1 }]
    })

    duplicate = true
    expect(await controller.append('Please review')).toBe(true)
    expect(controller.snapshot().notice).toBe('Message is still awaiting host review.')
    expect(controller.snapshot().records).toHaveLength(1)
  })

  it('catches up, disconnects, and retains the durable projection', async () => {
    const caughtUp = snapshot({ records: [message(1), message(2)], highWaterSequence: 2 })
    const disconnected = snapshot({
      phase: 'disconnected',
      connected: false,
      records: caughtUp.records,
      highWaterSequence: 2
    })
    const resume = vi.fn(async () => ok(caughtUp))
    const disconnect = vi.fn(async () => ok(disconnected))
    const controller = new ChannelMemberPanelController({
      api: createApi({ resume, disconnect })
    })
    await controller.start()

    expect(await controller.resume()).toBe(true)
    expect(controller.snapshot().highWaterSequence).toBe(2)
    expect(await controller.disconnect()).toBe(true)
    expect(controller.snapshot().connected).toBe(false)
    expect(controller.snapshot().records).toHaveLength(2)
  })

  it('keeps revoked history read-only without invoking append', async () => {
    const append = vi.fn(createApi().append)
    const revoked = snapshot({
      phase: 'revoked',
      connected: false,
      channel: channel({ status: 'revoked' }),
      records: [message(1)]
    })
    const controller = new ChannelMemberPanelController({
      api: createApi({ snapshot: async () => ok(revoked), append })
    })
    await controller.start()

    expect(await controller.append('Do not send')).toBe(false)
    expect(append).not.toHaveBeenCalled()
    expect(controller.snapshot().records).toEqual([message(1)])
    expect(controller.snapshot().error).toContain('read-only')
  })

  it('mints explicit confirmation only for local repair and membership removal', async () => {
    let current = snapshot({ phase: 'recovery_blocked', connected: false })
    const resetLocalHistory = vi.fn(async () => {
      current = snapshot({ phase: 'disconnected', connected: false, records: [] })
      return ok(current)
    })
    const forget = vi.fn(async () => {
      current = snapshot({
        phase: 'idle',
        connected: false,
        channel: null,
        members: [],
        records: [],
        highWaterSequence: 0
      })
      return ok(current)
    })
    const controller = new ChannelMemberPanelController({
      api: createApi({ snapshot: async () => ok(current), resetLocalHistory, forget })
    })
    await controller.start()

    expect(await controller.resetLocalHistory('channel-a')).toBe(true)
    expect(resetLocalHistory).toHaveBeenCalledWith({ channelId: 'channel-a', confirmed: true })
    expect(await controller.forget('channel-a')).toBe(true)
    expect(forget).toHaveBeenCalledWith({ channelId: 'channel-a', confirmed: true })
    expect(controller.snapshot().channel).toBeNull()
  })
})
