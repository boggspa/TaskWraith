import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_MEMBER_IPC_CHANNELS,
  type ChannelMemberIpcChangeEvent,
  type ChannelMemberIpcResult
} from '../../shared/collaboration/ChannelMemberIpc'
import type {
  ChannelMemberProductionService,
  ChannelMemberProductionServiceOptions,
  ChannelMemberProductionSnapshot
} from './ChannelMemberProductionService'
import {
  createChannelMemberProductionBootstrap,
  type ChannelMemberProductionBootstrapOptions
} from './ChannelMemberProductionBootstrap'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function snapshot(
  overrides: Partial<ChannelMemberProductionSnapshot> = {}
): ChannelMemberProductionSnapshot {
  return {
    phase: 'disconnected',
    connected: false,
    channel: {
      channelId: 'channel-a',
      hostChatId: 'host-chat-a',
      memberId: 'member-b',
      displayName: 'Member B',
      title: 'Design room',
      status: 'active',
      savedAt: 1_000,
      updatedAt: 1_100
    },
    members: [],
    records: [],
    highWaterSequence: 0,
    error: null,
    ...overrides
  }
}

function fakeService(initial = snapshot()): {
  service: ChannelMemberProductionService
  current: ChannelMemberProductionSnapshot
  reconnect: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  listMemberships: ReturnType<typeof vi.fn>
} {
  const state = { current: initial }
  const reconnect = vi.fn(async () => {
    state.current = snapshot({ phase: 'connected', connected: true })
    return state.current
  })
  const dispose = vi.fn()
  const listMemberships = vi.fn(() => [])
  return {
    get current() {
      return state.current
    },
    reconnect,
    dispose,
    listMemberships,
    service: {
      snapshot: () => state.current,
      listMemberships,
      beginJoin: vi.fn(),
      confirmJoin: vi.fn(),
      reconnect,
      append: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn(),
      resetLocalHistory: vi.fn(),
      forget: vi.fn(),
      dispose
    }
  }
}

function event(id: number): IpcMainInvokeEvent {
  return { sender: { id } } as unknown as IpcMainInvokeEvent
}

function harness(
  overrides: Partial<ChannelMemberProductionBootstrapOptions> = {},
  injectedService = fakeService()
): {
  bootstrap: ReturnType<typeof createChannelMemberProductionBootstrap>
  handlers: Map<string, Handler>
  removeHandler: ReturnType<typeof vi.fn>
  serviceOptions: ChannelMemberProductionServiceOptions
  service: ReturnType<typeof fakeService>
  publishToMain: ReturnType<typeof vi.fn>
  logger: ReturnType<typeof vi.fn>
} {
  const { createService: injectedCreateService, ...optionOverrides } = overrides
  const handlers = new Map<string, Handler>()
  const removeHandler = vi.fn((name: string) => handlers.delete(name))
  const ipc = {
    handle: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
    removeHandler
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>
  const publishToMain = vi.fn()
  const logger = vi.fn()
  let serviceOptions: ChannelMemberProductionServiceOptions | undefined
  const bootstrap = createChannelMemberProductionBootstrap({
    userDataPath: '/tmp/channel-member-production-bootstrap-test',
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString('utf8')
    },
    ipc,
    assertMainRendererSender: (source) => {
      if (source.sender.id !== 1) throw new Error('secondary renderer')
    },
    publishToMain,
    logger,
    ...optionOverrides,
    createService: (options) => {
      serviceOptions = options
      return injectedCreateService?.(options) ?? injectedService.service
    }
  })
  if (!serviceOptions) throw new Error('service factory was not called')
  return {
    bootstrap,
    handlers,
    removeHandler,
    serviceOptions,
    service: injectedService,
    publishToMain,
    logger
  }
}

describe('ChannelMemberProductionBootstrap', () => {
  it('registers the exact member surface once and reconnects the active durable membership', () => {
    const fixture = harness()

    expect(fixture.handlers.size).toBe(0)
    expect(fixture.bootstrap.start()).toMatchObject({
      phase: 'disconnected',
      channel: { channelId: 'channel-a' }
    })
    expect([...fixture.handlers.keys()]).toEqual(Object.values(CHANNEL_MEMBER_IPC_CHANNELS))
    expect(fixture.service.reconnect).toHaveBeenCalledWith()

    fixture.bootstrap.start()
    expect(fixture.service.reconnect).toHaveBeenCalledTimes(1)
    expect(fixture.removeHandler).toHaveBeenCalledTimes(
      Object.values(CHANNEL_MEMBER_IPC_CHANNELS).length
    )
  })

  it.each([
    snapshot({ phase: 'idle', channel: null }),
    snapshot({ phase: 'revoked', channel: { ...snapshot().channel!, status: 'revoked' } }),
    snapshot({ phase: 'recovery_blocked' })
  ])('does not auto-reconnect a non-connectable startup snapshot %#', (initial) => {
    const service = fakeService(initial)
    const fixture = harness({}, service)

    fixture.bootstrap.start()

    expect(service.reconnect).not.toHaveBeenCalled()
  })

  it('projects a bounded invalidation only to main and stops publishing after shutdown', async () => {
    const publishToMain = vi.fn((_event: ChannelMemberIpcChangeEvent) => {
      throw new Error('main window closed')
    })
    const fixture = harness({ publishToMain })
    fixture.bootstrap.start()

    fixture.serviceOptions.onChange?.(
      Object.assign(snapshot(), {
        relayUrls: ['wss://must-not-cross.example'],
        inviteToken: 'must-not-cross-main',
        sessionId: 'must-not-cross-main'
      })
    )
    expect(publishToMain).toHaveBeenCalledWith({
      channelId: 'channel-a',
      reason: 'snapshot'
    })
    expect(JSON.stringify(publishToMain.mock.calls[0][0])).not.toMatch(
      /relayUrls|inviteToken|sessionId|must-not-cross/
    )
    expect(fixture.logger).toHaveBeenCalledWith('[channels] member projection publication failed')

    fixture.serviceOptions.onChange?.(
      snapshot({ channel: { ...snapshot().channel!, channelId: '../invalid' } })
    )
    expect(publishToMain).toHaveBeenLastCalledWith({ reason: 'snapshot' })

    await fixture.bootstrap.stop()
    fixture.serviceOptions.onChange?.(snapshot())
    expect(publishToMain).toHaveBeenCalledTimes(2)
  })

  it('keeps secondary renderers outside the global member authority', async () => {
    const fixture = harness()
    fixture.bootstrap.start()
    const list = fixture.handlers.get(CHANNEL_MEMBER_IPC_CHANNELS.list)
    if (!list) throw new Error('member list handler was not registered')

    const denied = (await list(event(2))) as ChannelMemberIpcResult<unknown>

    expect(denied).toMatchObject({ ok: false, error: { code: 'not_authorized' } })
    expect(fixture.service.listMemberships).not.toHaveBeenCalled()
  })

  it('disposes every handler and the service exactly once', async () => {
    const fixture = harness()
    fixture.bootstrap.start()

    await fixture.bootstrap.stop()
    await fixture.bootstrap.stop()

    expect(fixture.handlers.size).toBe(0)
    expect(fixture.removeHandler).toHaveBeenCalledTimes(
      Object.values(CHANNEL_MEMBER_IPC_CHANNELS).length * 2
    )
    expect(fixture.service.dispose).toHaveBeenCalledOnce()
    expect(() => fixture.bootstrap.start()).toThrow('has stopped')
  })
})
