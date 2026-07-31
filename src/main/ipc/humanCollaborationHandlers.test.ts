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

function contributionEntry(entryId: string, chatId: string, state = 'queued') {
  return {
    entryId,
    chatId,
    shareId: chatId === 'chat-1' ? 'share-1' : 'share-3',
    collaboratorId: 'collab-1',
    displayName: 'Alex',
    clientMessageId: `client-${entryId}`,
    sequence: 1,
    body: 'please look at the failing test',
    bodyBytes: 32,
    state,
    enqueuedAt: 1,
    expiresAt: 2
  } as never
}

function createDeps(overrides: Partial<HumanCollaborationHandlersDeps> = {}) {
  const baseChat = chat('chat-1')
  const baseShare = share()
  const runtime = {
    hostIdentityPubKeyB64: vi.fn(() => 'host-key'),
    connectedChatIds: vi.fn(() => ['chat-1']),
    sessionSummaries: vi.fn<() => unknown[]>(() => [{ chatId: 'chat-1' }]),
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
      updateHumanCollaborationShareRules: vi.fn(() => baseShare),
      // Host review of queued external contributions. `getExternalContribution`
      // resolves by entry id ACROSS chats, exactly as the real store does — that
      // is the whole point of the scope tests below.
      getExternalContribution: vi.fn((entryId: string) =>
        entryId === 'entry-1'
          ? contributionEntry('entry-1', 'chat-1')
          : entryId === 'entry-3'
            ? contributionEntry('entry-3', 'chat-3')
            : null
      ),
      listPendingExternalContributions: vi.fn(() => [contributionEntry('entry-1', 'chat-1')]),
      approveExternalContribution: vi.fn((entryId: string) =>
        contributionEntry(entryId, 'chat-1', 'approved')
      ),
      denyExternalContribution: vi.fn((entryId: string) =>
        contributionEntry(entryId, 'chat-1', 'denied')
      ),
      setHumanCollaborationHostReview: vi.fn(() => baseShare),
      setHumanCollaborationFullHistory: vi.fn(() => baseShare)
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
    republishHumanCollaborationProjection: vi.fn(),
    resolveSenderHumanCollaborationScope: vi.fn(() => ({ kind: 'main' as const })),
    assertMainRendererSender: vi.fn(),
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
      // Host review of queued external contributions. Registered here, so they
      // sit here — this assertion is an ORDERED toEqual, not a set comparison.
      'human-collaboration:list-pending-contributions',
      'human-collaboration:approve-contribution',
      'human-collaboration:deny-contribution',
      'human-collaboration:set-host-review',
      'human-collaboration:set-full-history',
      'human-collaboration:audit-log',
      'human-collaboration-collaborator:join',
      'human-collaboration-collaborator:confirm',
      'human-collaboration-collaborator:last-session',
      'human-collaboration-collaborator:reconnect',
      'human-collaboration-collaborator:append-comment',
      'human-collaboration-collaborator:load-older',
      'human-collaboration-collaborator:leave'
    ])
  })

  describe('host review of queued external contributions', () => {
    it('scopes approve on the ENTRY, never on a payload-supplied chat', () => {
      // The sharpest version of the bug this guards: ExternalContributionQueueStore
      // .approve(entryId) searches one global array and verifies nothing about
      // ownership. The only thing standing between a popout and another chat's
      // queue is that the handler resolves the entry FIRST and asserts against
      // the chatId the entry itself carries.
      const { deps } = createDeps()
      registerHumanCollaborationHandlers(deps)

      handlerFor('human-collaboration:approve-contribution')({ sender: { id: 1 } }, 'entry-1')

      expect(deps.chatService.getExternalContribution).toHaveBeenCalledWith('entry-1')
      expect(deps.chatService.approveExternalContribution).toHaveBeenCalledWith('entry-1')
    })

    it('refuses an unknown entry rather than passing it to the store', () => {
      const { deps } = createDeps()
      registerHumanCollaborationHandlers(deps)

      expect(() =>
        handlerFor('human-collaboration:approve-contribution')({ sender: { id: 1 } }, 'nope')
      ).toThrow('Contribution not found.')
      expect(deps.chatService.approveExternalContribution).not.toHaveBeenCalled()
    })

    it('tells the host renderer AND republishes the collaborator projection', () => {
      // Two different audiences. broadcastHumanCollaborationUpdate reaches the
      // host only; without the republish the contributor is never told what
      // happened to their message, because approve/deny do not touch the
      // ChatRecord and so never trip the projection's usual trigger.
      const { deps } = createDeps()
      registerHumanCollaborationHandlers(deps)

      handlerFor('human-collaboration:approve-contribution')({ sender: { id: 1 } }, 'entry-1')
      expect(deps.broadcastHumanCollaborationUpdate).toHaveBeenCalledWith('chat-1')
      expect(deps.republishHumanCollaborationProjection).toHaveBeenCalledWith('chat-1')

      handlerFor('human-collaboration:deny-contribution')(
        { sender: { id: 1 } },
        { entryId: 'entry-1', reason: 'not now' }
      )
      expect(deps.chatService.denyExternalContribution).toHaveBeenCalledWith('entry-1', 'not now')
      expect(deps.republishHumanCollaborationProjection).toHaveBeenCalledTimes(2)
    })

    it('neither broadcasts nor republishes when the entry was already resolved', () => {
      // approve()/deny() return null for anything not still queued. That is
      // "nothing to do", not success — reporting it as an approval would tell
      // the host something happened that did not.
      const { deps } = createDeps()
      vi.mocked(deps.chatService.approveExternalContribution).mockReturnValue(null)
      registerHumanCollaborationHandlers(deps)

      const result = handlerFor('human-collaboration:approve-contribution')(
        { sender: { id: 1 } },
        'entry-1'
      )

      expect(result).toBeNull()
      expect(deps.broadcastHumanCollaborationUpdate).not.toHaveBeenCalled()
      expect(deps.republishHumanCollaborationProjection).not.toHaveBeenCalled()
    })

    it('requires a chat id to list, so the cross-chat queue cannot leak', () => {
      // listQueued() with no chat id returns EVERY chat's entries, bodies
      // included. The handler must never make that reachable.
      const { deps } = createDeps()
      registerHumanCollaborationHandlers(deps)

      expect(() =>
        handlerFor('human-collaboration:list-pending-contributions')({ sender: { id: 1 } }, '')
      ).toThrow()
      expect(deps.chatService.listPendingExternalContributions).not.toHaveBeenCalled()
    })
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

  it('reports no connected chat ids without constructing the runtime when none is active', () => {
    const { deps } = createDeps({
      getCurrentHumanCollaborationRuntime: vi.fn(() => null)
    })
    registerHumanCollaborationHandlers(deps)

    expect(handlerFor('human-collaboration:connected-chat-ids')({})).toEqual([])
    expect(deps.getCurrentHumanCollaborationRuntime).toHaveBeenCalledTimes(1)
    expect(deps.getHumanCollaborationRuntime).not.toHaveBeenCalled()
  })

  it('reports no session status without constructing the runtime when none is active', () => {
    const { deps } = createDeps({
      getCurrentHumanCollaborationRuntime: vi.fn(() => null)
    })
    registerHumanCollaborationHandlers(deps)

    expect(handlerFor('human-collaboration:session-status')({})).toEqual([])
    expect(deps.getCurrentHumanCollaborationRuntime).toHaveBeenCalledTimes(1)
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

  it('preserves own-chat host views while filtering global runtime state for a chat popout', async () => {
    const { deps, runtime, baseShare } = createDeps()
    const popoutEvent = { sender: { id: 41 } }
    deps.resolveSenderHumanCollaborationScope = vi.fn(() => ({
      kind: 'chat' as const,
      chatId: 'chat-1'
    }))
    runtime.connectedChatIds.mockReturnValue(['chat-1', 'chat-3'])
    runtime.sessionSummaries.mockReturnValue([
      { chatId: 'chat-1', shareId: 'share-1' },
      { chatId: 'chat-3', shareId: 'share-3' }
    ])
    registerHumanCollaborationHandlers(deps)

    await expect(
      handlerFor('human-collaboration:invite-health')(popoutEvent, 'chat-1')
    ).resolves.toMatchObject({ chatAvailable: true, shareEnabled: true })
    expect(handlerFor('human-collaboration:list-shares')(popoutEvent)).toEqual([baseShare])
    expect(deps.chatService.listHumanCollaborationShares).toHaveBeenLastCalledWith('chat-1')
    expect(handlerFor('human-collaboration:connected-chat-ids')(popoutEvent)).toEqual([
      'chat-1'
    ])
    expect(handlerFor('human-collaboration:session-status')(popoutEvent)).toEqual([
      { chatId: 'chat-1', shareId: 'share-1' }
    ])
    expect(
      handlerFor('human-collaboration:update-share-rules')(popoutEvent, {
        shareId: 'share-1',
        preset: 'autoDraft'
      })
    ).toEqual(baseShare)
    expect(deps.chatService.updateHumanCollaborationShareRules).toHaveBeenCalledWith({
      shareId: 'share-1',
      preset: 'autoDraft'
    })
  })

  it('blocks a Test 1 chat popout from Test 3 shares and foreign comment routes', async () => {
    const { deps, baseChat, baseShare } = createDeps()
    const test1Chat = {
      ...baseChat,
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1'
    }
    const test3Chat = chat('chat-3', {
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3'
    })
    const test3Share = share({ shareId: 'share-3', chatId: 'chat-3' })
    vi.mocked(deps.chatService.getChat).mockImplementation((chatId) =>
      chatId === 'chat-1' ? test1Chat : chatId === 'chat-3' ? test3Chat : null
    )
    vi.mocked(deps.humanCollaborationStore.getShare).mockImplementation((shareId) =>
      shareId === 'share-1' ? baseShare : shareId === 'share-3' ? test3Share : null
    )
    deps.resolveSenderHumanCollaborationScope = vi.fn(() => ({
      kind: 'chat' as const,
      chatId: 'chat-1'
    }))
    const popoutEvent = { sender: { id: 41 } }
    registerHumanCollaborationHandlers(deps)

    expect(() =>
      handlerFor('human-collaboration:list-shares')(popoutEvent, 'chat-3')
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.listHumanCollaborationShares).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:audit-log')(popoutEvent, { chatId: 'chat-3' })
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.humanCollaborationAuditLog.list).not.toHaveBeenCalled()

    await expect(
      handlerFor('human-collaboration:create-share')(popoutEvent, {
        chatId: 'chat-3',
        mode: 'comments'
      })
    ).rejects.toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.createHumanCollaborationShare).not.toHaveBeenCalled()
    expect(deps.selectAdvertisableRelayUrls).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:revoke-share')(popoutEvent, 'share-3')
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.revokeHumanCollaborationShare).not.toHaveBeenCalled()

    // Host review. The queue store matches approve/deny on entryId across ONE
    // global array and checks nothing about ownership, so the scope assertion
    // has to come from the resolved ENTRY. `entry-3` belongs to chat-3; a
    // chat-1 popout naming it must be refused before the store is touched.
    expect(() =>
      handlerFor('human-collaboration:approve-contribution')(popoutEvent, 'entry-3')
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.approveExternalContribution).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:deny-contribution')(popoutEvent, { entryId: 'entry-3' })
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.denyExternalContribution).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:list-pending-contributions')(popoutEvent, 'chat-3')
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.listPendingExternalContributions).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:set-host-review')(popoutEvent, {
        shareId: 'share-3',
        requiresHostApproval: true
      })
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.setHumanCollaborationHostReview).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:append-comment')(popoutEvent, {
        shareId: 'share-3',
        chatId: 'chat-3',
        collaboratorId: 'collab-1',
        clientMessageId: 'foreign-client-message',
        content: 'Test 1 must not write into Test 3.'
      })
    ).toThrow('Renderer does not own this collaboration chat.')
    expect(deps.chatService.appendCollaboratorComment).not.toHaveBeenCalled()

    expect(() =>
      handlerFor('human-collaboration:append-comment')(popoutEvent, {
        shareId: 'share-1',
        chatId: 'chat-3',
        collaboratorId: 'collab-1',
        clientMessageId: 'mismatched-share-route',
        content: 'Mismatched persisted share ownership.'
      })
    ).toThrow('Collaboration share does not belong to the requested chat.')
    expect(deps.chatService.appendCollaboratorComment).not.toHaveBeenCalled()
  })

  it('keeps unscoped host runtime and collaborator-client controls main-renderer only', async () => {
    const denied = new Error('main renderer required')
    const { deps, runtime } = createDeps({
      assertMainRendererSender: vi.fn(() => {
        throw denied
      })
    })
    const popoutEvent = { sender: { id: 41 } }
    registerHumanCollaborationHandlers(deps)

    expect(() =>
      handlerFor('human-collaboration-runtime:subscribe-projection')(popoutEvent, {
        sessionId: 'session-1'
      })
    ).toThrow(denied)
    expect(runtime.subscribeProjection).not.toHaveBeenCalled()

    await expect(
      handlerFor('human-collaboration-runtime:confirm-sas')(popoutEvent, {
        handshakeId: 'handshake-1',
        confirmCode: '123456',
        collaboratorTranscriptSigB64: 'signature'
      })
    ).rejects.toThrow(denied)
    expect(runtime.confirmSas).not.toHaveBeenCalled()

    await expect(
      handlerFor('human-collaboration-collaborator:join')(popoutEvent, {
        shareId: 'share-1',
        chatId: 'chat-1',
        inviteToken: 'invite-token',
        displayName: 'Collaborator',
        mode: 'comments',
        relayUrl: 'ws://remote',
        roomId: 'room-1'
      })
    ).rejects.toThrow(denied)
    expect(deps.socketFactory).not.toHaveBeenCalled()

    expect(() => handlerFor('human-collaboration-collaborator:last-session')(popoutEvent)).toThrow(
      denied
    )
    expect(() => handlerFor('human-collaboration-collaborator:leave')(popoutEvent)).toThrow(denied)
  })
})
