import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_IPC_CHANNELS,
  type ChannelIpcChannel,
  type ChannelIpcResult
} from '../../shared/collaboration/ChannelIpc'
import { ChannelError } from '../collaboration/ChannelStore'
import {
  registerChannelHandlers,
  type ChannelHandlersDeps,
  type ChannelIpcSenderScope
} from './channelHandlers'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function channel(
  channelId: string,
  chatId: string,
  overrides: Partial<ChannelIpcChannel> = {}
): ChannelIpcChannel {
  return {
    channelId,
    chatId,
    ownerMemberId: `owner-${channelId}`,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    membershipRevision: 1,
    messageCount: 1,
    reference: { kind: 'chat', id: chatId },
    display: {
      title: `Title ${chatId}`,
      status: 'active',
      memberCount: 1,
      messageCount: 1
    },
    availability: 'ready',
    ...overrides
  }
}

function event(id = 1): IpcMainInvokeEvent {
  return { sender: { id } } as unknown as IpcMainInvokeEvent
}

function fixture(
  overrides: Partial<ChannelHandlersDeps> & {
    scope?: ChannelIpcSenderScope | (() => ChannelIpcSenderScope)
  } = {}
) {
  const { scope: scopeOverride, ...depsOverrides } = overrides
  const channels = [
    {
      ...channel('channel-a', 'chat-a'),
      identityPublicKey: 'must-not-cross-ipc',
      roomId: 'must-not-cross-ipc',
      tokenHash: 'must-not-cross-ipc'
    },
    channel('channel-b', 'chat-b')
  ]
  const service = {
    listChannels: vi.fn(() => channels),
    readChannel: vi.fn((input: { channelId: string }) => ({
      channel: channels.find((candidate) => candidate.channelId === input.channelId)!,
      members: [
        {
          memberId: `owner-${input.channelId}`,
          channelId: input.channelId,
          kind: 'human' as const,
          displayName: 'Host',
          status: 'active' as const,
          joinedAt: 1,
          identityPublicKey: 'must-not-cross-ipc',
          roomId: 'must-not-cross-ipc'
        }
      ],
      pendingAdmissions: [
        {
          channelId: input.channelId,
          memberId: `joining-${input.channelId}`,
          displayName: 'Alex',
          confirmCode: '123456',
          expiresAt: 120_000,
          handshakeId: 'must-not-cross-ipc',
          roomId: 'must-not-cross-ipc'
        }
      ],
      records: [
        {
          channelId: input.channelId,
          sequence: 1,
          messageId: 'message-1',
          authorMemberId: `owner-${input.channelId}`,
          clientMessageId: 'client-1',
          kind: 'human.text' as const,
          content: 'hello',
          acceptedAt: 2,
          contentHash: 'a'.repeat(64),
          tokenHash: 'must-not-cross-ipc'
        }
      ],
      highWaterSequence: 1,
      roomId: 'must-not-cross-ipc'
    })),
    listAudit: vi.fn(() => [
      {
        id: 'audit-1',
        at: 3,
        kind: 'message.accepted' as const,
        channelId: 'channel-a',
        memberId: 'owner-channel-a',
        contentHash: 'a'.repeat(64),
        rawPayload: 'must-not-cross-ipc'
      }
    ]),
    createChannel: vi.fn(() => channels[0]),
    issueInvite: vi.fn(() => ({
      channelId: 'channel-a',
      inviteId: 'invite-a',
      inviteToken: 'one-shot-token',
      roomId: 'room-a',
      expiresAt: 10_000,
      relayUrls: ['wss://relay.example'],
      hostRoomOpened: true,
      tokenHash: 'must-not-cross-ipc'
    })),
    appendHost: vi.fn(async () => ({
      record: {
        channelId: 'channel-a',
        sequence: 2,
        messageId: 'message-2',
        authorMemberId: 'owner-channel-a',
        clientMessageId: 'client-2',
        kind: 'human.text' as const,
        content: 'next',
        acceptedAt: 4,
        contentHash: 'b'.repeat(64)
      },
      deduplicated: false
    })),
    revokeMember: vi.fn(async () => ({
      memberId: 'member-a',
      channelId: 'channel-a',
      kind: 'human' as const,
      displayName: 'Member',
      status: 'revoked' as const,
      joinedAt: 2,
      revokedAt: 5,
      identityPublicKey: 'must-not-cross-ipc'
    })),
    closeChannel: vi.fn(async () => channel('channel-a', 'chat-a', { status: 'closed' }))
  }
  const handlers = new Map<string, Handler>()
  const removeHandler = vi.fn()
  const ipc = {
    handle: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler)
    }),
    removeHandler
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  const getChat = vi.fn((chatId: string) => {
    if (chatId !== 'chat-a' && chatId !== 'chat-b' && chatId !== 'chat-archived') return null
    return {
      appChatId: chatId,
      title: chatId === 'chat-a' ? 'Canonical Chat A' : 'Canonical Chat B',
      archived: chatId === 'chat-archived'
    }
  })
  const resolveSenderScope = vi.fn(() => {
    if (typeof scopeOverride === 'function') return scopeOverride()
    return scopeOverride ?? { kind: 'main' as const }
  })
  const deps: ChannelHandlersDeps = {
    service: service as unknown as ChannelHandlersDeps['service'],
    getChat,
    resolveSenderScope,
    ...depsOverrides
  }
  const registration = registerChannelHandlers(ipc, deps)

  const invoke = async <T>(name: string, payload?: unknown): Promise<ChannelIpcResult<T>> => {
    const handler = handlers.get(name)
    if (!handler) throw new Error(`missing handler ${name}`)
    return (await handler(
      event(),
      ...(payload === undefined ? [] : [payload])
    )) as ChannelIpcResult<T>
  }

  return { channels, deps, service, handlers, removeHandler, registration, invoke }
}

describe('registerChannelHandlers', () => {
  it('registers and disposes the complete shared Channel IPC contract idempotently', () => {
    const { handlers, removeHandler, registration } = fixture()
    expect([...handlers.keys()]).toEqual(Object.values(CHANNEL_IPC_CHANNELS))
    expect(removeHandler.mock.calls.map(([name]) => name)).toEqual(
      Object.values(CHANNEL_IPC_CHANNELS)
    )

    registration.dispose()
    expect(removeHandler).toHaveBeenCalledTimes(Object.values(CHANNEL_IPC_CHANNELS).length * 2)
  })

  it('projects every Channel for main and only the bound chat for a popout', async () => {
    const main = fixture()
    const mainResult = await main.invoke<ChannelIpcChannel[]>(CHANNEL_IPC_CHANNELS.list)
    expect(mainResult).toMatchObject({
      ok: true,
      value: [{ channelId: 'channel-a' }, { channelId: 'channel-b' }]
    })
    expect(JSON.stringify(mainResult)).not.toMatch(/identityPublicKey|roomId|tokenHash/)

    const popout = fixture({ scope: { kind: 'chat', chatId: 'chat-a' } })
    const popoutResult = await popout.invoke<ChannelIpcChannel[]>(CHANNEL_IPC_CHANNELS.list)
    expect(popoutResult).toMatchObject({ ok: true, value: [{ channelId: 'channel-a' }] })
    expect(popout.deps.getChat).toHaveBeenCalledWith('chat-a')
  })

  it('binds reads and audit evidence to main-owned sender/chat authority', async () => {
    const own = fixture({ scope: { kind: 'chat', chatId: 'chat-a' } })
    const read = await own.invoke(CHANNEL_IPC_CHANNELS.read, {
      channelId: 'channel-a',
      resumeAfter: 0,
      maxRecords: 32,
      maxBytes: 4_096
    })
    expect(read.ok).toBe(true)
    expect(read).toMatchObject({
      value: {
        pendingAdmissions: [
          {
            memberId: 'joining-channel-a',
            displayName: 'Alex',
            confirmCode: '123456',
            expiresAt: 120_000
          }
        ]
      }
    })
    expect(own.service.readChannel).toHaveBeenCalledWith({
      channelId: 'channel-a',
      resumeAfter: 0,
      maxRecords: 32,
      maxBytes: 4_096
    })
    expect(JSON.stringify(read)).not.toMatch(/identityPublicKey|roomId|tokenHash|handshakeId/)

    const audit = await own.invoke(CHANNEL_IPC_CHANNELS.audit, { limit: 12 })
    expect(audit.ok).toBe(true)
    expect(own.service.listAudit).toHaveBeenCalledWith({ channelId: 'channel-a', limit: 12 })
    expect(JSON.stringify(audit)).not.toContain('rawPayload')

    const denied = await own.invoke(CHANNEL_IPC_CHANNELS.read, {
      channelId: 'channel-b',
      resumeAfter: 0
    })
    expect(denied).toEqual({
      ok: false,
      error: {
        code: 'not_authorized',
        message: 'Renderer is not authorised for this Channel.'
      }
    })
    const absent = await own.invoke(CHANNEL_IPC_CHANNELS.read, {
      channelId: 'channel-that-does-not-exist',
      resumeAfter: 0
    })
    expect(absent).toEqual(denied)
    expect(own.service.readChannel).toHaveBeenCalledTimes(1)
  })

  it('creates from the persisted chat title/reference and rejects renderer-owned metadata', async () => {
    const target = fixture({ scope: { kind: 'chat', chatId: 'chat-a' } })
    const created = await target.invoke(CHANNEL_IPC_CHANNELS.create, {
      chatId: 'chat-a',
      ownerDisplayName: '  Host Name  '
    })
    expect(created.ok).toBe(true)
    expect(target.service.createChannel).toHaveBeenCalledWith({
      chatId: 'chat-a',
      title: 'Canonical Chat A',
      ownerDisplayName: 'Host Name',
      reference: { kind: 'chat', id: 'chat-a' }
    })

    const forged = await target.invoke(CHANNEL_IPC_CHANNELS.create, {
      chatId: 'chat-a',
      ownerDisplayName: 'Host',
      title: 'Renderer title'
    })
    expect(forged).toMatchObject({ ok: false, error: { code: 'protocol_unsupported' } })
    expect(target.service.createChannel).toHaveBeenCalledTimes(1)

    const crossChat = await target.invoke(CHANNEL_IPC_CHANNELS.create, {
      chatId: 'chat-b',
      ownerDisplayName: 'Host'
    })
    expect(crossChat).toMatchObject({ ok: false, error: { code: 'not_authorized' } })
    expect(target.service.createChannel).toHaveBeenCalledTimes(1)
  })

  it('routes bounded host mutations without exposing store authority', async () => {
    const target = fixture({ scope: { kind: 'chat', chatId: 'chat-a' } })
    const invite = await target.invoke(CHANNEL_IPC_CHANNELS.issueInvite, {
      channelId: 'channel-a',
      ttlMs: 60_000
    })
    expect(invite).toMatchObject({
      ok: true,
      value: { inviteToken: 'one-shot-token', roomId: 'room-a' }
    })
    expect(JSON.stringify(invite)).not.toContain('tokenHash')
    expect(target.service.issueInvite).toHaveBeenCalledWith({
      channelId: 'channel-a',
      ttlMs: 60_000
    })

    const appended = await target.invoke(CHANNEL_IPC_CHANNELS.append, {
      channelId: 'channel-a',
      clientMessageId: 'client-2',
      content: 'next'
    })
    expect(appended).toMatchObject({
      ok: true,
      value: { record: { kind: 'human.text', content: 'next' } }
    })
    expect(target.service.appendHost).toHaveBeenCalledWith({
      channelId: 'channel-a',
      clientMessageId: 'client-2',
      content: 'next'
    })

    const revoked = await target.invoke(CHANNEL_IPC_CHANNELS.revokeMember, {
      channelId: 'channel-a',
      memberId: 'member-a'
    })
    expect(revoked).toMatchObject({ ok: true, value: { status: 'revoked' } })
    expect(JSON.stringify(revoked)).not.toContain('identityPublicKey')

    const closed = await target.invoke(CHANNEL_IPC_CHANNELS.close, {
      channelId: 'channel-a'
    })
    expect(closed).toMatchObject({ ok: true, value: { status: 'closed' } })
  })

  it('rejects unknown fields, invalid limits, oversized text, and owner revocation before service calls', async () => {
    const target = fixture()
    const invalidPayloads: Array<[string, unknown]> = [
      [CHANNEL_IPC_CHANNELS.read, { channelId: 'channel-a', resumeAfter: -1 }],
      [CHANNEL_IPC_CHANNELS.audit, { limit: 1_001 }],
      [CHANNEL_IPC_CHANNELS.issueInvite, { channelId: 'channel-a', ttlMs: 999 }],
      [
        CHANNEL_IPC_CHANNELS.append,
        { channelId: 'channel-a', clientMessageId: 'client', content: 'x'.repeat(8_001) }
      ],
      [
        CHANNEL_IPC_CHANNELS.append,
        { channelId: 'channel-a', clientMessageId: 'client', content: 'ok', kind: 'agent.text' }
      ],
      [CHANNEL_IPC_CHANNELS.close, { channelId: 'channel-a', force: true }]
    ]
    for (const [name, payload] of invalidPayloads) {
      const result = await target.invoke(name, payload)
      expect(result).toMatchObject({ ok: false })
    }
    expect(target.service.readChannel).not.toHaveBeenCalled()
    expect(target.service.issueInvite).not.toHaveBeenCalled()
    expect(target.service.appendHost).not.toHaveBeenCalled()
    expect(target.service.closeChannel).not.toHaveBeenCalled()

    const owner = await target.invoke(CHANNEL_IPC_CHANNELS.revokeMember, {
      channelId: 'channel-a',
      memberId: 'owner-channel-a'
    })
    expect(owner).toMatchObject({ ok: false, error: { code: 'protocol_unsupported' } })
    expect(target.service.revokeMember).not.toHaveBeenCalled()
  })

  it('returns typed service failures and scrubs unknown internal errors', async () => {
    const blocked = fixture()
    blocked.service.appendHost.mockRejectedValueOnce(
      new ChannelError('recovery_blocked', 'Channel history could not be recovered safely')
    )
    const blockedResult = await blocked.invoke(CHANNEL_IPC_CHANNELS.append, {
      channelId: 'channel-a',
      clientMessageId: 'client',
      content: 'hello'
    })
    expect(blockedResult).toEqual({
      ok: false,
      error: {
        code: 'recovery_blocked',
        message: 'Channel history could not be recovered safely'
      }
    })

    blocked.service.appendHost.mockRejectedValueOnce(
      new Error('failed at /Users/alice/private/channels.json')
    )
    const unknown = await blocked.invoke(CHANNEL_IPC_CHANNELS.append, {
      channelId: 'channel-a',
      clientMessageId: 'client-2',
      content: 'hello again'
    })
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Channel operation failed.' }
    })
    expect(JSON.stringify(unknown)).not.toContain('/Users/alice')

    blocked.service.appendHost.mockRejectedValueOnce(
      new ChannelError(
        'host_unavailable',
        'token=super-secret-value failed at /Users/alice/private/channels.json'
      )
    )
    const typedSecret = await blocked.invoke(CHANNEL_IPC_CHANNELS.append, {
      channelId: 'channel-a',
      clientMessageId: 'client-3',
      content: 'hello once more'
    })
    expect(typedSecret).toMatchObject({ ok: false, error: { code: 'host_unavailable' } })
    expect(JSON.stringify(typedSecret)).not.toMatch(/super-secret-value|\/Users\/alice/)
  })

  it('fails closed when main cannot establish the renderer scope', async () => {
    const target = fixture({
      scope: () => {
        throw new Error('sender registry unavailable')
      }
    })
    const result = await target.invoke(CHANNEL_IPC_CHANNELS.list)
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'not_authorized',
        message: 'Renderer is not authorised for Channels.'
      }
    })
    expect(target.service.listChannels).not.toHaveBeenCalled()

    const malformed = await target.invoke(CHANNEL_IPC_CHANNELS.read, 'not-an-object')
    expect(malformed).toEqual(result)
    expect(target.service.readChannel).not.toHaveBeenCalled()
  })
})
