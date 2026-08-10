import type { IpcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type {
  ChannelIpcChangeEvent,
  ChannelIpcChannel,
  ChannelIpcResult
} from '../../shared/collaboration/ChannelIpc'
import type {
  ChannelProductionService,
  ChannelProductionServiceOptions
} from './ChannelProductionService'
import {
  createChannelProductionBootstrap,
  createChannelProductionRelayPort,
  type ChannelProductionBootstrapOptions
} from './ChannelProductionBootstrap'
import type { ChannelAgentIdentitySafeStorage } from './ChannelAgentIdentityStore'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const safeStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8')
}

function channel(channelId: string, chatId: string): ChannelIpcChannel {
  return {
    channelId,
    chatId,
    ownerMemberId: `owner-${channelId}`,
    status: 'active',
    availability: 'ready',
    createdAt: 1,
    updatedAt: 1,
    membershipRevision: 1,
    messageCount: 0,
    display: { title: channelId, status: 'active', memberCount: 1, messageCount: 0 }
  }
}

function fakeService(channels = [channel('channel-a', 'chat-a'), channel('channel-b', 'chat-b')]): {
  service: ChannelProductionService
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  const start = vi.fn(() => ({
    state: 'running' as const,
    channelCount: channels.length,
    recoveryBlockedChannelCount: 0,
    openRoomCount: 0
  }))
  const stop = vi.fn(async () => undefined)
  return {
    start,
    stop,
    service: {
      start,
      stop,
      status: start,
      hostIdentityPublicKey: vi.fn(() => 'public-key'),
      refreshRelayRooms: vi.fn(() => 0),
      listChannels: vi.fn(() => channels as never),
      readChannel: vi.fn(),
      listAudit: vi.fn(() => []),
      createChannel: vi.fn(),
      issueInvite: vi.fn(),
      appendHost: vi.fn(),
      revokeMember: vi.fn(),
      enrollAgent: vi.fn(),
      grantAgentDispatch: vi.fn(),
      revokeAgent: vi.fn(),
      rotateAgentKey: vi.fn(),
      closeChannel: vi.fn(),
      purgeForHistoryDeletionScope: vi.fn()
    }
  }
}

function harness(overrides: Partial<ChannelProductionBootstrapOptions> = {}): {
  bootstrap: ReturnType<typeof createChannelProductionBootstrap>
  handlers: Map<string, Handler>
  removeHandler: ReturnType<typeof vi.fn>
  serviceOptions: ChannelProductionServiceOptions
  service: ReturnType<typeof fakeService>
  publishToMain: ReturnType<typeof vi.fn>
  publishToChat: ReturnType<typeof vi.fn>
  logger: ReturnType<typeof vi.fn>
} {
  const { createService: injectedCreateService, ...optionOverrides } = overrides
  const handlers = new Map<string, Handler>()
  const removeHandler = vi.fn((name: string) => handlers.delete(name))
  const ipc = {
    handle: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    removeHandler
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  const service = fakeService()
  let serviceOptions: ChannelProductionServiceOptions | undefined
  const publishToMain = vi.fn()
  const publishToChat = vi.fn()
  const logger = vi.fn()
  const bootstrap = createChannelProductionBootstrap({
    userDataPath: '/tmp/channel-production-bootstrap-test',
    loadIdentity: generateIdentityKeyPair,
    safeStorage,
    relay: { hostRelayUrl: () => '', inviteRelayUrls: () => [] },
    ipc,
    getChat: (chatId) => ({ appChatId: chatId, title: chatId, archived: false }),
    isMainSender: (event) => event.sender.id === 1,
    getOwnedChatId: (senderId) => (senderId === 2 ? 'chat-a' : null),
    publishToMain,
    publishToChat,
    logger,
    ...optionOverrides,
    createService: (options) => {
      serviceOptions = options
      return injectedCreateService?.(options) ?? service.service
    }
  })
  if (!serviceOptions) throw new Error('service factory was not called')
  return {
    bootstrap,
    handlers,
    removeHandler,
    serviceOptions,
    service,
    publishToMain,
    publishToChat,
    logger
  }
}

describe('ChannelProductionBootstrap', () => {
  it('registers exactly eight handlers and binds popouts to their main-owned chat', async () => {
    const fixture = harness()

    expect(fixture.handlers.size).toBe(0)
    expect(fixture.serviceOptions.safeStorage).toBe(safeStorage)
    expect(fixture.bootstrap.start()).toMatchObject({ state: 'running', channelCount: 2 })
    expect([...fixture.handlers.keys()].sort()).toEqual(
      [
        'channels:append',
        'channels:audit',
        'channels:close',
        'channels:create',
        'channels:issue-invite',
        'channels:list',
        'channels:read',
        'channels:revoke-member'
      ].sort()
    )

    const list = fixture.handlers.get('channels:list')
    if (!list) throw new Error('channels:list was not registered')
    const main = (await list({ sender: { id: 1 } })) as ChannelIpcResult<ChannelIpcChannel[]>
    const popout = (await list({ sender: { id: 2 } })) as ChannelIpcResult<ChannelIpcChannel[]>
    const denied = (await list({ sender: { id: 3 } })) as ChannelIpcResult<ChannelIpcChannel[]>

    expect(main.ok && main.value.map((item) => item.channelId)).toEqual(['channel-a', 'channel-b'])
    expect(popout.ok && popout.value.map((item) => item.channelId)).toEqual(['channel-a'])
    expect(denied).toMatchObject({ ok: false, error: { code: 'not_authorized' } })
  })

  it('projects safe changes to main and only the exact owning chat popout', async () => {
    const publishToMain = vi.fn((_event: ChannelIpcChangeEvent) => {
      throw new Error('main window closed')
    })
    const fixture = harness({
      publishToMain
    })
    fixture.bootstrap.start()

    fixture.serviceOptions.onChange?.({
      channelId: 'channel-a',
      chatId: 'chat-a',
      reason: 'message'
    })

    expect(publishToMain).toHaveBeenCalledWith({
      channelId: 'channel-a',
      reason: 'message'
    })
    expect(publishToMain.mock.calls[0][0]).not.toHaveProperty('chatId')
    expect(fixture.publishToChat).toHaveBeenCalledWith('chat-a', {
      channelId: 'channel-a',
      reason: 'message'
    })
    expect(fixture.publishToChat.mock.calls[0][1]).not.toHaveProperty('chatId')
    expect(fixture.logger).toHaveBeenCalledWith(
      '[channels] main renderer change publication failed'
    )

    await fixture.bootstrap.stop()
    fixture.serviceOptions.onChange?.({
      channelId: 'channel-a',
      chatId: 'chat-a',
      reason: 'channel'
    })
    expect(fixture.publishToChat).toHaveBeenCalledTimes(1)
  })

  it('disposes all handlers before awaiting service shutdown', async () => {
    const fixture = harness()
    fixture.bootstrap.start()

    await fixture.bootstrap.stop()

    expect(fixture.handlers.size).toBe(0)
    expect(fixture.removeHandler).toHaveBeenCalledTimes(16)
    expect(fixture.service.stop).toHaveBeenCalledOnce()
    await expect(fixture.bootstrap.stop()).resolves.toBeUndefined()
    expect(fixture.service.stop).toHaveBeenCalledOnce()
  })

  it('disposes handlers and stops the service when startup fails', () => {
    const service = fakeService()
    service.start.mockImplementation(() => {
      throw new Error('identity unavailable')
    })
    const fixture = harness({
      createService: () => service.service
    })

    expect(() => fixture.bootstrap.start()).toThrow('identity unavailable')
    expect(fixture.handlers.size).toBe(0)
    expect(service.stop).toHaveBeenCalledOnce()
  })

  it('requires main-injected safeStorage before constructing the service', () => {
    expect(() => harness({ safeStorage: undefined as never })).toThrow(
      'requires injected safeStorage'
    )
  })
})

describe('createChannelProductionRelayPort', () => {
  it('prefers embedded loopback for the host and advertises every usable door', () => {
    let port: number | null = 8787
    const relay = createChannelProductionRelayPort({
      getEmbeddedRelayPort: () => port,
      getAdvertisedRelayUrls: () => [' wss://relay.example ', 'ws://lan.example']
    })

    expect(relay.hostRelayUrl()).toBe('ws://127.0.0.1:8787')
    expect(relay.inviteRelayUrls()).toEqual([
      'wss://relay.example',
      'ws://lan.example',
      'ws://127.0.0.1:8787'
    ])

    port = null
    expect(relay.hostRelayUrl()).toBe('wss://relay.example')
    expect(relay.inviteRelayUrls()).toEqual(['wss://relay.example', 'ws://lan.example'])
  })
})
