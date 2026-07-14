import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type {
  ChatRecord,
  EnsembleParticipant,
  ExternalPathGrant,
  ProviderId,
  WorkspaceRecord
} from '../store/types'
import {
  registerExternalPathGrantHandlers,
  type ExternalPathGrantHandlersDeps
} from './externalPathGrantHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
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

function createGrant(overrides: Partial<ExternalPathGrant> = {}): ExternalPathGrant {
  return {
    id: 'grant-1',
    provider: 'codex',
    path: '/tmp/workspace',
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    createdAt: '2026-06-30T12:00:00.000Z',
    issuedBy: 'main',
    signature: 'sig',
    ...overrides
  } as ExternalPathGrant
}

function createChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    chatKind: 'single',
    provider: 'codex',
    ensemble: undefined,
    providerMetadata: {},
    updatedAt: 1,
    ...overrides
  } as unknown as ChatRecord
}

function createParticipant(provider: ProviderId, order: number, enabled = true): EnsembleParticipant {
  return {
    id: `${provider}-${order}`,
    provider,
    enabled,
    role: 'worker',
    instructions: '',
    order
  }
}

function createDeps() {
  let mainWindow: BrowserWindow | null = { id: 1 } as unknown as BrowserWindow
  let chat: ChatRecord | null = createChat()
  const showOpenDialog = vi.fn<ExternalPathGrantHandlersDeps['showOpenDialog']>(async () => ({
    canceled: false,
    filePaths: ['/tmp/workspace'],
    bookmarks: ['bookmark-1']
  }))
  const resolveRegisteredExplicitExternalPath =
    vi.fn<ExternalPathGrantHandlersDeps['resolveRegisteredExplicitExternalPath']>(() => ({
      path: '/registered/workspace',
      workspace: { id: 'ws-1', path: '/registered/workspace' } as WorkspaceRecord
    }))
  const deps = {
    getMainWindow: vi.fn(() => mainWindow),
    showOpenDialog,
    stat: vi.fn(async () => ({
      isDirectory: () => true,
      dev: 10,
      ino: 20
    })),
    realpath: vi.fn(async (pathValue: string) => pathValue),
    resolvePath: vi.fn((pathValue: string) => `/resolved${pathValue}`),
    providerLabel: vi.fn((provider: ProviderId) => provider.toUpperCase()),
    issueExternalPathGrant: vi.fn((grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>) =>
      createGrant({ ...grant })
    ),
    getChat: vi.fn(() => chat),
    saveChat: vi.fn(),
    broadcastChatUpdated: vi.fn(),
    collectExternalPathGrantsFromMetadata:
      vi.fn<ExternalPathGrantHandlersDeps['collectExternalPathGrantsFromMetadata']>(() => []),
    canonicalizeExternalPathGrantMetadata: vi.fn((_metadata, nextGrants) => ({
      externalPathGrants: nextGrants
    })),
    isExternalPathGrantDispatchProvider: vi.fn((provider: ProviderId | string) =>
      ['codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'].includes(provider)
    ),
    resolveRegisteredExplicitExternalPath,
    findRegisteredWorkspace: vi.fn(() => undefined),
    canonicalPath: vi.fn((value: string) => `/canonical${value}`),
    optionalString: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined
    ),
    randomBytes: vi.fn(() => Buffer.from('a1b2c3d4', 'hex')),
    securityScopedBookmarks: process.platform === 'darwin',
    probeExternalPath: vi.fn(async (absolutePath: string) => ({ absolutePath, ok: true })),
    assertSenderScope: vi.fn(),
    assertSenderCanProbeExternalPath: vi.fn()
  } satisfies ExternalPathGrantHandlersDeps

  return {
    deps,
    setMainWindow(next: BrowserWindow | null) {
      mainWindow = next
    },
    setChat(next: ChatRecord | null) {
      chat = next
    }
  }
}

describe('registerExternalPathGrantHandlers', () => {
  it('registers external path IPC channels', () => {
    registerExternalPathGrantHandlers(createDeps().deps)

    expect(handlerFor('select-external-path-grant')).toBeTypeOf('function')
    expect(handlerFor('external-path:pick-and-persist')).toBeTypeOf('function')
    expect(handlerFor('external-path:revoke')).toBeTypeOf('function')
    expect(handlerFor('probe-external-path')).toBeTypeOf('function')
  })

  it('legacy select is fail-closed because it has no chat binding', async () => {
    const { deps, setMainWindow } = createDeps()
    registerExternalPathGrantHandlers(deps)

    setMainWindow(null)
    await expect(handlerFor('select-external-path-grant')({}, 'read', 'bad')).resolves.toBeNull()

    setMainWindow({ id: 1 } as unknown as BrowserWindow)
    await expect(handlerFor('select-external-path-grant')({}, 'read')).resolves.toBeNull()
    await expect(
      handlerFor('select-external-path-grant')({}, 'write', 'ollama')
    ).resolves.toBeNull()
    expect(deps.showOpenDialog).not.toHaveBeenCalled()
    expect(deps.issueExternalPathGrant).not.toHaveBeenCalled()
  })

  it('pick-and-persist preserves no-window/no-chat/no-provider/cancelled and deferPersist branches', async () => {
    const { deps, setMainWindow, setChat } = createDeps()
    registerExternalPathGrantHandlers(deps)

    setMainWindow(null)
    await expect(handlerFor('external-path:pick-and-persist')({}, {})).resolves.toEqual({
      ok: false,
      reason: 'no-window'
    })

    setMainWindow({ id: 1 } as unknown as BrowserWindow)
    await expect(handlerFor('external-path:pick-and-persist')({}, {})).resolves.toEqual({
      ok: false,
      reason: 'no-chat'
    })

    setChat(createChat({ provider: undefined }))
    await expect(
      handlerFor('external-path:pick-and-persist')({}, { chatId: 'chat-1' })
    ).resolves.toEqual({
      ok: false,
      reason: 'no-provider'
    })

    setChat(createChat())
    deps.resolveRegisteredExplicitExternalPath.mockReturnValueOnce(null)
    await expect(
      handlerFor('external-path:pick-and-persist')({}, { chatId: 'chat-1', path: '/bad' })
    ).resolves.toEqual({
      ok: false,
      reason: 'cancelled'
    })

    deps.stat.mockRejectedValueOnce(new Error('missing'))
    await expect(
      handlerFor('external-path:pick-and-persist')({}, { chatId: 'chat-1', path: '/existing' })
    ).resolves.toEqual({
      ok: false,
      reason: 'cancelled'
    })

    await expect(
      handlerFor('external-path:pick-and-persist')({ sender: { id: 1 } }, {
        chatId: 'chat-1',
        path: '/existing',
        deferPersist: true
      })
    ).resolves.toEqual({
      ok: true,
      grants: [],
      path: '/registered/workspace',
      selectionReceipt: expect.stringMatching(/^selection-/)
    })
  })

  it('confirms an unregistered native selection only with its one-time sender-bound receipt', async () => {
    const { deps } = createDeps()
    const ownerEvent = { sender: { id: 71 } }
    registerExternalPathGrantHandlers(deps)

    const selected = (await handlerFor('external-path:pick-and-persist')(ownerEvent, {
      chatId: 'chat-1',
      access: 'write',
      deferPersist: true
    })) as {
      ok: true
      path: string
      selectionReceipt: string
    }
    expect(selected).toMatchObject({
      ok: true,
      path: '/resolved/tmp/workspace',
      selectionReceipt: expect.stringMatching(/^selection-/)
    })

    deps.resolveRegisteredExplicitExternalPath.mockReturnValue(null)
    await expect(
      handlerFor('external-path:pick-and-persist')(ownerEvent, {
        chatId: 'chat-1',
        access: 'write',
        path: selected.path,
        selectionReceipt: selected.selectionReceipt
      })
    ).resolves.toMatchObject({ ok: true, path: selected.path })
    expect(deps.issueExternalPathGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        path: selected.path,
        access: 'write',
        kind: 'directory',
        securityScopedBookmark: 'bookmark-1'
      }),
      { canonicalPath: selected.path }
    )

    await expect(
      handlerFor('external-path:pick-and-persist')(ownerEvent, {
        chatId: 'chat-1',
        access: 'write',
        path: selected.path,
        selectionReceipt: selected.selectionReceipt
      })
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('consumes a deferred selection receipt when another renderer tries to use it', async () => {
    const { deps } = createDeps()
    const ownerEvent = { sender: { id: 81 } }
    registerExternalPathGrantHandlers(deps)
    const selected = (await handlerFor('external-path:pick-and-persist')(ownerEvent, {
      chatId: 'chat-1',
      deferPersist: true
    })) as { path: string; selectionReceipt: string }
    deps.resolveRegisteredExplicitExternalPath.mockReturnValue(null)

    await expect(
      handlerFor('external-path:pick-and-persist')(
        { sender: { id: 82 } },
        {
          chatId: 'chat-1',
          path: selected.path,
          selectionReceipt: selected.selectionReceipt
        }
      )
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    await expect(
      handlerFor('external-path:pick-and-persist')(ownerEvent, {
        chatId: 'chat-1',
        path: selected.path,
        selectionReceipt: selected.selectionReceipt
      })
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(deps.saveChat).not.toHaveBeenCalled()
  })

  it('rejects a deferred selection when its canonical target changes before confirmation', async () => {
    const { deps } = createDeps()
    const ownerEvent = { sender: { id: 91 } }
    registerExternalPathGrantHandlers(deps)
    const selected = (await handlerFor('external-path:pick-and-persist')(ownerEvent, {
      chatId: 'chat-1',
      deferPersist: true
    })) as { path: string; selectionReceipt: string }
    deps.resolveRegisteredExplicitExternalPath.mockReturnValue(null)
    deps.realpath.mockResolvedValueOnce('/retargeted/workspace')

    await expect(
      handlerFor('external-path:pick-and-persist')(ownerEvent, {
        chatId: 'chat-1',
        path: selected.path,
        selectionReceipt: selected.selectionReceipt
      })
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(deps.issueExternalPathGrant).not.toHaveBeenCalled()
    expect(deps.saveChat).not.toHaveBeenCalled()
  })

  it('pick-and-persist preserves dialog title, message, bookmark, and cancellation behavior', async () => {
    const { deps } = createDeps()
    registerExternalPathGrantHandlers(deps)

    deps.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(
      handlerFor('external-path:pick-and-persist')({}, { chatId: 'chat-1' })
    ).resolves.toEqual({
      ok: false,
      reason: 'cancelled'
    })

    deps.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/dialog/path'],
      bookmarks: ['dialog-bookmark']
    })
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(67890)
    await expect(
      handlerFor('external-path:pick-and-persist')({}, {
        chatId: 'chat-1',
        access: 'write'
      })
    ).resolves.toEqual({
      ok: true,
      grants: expect.any(Array),
      path: '/resolved/dialog/path'
    })
    dateNowSpy.mockRestore()

    expect(deps.showOpenDialog).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Select folder agents in this chat can edit',
        message: 'Issues a read+write grant scoped to this chat.',
        properties: ['openFile', 'openDirectory', 'createDirectory'],
        securityScopedBookmarks: process.platform === 'darwin'
      })
    )
    expect(deps.issueExternalPathGrant).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'proactive-67890-codex-a1b2c3d4',
        path: '/resolved/dialog/path',
        access: 'write',
        securityScopedBookmark: 'dialog-bookmark'
      }),
      { canonicalPath: '/resolved/dialog/path' }
    )
  })

  it('pick-and-persist preserves provider dedupe/order, proactive ids, metadata canonicalization, save, and broadcast', async () => {
    const { deps, setChat } = createDeps()
    registerExternalPathGrantHandlers(deps)

    setChat(
      createChat({
        chatKind: 'ensemble',
        ensemble: {
          enabled: true,
          maxParticipants: 4,
          participants: [
            createParticipant('claude', 0),
            createParticipant('codex', 1),
            createParticipant('claude', 2),
            createParticipant('grok', 3),
            createParticipant('ollama', 4)
          ]
        }
      })
    )

    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(12345)
    await expect(
      handlerFor('external-path:pick-and-persist')({}, {
        chatId: 'chat-1',
        access: 'write',
        path: '/existing'
      })
    ).resolves.toEqual({
      ok: true,
      grants: expect.any(Array),
      path: '/registered/workspace'
    })
    dateNowSpy.mockRestore()

    expect(deps.issueExternalPathGrant).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'proactive-12345-claude-a1b2c3d4',
        provider: 'claude',
        access: 'write',
        path: '/registered/workspace',
        workspaceId: 'ws-1',
        chatId: 'chat-1'
      })
    )
    expect(deps.issueExternalPathGrant).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'proactive-12345-codex-a1b2c3d4',
        provider: 'codex'
      })
    )
    expect(deps.issueExternalPathGrant).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        id: 'proactive-12345-grok-a1b2c3d4',
        provider: 'grok'
      })
    )
    expect(deps.issueExternalPathGrant).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        id: 'proactive-12345-ollama-a1b2c3d4',
        provider: 'ollama'
      })
    )
    expect(deps.saveChat).toHaveBeenCalledTimes(1)
    expect(deps.broadcastChatUpdated).toHaveBeenCalledTimes(1)
    expect(deps.canonicalizeExternalPathGrantMetadata).toHaveBeenCalled()
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        capability: 'external-grant',
        chatId: 'chat-1',
        workspacePath: '/registered/workspace'
      })
    )
  })

  it('does not let a chat popout attach another registered workspace', async () => {
    const { deps } = createDeps()
    const popoutEvent = { sender: { id: 99 } }
    deps.assertSenderScope.mockImplementation((event, input) => {
      if (
        (event as typeof popoutEvent).sender.id === popoutEvent.sender.id &&
        input.workspacePath === '/registered/workspace'
      ) {
        throw new Error('Renderer workspace ownership does not match this request.')
      }
    })
    registerExternalPathGrantHandlers(deps)

    await expect(
      handlerFor('external-path:pick-and-persist')(popoutEvent, {
        chatId: 'chat-1',
        access: 'write',
        path: '/registered/workspace'
      })
    ).rejects.toThrow('Renderer workspace ownership does not match this request.')
    expect(deps.issueExternalPathGrant).not.toHaveBeenCalled()
    expect(deps.saveChat).not.toHaveBeenCalled()
  })

  it('merges into the fresh canonical chat after the picker yields without restoring revoked grants', async () => {
    const { deps, setChat } = createDeps()
    const revoked = createGrant({ id: 'revoked', chatId: 'chat-1', path: '/revoked' })
    const initial = createChat({
      scope: 'workspace',
      workspaceId: 'ws-1',
      workspacePath: '/workspace',
      providerMetadata: { externalPathGrants: [revoked] }
    })
    const fresh = createChat({
      scope: 'workspace',
      workspaceId: 'ws-1',
      workspacePath: '/workspace',
      title: 'Fresh after revoke',
      providerMetadata: { externalPathGrants: [] }
    })
    setChat(initial)
    deps.collectExternalPathGrantsFromMetadata.mockImplementation((metadata) =>
      Array.isArray(metadata?.externalPathGrants)
        ? (metadata.externalPathGrants as ExternalPathGrant[])
        : []
    )
    deps.showOpenDialog.mockImplementationOnce(async () => {
      setChat(fresh)
      return { canceled: false, filePaths: ['/dialog/path'] }
    })
    registerExternalPathGrantHandlers(deps)

    await expect(
      handlerFor('external-path:pick-and-persist')({}, { chatId: 'chat-1' })
    ).resolves.toMatchObject({ ok: true })

    expect(deps.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Fresh after revoke',
        providerMetadata: {
          externalPathGrants: [expect.objectContaining({ id: expect.stringMatching(/^proactive-/) })]
        }
      })
    )
    expect(deps.saveChat.mock.calls[0][0].providerMetadata?.externalPathGrants).not.toContainEqual(
      expect.objectContaining({ id: 'revoked' })
    )
  })

  it('fails closed when the chat workspace or provider set changes while the picker is open', async () => {
    const { deps, setChat } = createDeps()
    setChat(
      createChat({
        scope: 'workspace',
        workspaceId: 'ws-1',
        workspacePath: '/workspace-1'
      })
    )
    deps.showOpenDialog.mockImplementationOnce(async () => {
      setChat(
        createChat({
          scope: 'workspace',
          workspaceId: 'ws-2',
          workspacePath: '/workspace-2'
        })
      )
      return { canceled: false, filePaths: ['/dialog/path'] }
    })
    registerExternalPathGrantHandlers(deps)

    await expect(
      handlerFor('external-path:pick-and-persist')({}, { chatId: 'chat-1' })
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(deps.issueExternalPathGrant).not.toHaveBeenCalled()
    expect(deps.saveChat).not.toHaveBeenCalled()
  })

  it('revokes only exact ids from the chat canonical grant set', async () => {
    const { deps, setChat } = createDeps()
    const first = createGrant({ id: 'grant-1', chatId: 'chat-1', path: '/first' })
    const second = createGrant({ id: 'grant-2', chatId: 'chat-1', path: '/second' })
    const chat = createChat({
      providerMetadata: {
        preserved: true,
        externalPathGrants: [first, second]
      }
    })
    setChat(chat)
    deps.collectExternalPathGrantsFromMetadata.mockReturnValue([first, second])
    registerExternalPathGrantHandlers(deps)

    await expect(
      handlerFor('external-path:revoke')({}, {
        chatId: 'chat-1',
        grantIds: ['grant-1', 'unknown', 'grant-1']
      })
    ).resolves.toEqual({
      ok: true,
      grants: [second],
      revokedGrantIds: ['grant-1']
    })

    expect(deps.canonicalizeExternalPathGrantMetadata).toHaveBeenCalledWith(
      chat.providerMetadata,
      [second]
    )
    expect(deps.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        appChatId: 'chat-1',
        providerMetadata: { externalPathGrants: [second] }
      })
    )
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(
      deps.saveChat.mock.calls[0][0]
    )
  })

  it('fails closed for missing scope and does not persist stale or empty revocations', async () => {
    const { deps, setChat } = createDeps()
    const canonical = createGrant({ id: 'canonical', chatId: 'chat-1' })
    deps.collectExternalPathGrantsFromMetadata.mockReturnValue([canonical])
    registerExternalPathGrantHandlers(deps)

    await expect(handlerFor('external-path:revoke')({}, { grantIds: ['canonical'] })).resolves.toEqual(
      { ok: false, reason: 'no-chat' }
    )
    await expect(
      handlerFor('external-path:revoke')({}, { chatId: '../settings', grantIds: ['canonical'] })
    ).rejects.toThrow(/safe chat id/i)
    await expect(
      handlerFor('external-path:revoke')({}, { chatId: 'chat-1', grantIds: [] })
    ).resolves.toEqual({ ok: false, reason: 'no-grants' })
    await expect(
      handlerFor('external-path:revoke')({}, { chatId: 'chat-1', grantIds: ['stale'] })
    ).resolves.toEqual({ ok: true, grants: [canonical], revokedGrantIds: [] })
    expect(deps.saveChat).not.toHaveBeenCalled()
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()

    setChat(null)
    await expect(
      handlerFor('external-path:revoke')({}, { chatId: 'chat-1', grantIds: ['canonical'] })
    ).resolves.toEqual({ ok: false, reason: 'no-chat' })
  })

  it('probe-external-path is main-renderer gated before probing', async () => {
    const { deps } = createDeps()
    const event = { sender: { id: 1 } }
    registerExternalPathGrantHandlers(deps)

    await expect(handlerFor('probe-external-path')(event, '/tmp/repo')).resolves.toEqual({
      absolutePath: '/tmp/repo',
      ok: true
    })
    expect(deps.assertSenderCanProbeExternalPath).toHaveBeenCalledWith(event)
    expect(deps.probeExternalPath).toHaveBeenCalledWith('/tmp/repo')

    deps.assertSenderCanProbeExternalPath.mockImplementationOnce(() => {
      throw new Error('Only the main renderer can probe external paths.')
    })
    await expect(
      handlerFor('probe-external-path')({ sender: { id: 99 } }, '/private/secret')
    ).rejects.toThrow('Only the main renderer can probe external paths.')
    expect(deps.probeExternalPath).not.toHaveBeenCalledWith('/private/secret')
  })
})
