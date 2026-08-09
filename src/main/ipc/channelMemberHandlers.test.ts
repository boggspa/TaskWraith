import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_MEMBER_INVITE_PAYLOAD_TYPE,
  CHANNEL_MEMBER_INVITE_PAYLOAD_VERSION,
  CHANNEL_MEMBER_IPC_CHANNELS,
  type ChannelMemberIpcResult,
  type ChannelMemberIpcSnapshot
} from '../../shared/collaboration/ChannelMemberIpc'
import { CHANNEL_WIRE_PROTOCOL } from '../../shared/collaboration/ChannelWireProtocol'
import { ChannelMemberProductionError } from '../collaboration/ChannelMemberProductionService'
import {
  registerChannelMemberHandlers,
  type ChannelMemberHandlersDeps
} from './channelMemberHandlers'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function event(id = 1): IpcMainInvokeEvent {
  return { sender: { id } } as unknown as IpcMainInvokeEvent
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'connected' as const,
    connected: true,
    channel: {
      channelId: 'channel-a',
      hostChatId: 'host-chat-a',
      memberId: 'member-b',
      displayName: 'Member B',
      title: 'General',
      status: 'active' as const,
      savedAt: 1_000,
      updatedAt: 1_100,
      relayUrls: ['wss://must-not-cross.example'],
      roomId: 'must-not-cross-ipc',
      hostIdentityPubKeyB64: 'must-not-cross-ipc'
    },
    members: [
      {
        memberId: 'owner-a',
        kind: 'human' as const,
        displayName: 'Host',
        status: 'active' as const,
        joinedAt: 900,
        identityPublicKey: 'must-not-cross-ipc'
      }
    ],
    records: [
      {
        channelId: 'channel-a',
        sequence: 1,
        messageId: 'message-1',
        authorMemberId: 'owner-a',
        clientMessageId: 'client-1',
        kind: 'human.text' as const,
        content: 'hello',
        acceptedAt: 1_050,
        contentHash: 'a'.repeat(64),
        tokenHash: 'must-not-cross-ipc'
      }
    ],
    highWaterSequence: 1,
    error: null,
    inviteToken: 'must-not-cross-ipc',
    sessionId: 'must-not-cross-ipc',
    ...overrides
  }
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
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
    relayUrls: ['wss://relay.example', 'ws://127.0.0.1:8787'],
    requiresOutOfBandSas: true,
    title: 'General',
    ...overrides
  }
}

function fixture() {
  let current = snapshot()
  const service = {
    snapshot: vi.fn(() => current),
    listMemberships: vi.fn(() => [
      {
        ...current.channel,
        active: true,
        roomId: 'must-not-cross-ipc',
        hostIdentityPubKeyB64: 'must-not-cross-ipc'
      }
    ]),
    beginJoin: vi.fn(async () => ({ confirmCode: '123456' })),
    confirmJoin: vi.fn(async () => current),
    reconnect: vi.fn(async () => current),
    append: vi.fn(async (input: { content: string; clientMessageId: string }) => ({
      record: {
        ...current.records[0],
        content: input.content,
        clientMessageId: input.clientMessageId
      },
      deduplicated: false,
      sessionId: 'must-not-cross-ipc'
    })),
    resume: vi.fn(async () => current),
    disconnect: vi.fn(() => {
      current = snapshot({ phase: 'disconnected', connected: false })
    }),
    resetLocalHistory: vi.fn(() => snapshot({ phase: 'disconnected', connected: false })),
    forget: vi.fn()
  }
  const handlers = new Map<string, Handler>()
  const removeHandler = vi.fn()
  const ipc = {
    handle: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    removeHandler
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  const assertMainRendererSender = vi.fn((source: IpcMainInvokeEvent) => {
    if (source.sender.id !== 1) throw new Error('secondary renderer')
  })
  const deps: ChannelMemberHandlersDeps = {
    service: service as unknown as ChannelMemberHandlersDeps['service'],
    assertMainRendererSender
  }
  const registration = registerChannelMemberHandlers(ipc, deps)

  const invoke = async <T>(
    name: string,
    args: unknown[] = [],
    source = event()
  ): Promise<ChannelMemberIpcResult<T>> => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`missing handler ${name}`)
    return (await handler(source, ...args)) as ChannelMemberIpcResult<T>
  }

  return {
    current,
    service,
    handlers,
    removeHandler,
    assertMainRendererSender,
    registration,
    invoke
  }
}

describe('registerChannelMemberHandlers', () => {
  it('registers and disposes the complete closed member contract idempotently', () => {
    const target = fixture()
    expect([...target.handlers.keys()]).toEqual(Object.values(CHANNEL_MEMBER_IPC_CHANNELS))
    expect(target.removeHandler.mock.calls.map(([name]) => name)).toEqual(
      Object.values(CHANNEL_MEMBER_IPC_CHANNELS)
    )

    target.registration.dispose()
    expect(target.removeHandler).toHaveBeenCalledTimes(
      Object.values(CHANNEL_MEMBER_IPC_CHANNELS).length * 2
    )
  })

  it('projects summaries and snapshots field-by-field without transport authority', async () => {
    const target = fixture()
    const list = await target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.list)
    const state = await target.invoke<ChannelMemberIpcSnapshot>(
      CHANNEL_MEMBER_IPC_CHANNELS.snapshot
    )

    expect(list).toMatchObject({
      ok: true,
      value: [{ channelId: 'channel-a', title: 'General', active: true }]
    })
    expect(state).toMatchObject({
      ok: true,
      value: {
        phase: 'connected',
        connected: true,
        channel: { channelId: 'channel-a', memberId: 'member-b' },
        members: [{ memberId: 'owner-a', kind: 'human' }],
        records: [{ sequence: 1, kind: 'human.text', content: 'hello' }],
        highWaterSequence: 1,
        error: null
      }
    })
    for (const result of [list, state]) {
      expect(JSON.stringify(result)).not.toMatch(
        /must-not-cross-ipc|relayUrls|roomId|hostIdentityPubKeyB64|inviteToken|sessionId|identityPublicKey|tokenHash/
      )
    }
  })

  it('validates the complete invite in main before exposing its one-shot token to the service', async () => {
    const target = fixture()
    const result = await target.invoke<{ confirmCode: string }>(
      CHANNEL_MEMBER_IPC_CHANNELS.beginJoin,
      [{ invite: invite(), displayName: '  Member B  ' }]
    )

    expect(result).toEqual({ ok: true, value: { confirmCode: '123456' } })
    expect(target.service.beginJoin).toHaveBeenCalledWith({
      protocol: CHANNEL_WIRE_PROTOCOL,
      version: 1,
      channelId: 'channel-a',
      hostChatId: 'host-chat-a',
      inviteId: 'invite-a',
      inviteToken: 'one-shot-token',
      roomId: 'room-a',
      relayUrls: ['wss://relay.example', 'ws://127.0.0.1:8787'],
      displayName: 'Member B',
      expiresAt: 20_000,
      title: 'General'
    })
  })

  it.each([
    invite({ type: 'taskwraith-human-collaboration-invite' }),
    invite({ v: 2 }),
    invite({ protocol: 'taskwraith-channel-wire-v2' }),
    invite({ requiresOutOfBandSas: false }),
    invite({ relayUrl: 'https://relay.example' }),
    invite({ relayUrl: 'wss://relay.example/path' }),
    invite({ relayUrl: 'wss://other.example' }),
    invite({ relayUrls: [] }),
    invite({ agentId: 'agent-a' })
  ])('rejects malformed or agent-shaped invite %j', async (value) => {
    const target = fixture()
    const result = await target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.beginJoin, [
      { invite: value, displayName: 'Member B' }
    ])
    expect(result).toMatchObject({ ok: false })
    expect(target.service.beginJoin).not.toHaveBeenCalled()
  })

  it('authorizes the main renderer before parsing secret-bearing input', async () => {
    const target = fixture()
    const result = await target.invoke(
      CHANNEL_MEMBER_IPC_CHANNELS.beginJoin,
      [{ invite: { malformed: true }, displayName: '' }],
      event(2)
    )

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'not_authorized',
        message: 'Only the main window may manage joined Channels.'
      }
    })
    expect(target.service.beginJoin).not.toHaveBeenCalled()
  })

  it('routes confirmation, pinned reconnect, resume, and disconnect without payload authority', async () => {
    const target = fixture()
    await expect(target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.confirmJoin)).resolves.toMatchObject({
      ok: true,
      value: { phase: 'connected' }
    })
    await expect(
      target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.reconnect, [{ channelId: 'channel-a' }])
    ).resolves.toMatchObject({ ok: true, value: { phase: 'connected' } })
    await expect(target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.resume)).resolves.toMatchObject({
      ok: true,
      value: { highWaterSequence: 1 }
    })
    await expect(target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.disconnect)).resolves.toMatchObject({
      ok: true,
      value: { phase: 'disconnected', connected: false }
    })
    expect(target.service.reconnect).toHaveBeenCalledWith('channel-a')
    expect(target.service.disconnect).toHaveBeenCalledOnce()
  })

  it('accepts only bounded human text and preserves the caller idempotency id', async () => {
    const target = fixture()
    const result = await target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.append, [
      { content: '  hello member Channel  ', clientMessageId: 'member-b-1' }
    ])
    expect(result).toMatchObject({
      ok: true,
      value: {
        record: { content: 'hello member Channel', clientMessageId: 'member-b-1' },
        deduplicated: false
      }
    })
    expect(target.service.append).toHaveBeenCalledWith({
      content: 'hello member Channel',
      clientMessageId: 'member-b-1'
    })
    expect(JSON.stringify(result)).not.toContain('sessionId')

    for (const input of [
      { content: '', clientMessageId: 'member-b-2' },
      { content: 'x'.repeat(8_001), clientMessageId: 'member-b-3' },
      { content: 'hello', clientMessageId: '' },
      { content: 'hello', clientMessageId: 'member-b-4', dispatch: true }
    ]) {
      const denied = await target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.append, [input])
      expect(denied).toMatchObject({ ok: false })
    }
    expect(target.service.append).toHaveBeenCalledTimes(1)
  })

  it('requires exact human confirmation before local history or membership erasure', async () => {
    const target = fixture()
    for (const channel of [
      CHANNEL_MEMBER_IPC_CHANNELS.resetLocalHistory,
      CHANNEL_MEMBER_IPC_CHANNELS.forget
    ]) {
      for (const input of [
        { channelId: 'channel-a' },
        { channelId: 'channel-a', confirmed: false },
        { channelId: 'channel-a', confirmed: true, force: true }
      ]) {
        const denied = await target.invoke(channel, [input])
        expect(denied).toMatchObject({
          ok: false,
          error: { code: 'protocol_error' }
        })
      }
    }
    await expect(
      target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.resetLocalHistory, [
        { channelId: 'channel-a', confirmed: true }
      ])
    ).resolves.toMatchObject({ ok: true, value: { phase: 'disconnected' } })
    await expect(
      target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.forget, [
        { channelId: 'channel-a', confirmed: true }
      ])
    ).resolves.toMatchObject({ ok: true })
    expect(target.service.resetLocalHistory).toHaveBeenCalledWith('channel-a')
    expect(target.service.forget).toHaveBeenCalledWith('channel-a')
  })

  it('returns typed safe failures and never projects unknown transport errors', async () => {
    const target = fixture()
    target.service.reconnect.mockRejectedValueOnce(
      new ChannelMemberProductionError(
        'host_unavailable',
        'token=super-secret failed at /Users/alice/private/member.json'
      )
    )
    const typed = await target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.reconnect, [{}])
    expect(typed).toMatchObject({ ok: false, error: { code: 'host_unavailable' } })
    expect(JSON.stringify(typed)).not.toMatch(/super-secret|\/Users\/alice/)

    target.service.reconnect.mockRejectedValueOnce(
      new Error('socket failed at /Users/alice/private/member.json')
    )
    const unknown = await target.invoke(CHANNEL_MEMBER_IPC_CHANNELS.reconnect, [{}])
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Channel member operation failed.' }
    })
  })
})
