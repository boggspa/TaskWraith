import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboard, ipcMain } from 'electron'
import {
  registerHumanCollaborationHandlers,
  type HumanCollaborationHandlersDeps
} from './humanCollaborationHandlers'
import type { HumanCollaborationShare } from '../collaboration/HumanCollaborationStore'
import type { ChatRecord } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  },
  clipboard: {
    writeText: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedWriteText = vi.mocked(clipboard.writeText)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedWriteText.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function chat(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex',
    title: id,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function share(overrides: Partial<HumanCollaborationShare> = {}): HumanCollaborationShare {
  return {
    shareId: 'share-1',
    chatId: 'chat-1',
    mode: 'comments',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    nextSequence: 1,
    participants: [
      {
        collaboratorId: 'collab-1',
        displayName: 'Collaborator',
        publicKeyId: 'pub-1',
        status: 'active'
      }
    ],
    invites: [
      {
        inviteId: 'invite-1',
        tokenHash: 'token-hash',
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        roomId: 'room-1',
        collaboratorId: 'collab-1'
      }
    ],
    idempotency: {},
    ...overrides
  }
}

function createDeps(overrides: Partial<HumanCollaborationHandlersDeps> = {}) {
  const baseChat = chat('chat-1')
  const baseShare = share()
  const runtime = {
    hostIdentityPubKeyB64: vi.fn(() => 'host-key'),
    connectedChatIds: vi.fn(() => ['chat-1']),
    sessionSummaries: vi.fn(() => [{ chatId: 'chat-1' }]),
    publishProjectionUpdates: vi.fn(async () => undefined),
    beginAdmission: vi.fn(async () => ({ confirmCode: '123456' })),
    confirmSas: vi.fn(async () => ({ chatId: 'chat-1' })),
    subscribeProjection: vi.fn(() => ({ ok: true })),
    appendComment: vi.fn(() => ({ ok: true })),
    routeEncryptedAction: vi.fn(() => ({ ok: true })),
    disconnect: vi.fn(() => ({ ok: true }))
  }
  const deps = {
    chatService: {
      getChat: vi.fn((chatId: string) => (chatId === 'chat-1' ? baseChat : null)),
      createHumanCollaborationShare: vi.fn(() => ({
        share: baseShare,
        invite: baseShare.invites[0],
        inviteToken: 'invite-token',
        roomId: 'room-1'
      })),
      listHumanCollaborationShares: vi.fn(() => [baseShare]),
      revokeHumanCollaborationShare: vi.fn(() => baseShare),
      revokeHumanCollaborationParticipant: vi.fn(() => baseShare),
      consumeHumanCollaborationInvite: vi.fn(() => ({
        share: baseShare,
        participant: baseShare.participants[0]
      })),
      appendCollaboratorComment: vi.fn(() => ({
        chat: baseChat,
        message: {
          id: 'message-1',
          role: 'assistant' as const,
          content: 'comment',
          timestamp: '2026-01-01T00:00:00.000Z'
        },
        deduped: false
      })),
      promoteCollaboratorComment: vi.fn(() => ({ chat: baseChat, draft: 'draft' })),
      updateHumanCollaborationShareRules: vi.fn(() => baseShare)
    },
    humanCollaborationStore: {
      getShare: vi.fn(() => baseShare),
      getShareForChat: vi.fn(() => baseShare)
    },
    humanCollaborationAuditLog: {
      list: vi.fn(() => [{ kind: 'share.created' }])
    },
    getSettings: vi.fn(() => ({ iosRemoteEnabled: true }) as never),
    getUserDataPath: vi.fn(() => '/tmp/taskwraith-test'),
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn((plain: string) => Buffer.from(plain)),
      decryptString: vi.fn((encrypted: Buffer) => encrypted.toString())
    },
    getIosRemoteRuntime: vi.fn(() => ({
      describeHost: () => ({ relayUrls: ['ws://remote'] })
    })),
    getIosRemoteRuntimeError: vi.fn(() => null),
    getSelfHostedWssLane: vi.fn(() => null),
    startIosRemoteBridge: vi.fn(async () => undefined),
    maybeUpgradeIosRemoteToTailscaleLane: vi.fn(async () => undefined),
    getIosRemoteTailscaleStatus: vi.fn(async () => ({
      active: true,
      suggestedUrl: 'wss://tailnet',
      tailscaleReason: null
    })),
    getIosRemoteServeHttpsPort: vi.fn(() => 8443),
    collaborationHostRelayUrl: vi.fn(() => 'ws://host'),
    collaborationInviteRelayUrls: vi.fn(() => ['ws://remote']),
    getTailscaleServeStatus: vi.fn(async () => ({ configured: true })),
    enableTailscaleServe: vi.fn(async () => ({ ok: true })),
    selectAdvertisableRelayUrls: vi.fn(async (relayUrls: string[]) => ({
      advertisable: relayUrls,
      warnings: []
    })),
    getHumanCollaborationRuntime: vi.fn(() => runtime),
    getCurrentHumanCollaborationRuntime: vi.fn(() => runtime),
    openCollaborationHostRoom: vi.fn(),
    closeCollaborationHostRoom: vi.fn(),
    socketFactory: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })),
    sendToMainWindow: vi.fn(),
    broadcastChatUpdated: vi.fn(),
    broadcastHumanCollaborationUpdate: vi.fn(),
    ...overrides
  } as HumanCollaborationHandlersDeps

  return { deps, runtime, baseChat, baseShare }
}

describe('registerHumanCollaborationHandlers', () => {
  it('registers the human collaboration IPC channel surface', () => {
    registerHumanCollaborationHandlers(createDeps().deps)

    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'human-collaboration:invite-health',
      'human-collaboration:create-share',
      'human-collaboration:copy-invite',
      'human-collaboration:list-shares',
      'human-collaboration:connected-chat-ids',
      'human-collaboration:session-status',
      'human-collaboration:revoke-share',
      'human-collaboration:revoke-participant',
      'human-collaboration:consume-invite',
      'human-collaboration:append-comment',
      'human-collaboration:projection',
      'human-collaboration-runtime:begin-admission',
      'human-collaboration-runtime:confirm-sas',
      'human-collaboration-runtime:subscribe-projection',
      'human-collaboration-runtime:append-comment',
      'human-collaboration-runtime:receive-frame',
      'human-collaboration-runtime:disconnect',
      'human-collaboration:promote-comment',
      'human-collaboration:update-share-rules',
      'human-collaboration:audit-log',
      'human-collaboration-collaborator:join',
      'human-collaboration-collaborator:confirm',
      'human-collaboration-collaborator:last-session',
      'human-collaboration-collaborator:reconnect',
      'human-collaboration-collaborator:append-comment',
      'human-collaboration-collaborator:leave'
    ])
  })

  it('reports invite health without constructing the runtime', async () => {
    const { deps } = createDeps({
      getCurrentHumanCollaborationRuntime: vi.fn(() => null)
    })
    registerHumanCollaborationHandlers(deps)

    await expect(handlerFor('human-collaboration:invite-health')({}, 'chat-1')).resolves.toMatchObject({
      chatAvailable: true,
      shareEnabled: true,
      bridgeEnabled: true,
      bridgeRunning: true,
      relayUrls: ['ws://remote'],
      tailscaleConfigured: true,
      tailscaleSuggestedUrl: 'wss://tailnet',
      tailscaleReason: null
    })
    expect(deps.humanCollaborationStore.getShareForChat).toHaveBeenCalledWith('chat-1')
    expect(deps.getHumanCollaborationRuntime).not.toHaveBeenCalled()
  })

  it('creates a share, opens its host room, and returns collaborator transport coordinates', async () => {
    const { deps } = createDeps()
    registerHumanCollaborationHandlers(deps)

    await expect(
      handlerFor('human-collaboration:create-share')({}, {
        chatId: 'chat-1',
        mode: 'comments',
        inviteTtlMs: 5000
      })
    ).resolves.toMatchObject({
      share: { shareId: 'share-1', chatId: 'chat-1' },
      relayUrl: 'ws://remote',
      relayUrls: ['ws://remote'],
      hostIdentityPubKeyB64: 'host-key'
    })
    expect(deps.maybeUpgradeIosRemoteToTailscaleLane).toHaveBeenCalledWith(
      'human collaboration invite'
    )
    expect(deps.selectAdvertisableRelayUrls).toHaveBeenCalledWith(['ws://remote'])
    expect(deps.chatService.createHumanCollaborationShare).toHaveBeenCalledWith({
      chatId: 'chat-1',
      mode: 'comments',
      inviteTtlMs: 5000
    })
    expect(deps.openCollaborationHostRoom).toHaveBeenCalledWith('ws://host', 'room-1')
    expect(deps.broadcastHumanCollaborationUpdate).toHaveBeenCalledWith('chat-1')
  })

  it('routes host actions through injected collaborators and preserves side effects', async () => {
    const { deps, runtime } = createDeps()
    registerHumanCollaborationHandlers(deps)

    expect(handlerFor('human-collaboration:copy-invite')({}, { invite: ' invite ' })).toEqual({
      ok: true
    })
    expect(mockedWriteText).toHaveBeenCalledWith('invite', 'clipboard')

    expect(handlerFor('human-collaboration:connected-chat-ids')({})).toEqual(['chat-1'])
    expect(handlerFor('human-collaboration:session-status')({})).toEqual([{ chatId: 'chat-1' }])

    expect(handlerFor('human-collaboration:revoke-share')({}, 'share-1')).toMatchObject({
      shareId: 'share-1'
    })
    expect(deps.closeCollaborationHostRoom).toHaveBeenCalledWith('room-1')

    expect(
      handlerFor('human-collaboration:append-comment')({}, {
        shareId: 'share-1',
        chatId: 'chat-1',
        collaboratorId: 'collab-1',
        clientMessageId: 'client-1',
        content: 'hello'
      })
    ).toMatchObject({ deduped: false })
    expect(deps.broadcastChatUpdated).toHaveBeenCalled()
    expect(deps.broadcastHumanCollaborationUpdate).toHaveBeenCalledWith('chat-1')

    await expect(
      handlerFor('human-collaboration-runtime:confirm-sas')({}, { handshakeId: 'handshake-1' })
    ).resolves.toEqual({ chatId: 'chat-1' })
    expect(runtime.confirmSas).toHaveBeenCalledWith({ handshakeId: 'handshake-1' })

    expect(
      handlerFor('human-collaboration:update-share-rules')({}, {
        shareId: 'share-1',
        preset: 'autoDraft'
      })
    ).toMatchObject({ shareId: 'share-1' })
    expect(deps.chatService.updateHumanCollaborationShareRules).toHaveBeenCalledWith({
      shareId: 'share-1',
      preset: 'autoDraft'
    })
  })
})
