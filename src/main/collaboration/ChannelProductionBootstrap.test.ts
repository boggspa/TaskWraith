import type { BrowserWindow, IpcMain } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { generateIdentityKeyPair } from '../../shared/e2ee/keys'
import {
  CHANNEL_AGENT_IPC_CHANNELS,
  type ChannelAgentIpcOutcome,
  type ChannelAgentIpcOverview,
  type ChannelAgentIpcResult
} from '../../shared/collaboration/ChannelAgentIpc'
import type {
  ChannelIpcChangeEvent,
  ChannelIpcChannel,
  ChannelIpcResult
} from '../../shared/collaboration/ChannelIpc'
import type {
  ChannelProductionService,
  ChannelProductionServiceOptions
} from './ChannelProductionService'
import type { AppSettings, ChatRecord } from '../store/types'
import {
  hashChannelAgentNativeConfirmation,
  type ChannelAgentNativeConfirmationRequest
} from './ChannelAgentNativeConfirmation'
import {
  createChannelProductionBootstrap,
  createChannelProductionRelayPort,
  type ChannelProductionAgentManagementOptions,
  type ChannelProductionAgentRuntimeOptions,
  type ChannelProductionBootstrapOptions
} from './ChannelProductionBootstrap'
import type { ChannelAgentIdentitySafeStorage } from './ChannelAgentIdentityStore'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown

const safeStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8')
}

const AGENT_SEAT_ID = 'pooled-agent-bootstrap-proof'
const OWNER_WINDOW = { isDestroyed: () => false } as BrowserWindow

function agentChat(): ChatRecord {
  return {
    appChatId: 'chat-a',
    title: 'Chat A',
    workspaceId: 'workspace-a',
    workspacePath: '/workspaces/a',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ensemble: {
      enabled: true,
      maxParticipants: 8,
      participants: [
        {
          id: 'participant-bootstrap-proof',
          provider: 'codex',
          enabled: true,
          role: 'Review changes',
          instructions: 'PRIVATE BOOTSTRAP INSTRUCTIONS MUST STAY IN MAIN',
          order: 1,
          model: 'gpt-5.6-terra',
          permissionPresetId: 'read_only',
          pooledAgentId: AGENT_SEAT_ID,
          pooledAgentIdentity: {
            schemaVersion: 1,
            agentId: AGENT_SEAT_ID,
            nickname: 'Build Agent',
            iconKind: 'seed',
            hue: 120
          }
        }
      ]
    },
    messages: [],
    runs: []
  } as ChatRecord
}

function agentSettings(): AppSettings {
  return {
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: []
  } as unknown as AppSettings
}

function agentManagement() {
  const confirm = vi.fn(
    async (_owner: BrowserWindow | null, request: ChannelAgentNativeConfirmationRequest) => ({
      confirmed: true as const,
      confirmationDigest: hashChannelAgentNativeConfirmation(request)
    })
  )
  const getOwnerWindow = vi.fn(() => OWNER_WINDOW)
  const options: ChannelProductionAgentManagementOptions = {
    getSettings: agentSettings,
    providerAllowed: (provider) => provider === 'codex',
    getWorkspaces: () => [
      {
        id: 'workspace-a',
        path: '/workspaces/a',
        displayName: 'Workspace A',
        lastOpenedAt: 1,
        createdAt: 1,
        pinned: false
      }
    ],
    canonicalizePath: (value) => value,
    getOwnerWindow,
    confirm
  }
  return { options, confirm, getOwnerWindow }
}

function agentExecution(): ChannelProductionAgentRuntimeOptions {
  return {
    composeMainOwnedChannelAgentRun: vi.fn(),
    dispatch: vi.fn(),
    subscribeRunEvents: vi.fn(),
    subscribeRunSessions: vi.fn(),
    claimRunAudience: vi.fn(),
    reconcileRun: vi.fn()
  } as unknown as ChannelProductionAgentRuntimeOptions
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
  startAgentExecution: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
} {
  const start = vi.fn(() => ({
    state: 'running' as const,
    channelCount: channels.length,
    recoveryBlockedChannelCount: 0,
    openRoomCount: 0
  }))
  const startAgentExecution = vi.fn(() => undefined)
  const stop = vi.fn(async () => undefined)
  return {
    start,
    startAgentExecution,
    stop,
    service: {
      start,
      startAgentExecution,
      stop,
      status: start,
      hostIdentityPublicKey: vi.fn(() => 'public-key'),
      refreshRelayRooms: vi.fn(() => 0),
      listChannels: vi.fn(() => channels as never),
      readChannel: vi.fn(),
      inspectAgentSeat: vi.fn(),
      inspectChannelAgentSeats: vi.fn(() => []),
      listAudit: vi.fn(() => []),
      listHumanReviews: vi.fn(() => []),
      approveHumanReview: vi.fn(),
      denyHumanReview: vi.fn(),
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
  const defaultAgentManagement = agentManagement().options
  const bootstrap = createChannelProductionBootstrap({
    userDataPath: '/tmp/channel-production-bootstrap-test',
    loadIdentity: generateIdentityKeyPair,
    safeStorage,
    relay: { hostRelayUrl: () => '', inviteRelayUrls: () => [] },
    ipc,
    getChat: (chatId) => ({ ...agentChat(), appChatId: chatId, title: chatId }),
    isMainSender: (event) => event.sender.id === 1,
    getOwnedChatId: (senderId) => (senderId === 2 ? 'chat-a' : null),
    publishToMain,
    publishToChat,
    agentManagement: defaultAgentManagement,
    agentExecution: agentExecution(),
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
  it('registers the mandatory 16-handler surface and binds popouts to their chat', async () => {
    const fixture = harness()

    expect(fixture.handlers.size).toBe(0)
    expect(fixture.serviceOptions.safeStorage).toBe(safeStorage)
    expect(fixture.serviceOptions.agentExecution).toMatchObject({
      composeMainOwnedChannelAgentRun: expect.any(Function),
      dispatch: expect.any(Function),
      subscribeRunEvents: expect.any(Function),
      subscribeRunSessions: expect.any(Function),
      claimRunAudience: expect.any(Function),
      reconcileRun: expect.any(Function)
    })
    expect(fixture.serviceOptions.agentExecution?.getChat('chat-a')).toMatchObject({
      appChatId: 'chat-a'
    })
    expect(fixture.serviceOptions.agentExecution?.resolveWorkspacePrincipal(agentChat())).toEqual({
      kind: 'workspace',
      workspaceId: 'workspace-a'
    })
    expect(fixture.serviceOptions.agentExecution?.getSettings()).toEqual(agentSettings())
    expect(fixture.serviceOptions.agentExecution?.providerAllowed('codex')).toBe(true)
    expect(fixture.serviceOptions.agentExecution?.providerAllowed('gemini')).toBe(false)
    expect(fixture.bootstrap.start()).toMatchObject({ state: 'running', channelCount: 2 })
    expect(fixture.service.startAgentExecution).not.toHaveBeenCalled()
    fixture.bootstrap.startAgentExecution()
    expect(fixture.service.startAgentExecution).toHaveBeenCalledOnce()
    expect([...fixture.handlers.keys()].sort()).toEqual(
      [
        'channels:append',
        'channels:audit',
        'channels:close',
        'channels:create',
        'channels:deny-human-review',
        'channels:human-reviews',
        'channels:issue-invite',
        'channels:list',
        'channels:approve-human-review',
        'channels:read',
        'channels:revoke-member',
        ...Object.values(CHANNEL_AGENT_IPC_CHANNELS)
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

  it('composes the canonical agent controller, native owner, and closed IPC lifecycle', async () => {
    const management = agentManagement()
    const fixture = harness({ agentManagement: management.options })
    const readyChannel = channel('channel-a', 'chat-a')
    vi.mocked(fixture.service.service.readChannel).mockReturnValue({
      channel: readyChannel,
      members: [
        {
          channelId: 'channel-a',
          memberId: readyChannel.ownerMemberId,
          kind: 'human',
          displayName: 'Owner',
          status: 'active',
          joinedAt: 1
        }
      ],
      pendingAdmissions: [],
      records: [],
      highWaterSequence: 0
    } as never)
    vi.mocked(fixture.service.service.inspectAgentSeat).mockImplementation((agentSeatId) => ({
      agentSeatId,
      currentKeyGeneration: null,
      memberships: []
    }))
    vi.mocked(fixture.service.service.inspectChannelAgentSeats).mockReturnValue([])
    vi.mocked(fixture.service.service.enrollAgent).mockResolvedValue({
      member: {
        channelId: 'channel-a',
        memberId: 'agent-member-1',
        kind: 'agent',
        displayName: 'Build Agent',
        identityPublicKey: 'must-not-cross-ipc',
        status: 'active',
        joinedAt: 2,
        agentSeatId: AGENT_SEAT_ID,
        keyGeneration: 1
      },
      identity: {
        agentSeatId: AGENT_SEAT_ID,
        keyGeneration: 1,
        publicKeyB64: 'must-not-cross-ipc',
        createdAt: 2
      },
      signedDelegation: { mustNotCrossIpc: true }
    } as never)

    fixture.bootstrap.start()

    expect([...fixture.handlers.keys()].sort()).toEqual(
      [
        'channels:append',
        'channels:audit',
        'channels:close',
        'channels:create',
        'channels:deny-human-review',
        'channels:human-reviews',
        'channels:issue-invite',
        'channels:list',
        'channels:approve-human-review',
        'channels:read',
        'channels:revoke-member',
        ...Object.values(CHANNEL_AGENT_IPC_CHANNELS)
      ].sort()
    )
    const overviewHandler = fixture.handlers.get(CHANNEL_AGENT_IPC_CHANNELS.overview)
    const enrollHandler = fixture.handlers.get(CHANNEL_AGENT_IPC_CHANNELS.enroll)
    if (!overviewHandler || !enrollHandler) throw new Error('agent handlers were not registered')

    const overview = (await overviewHandler(
      { sender: { id: 1 } },
      { channelId: 'channel-a' }
    )) as ChannelAgentIpcResult<ChannelAgentIpcOverview>
    expect(overview).toMatchObject({
      ok: true,
      value: {
        channelId: 'channel-a',
        seats: [
          {
            seat: {
              agentSeatId: AGENT_SEAT_ID,
              displayName: 'Build Agent',
              provider: 'codex',
              model: 'gpt-5.6-terra',
              role: 'Review changes'
            },
            currentKeyGeneration: null
          }
        ]
      }
    })
    expect(JSON.stringify(overview)).not.toMatch(/PRIVATE BOOTSTRAP|workspaceIdentityHash/i)

    const enrolled = (await enrollHandler(
      { sender: { id: 1 } },
      {
        requestId: 'bootstrap-request-1',
        channelId: 'channel-a',
        agentSeatId: AGENT_SEAT_ID
      }
    )) as ChannelAgentIpcResult<ChannelAgentIpcOutcome>
    expect(enrolled).toMatchObject({
      ok: true,
      value: {
        status: 'applied',
        value: {
          kind: 'enroll',
          agentSeatId: AGENT_SEAT_ID,
          member: { memberId: 'agent-member-1', keyGeneration: 1 }
        }
      }
    })
    expect(management.getOwnerWindow).toHaveBeenCalledWith(
      expect.objectContaining({ sender: { id: 1 } })
    )
    expect(management.confirm).toHaveBeenCalledWith(
      OWNER_WINDOW,
      expect.objectContaining({
        kind: 'enroll',
        seat: expect.objectContaining({ agentSeatId: AGENT_SEAT_ID })
      })
    )
    expect(fixture.service.service.enrollAgent).toHaveBeenCalledWith({
      channelId: 'channel-a',
      seat: { agentSeatId: AGENT_SEAT_ID, displayName: 'Build Agent' },
      operationId: expect.stringMatching(/^channel-agent-enroll-[a-f0-9]{64}$/)
    })
    expect(JSON.stringify(enrolled)).not.toMatch(/must-not-cross-ipc|signature/i)

    await fixture.bootstrap.stop()
    expect(fixture.handlers.size).toBe(0)
    expect(fixture.removeHandler).toHaveBeenCalledTimes(32)
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
    expect(fixture.removeHandler).toHaveBeenCalledTimes(32)
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
      agentManagement: agentManagement().options,
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

  it('rejects partial agent authority before constructing the service', () => {
    const management = agentManagement()
    expect(() =>
      harness({
        agentManagement: { ...management.options, getOwnerWindow: undefined as never }
      })
    ).toThrow('agent management requires main-owned authority')
  })

  it('rejects partial agent execution before constructing the service', () => {
    expect(() =>
      harness({
        agentExecution: {
          ...agentExecution(),
          reconcileRun: undefined as never
        }
      })
    ).toThrow('agent execution requires main-owned runtime ports')
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
