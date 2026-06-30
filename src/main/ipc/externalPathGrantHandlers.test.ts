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
      isDirectory: () => true
    })),
    resolvePath: vi.fn((pathValue: string) => `/resolved${pathValue}`),
    providerLabel: vi.fn((provider: ProviderId) => provider.toUpperCase()),
    issueExternalPathGrant: vi.fn((grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>) =>
      createGrant({ ...grant })
    ),
    getChat: vi.fn(() => chat),
    saveChat: vi.fn(),
    broadcastChatUpdated: vi.fn(),
    collectExternalPathGrantsFromMetadata: vi.fn(() => [] as ExternalPathGrant[]),
    canonicalizeExternalPathGrantMetadata: vi.fn((_metadata, nextGrants) => ({
      externalPathGrants: nextGrants
    })),
    isExternalPathGrantDispatchProvider: vi.fn((provider: ProviderId) =>
      ['codex', 'gemini', 'claude', 'kimi'].includes(provider)
    ),
    resolveRegisteredExplicitExternalPath,
    findRegisteredWorkspace: vi.fn(() => undefined),
    canonicalPath: vi.fn((value: string) => `/canonical${value}`),
    optionalString: vi.fn((value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : undefined
    ),
    randomBytes: vi.fn(() => Buffer.from('a1b2c3d4', 'hex')),
    securityScopedBookmarks: process.platform === 'darwin',
    probeExternalPath: vi.fn(async (absolutePath: string) => ({ absolutePath, ok: true }))
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
    expect(handlerFor('probe-external-path')).toBeTypeOf('function')
  })

  it('legacy select returns null on no window or cancelled dialog and falls back provider to codex', async () => {
    const { deps, setMainWindow } = createDeps()
    registerExternalPathGrantHandlers(deps)

    setMainWindow(null)
    await expect(handlerFor('select-external-path-grant')({}, 'read', 'bad')).resolves.toBeNull()

    setMainWindow({ id: 1 } as unknown as BrowserWindow)
    deps.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(handlerFor('select-external-path-grant')({}, 'read', 'bad')).resolves.toBeNull()

    await handlerFor('select-external-path-grant')({}, 'read', 'bad')
    expect(deps.providerLabel).toHaveBeenCalledWith('codex')
    expect(deps.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: 'Select file or folder CODEX can view',
        properties: ['openFile', 'openDirectory', 'createDirectory'],
        securityScopedBookmarks: process.platform === 'darwin'
      })
    )
  })

  it('legacy select preserves stat fallback, read-default access, and issueExternalPathGrant fields', async () => {
    const { deps } = createDeps()
    registerExternalPathGrantHandlers(deps)

    deps.stat.mockRejectedValueOnce(new Error('stat failed'))
    await expect(handlerFor('select-external-path-grant')({}, 'nope' as any, 'gemini')).resolves.toEqual(
      expect.objectContaining({
        provider: 'gemini',
        path: '/resolved/tmp/workspace',
        kind: 'file',
        access: 'read',
        duration: 'thisThread',
        securityScopedBookmark: 'bookmark-1'
      })
    )
    expect(deps.issueExternalPathGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        path: '/resolved/tmp/workspace',
        kind: 'file',
        access: 'read',
        duration: 'thisThread'
      })
    )
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
      handlerFor('external-path:pick-and-persist')({}, {
        chatId: 'chat-1',
        path: '/existing',
        deferPersist: true
      })
    ).resolves.toEqual({
      ok: true,
      grants: [],
      path: '/registered/workspace'
    })
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
        message: 'Issues a read+write grant scoped to this chat. ',
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
      })
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
            createParticipant('grok', 3)
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
    expect(deps.saveChat).toHaveBeenCalledTimes(1)
    expect(deps.broadcastChatUpdated).toHaveBeenCalledTimes(1)
    expect(deps.canonicalizeExternalPathGrantMetadata).toHaveBeenCalled()
  })

  it('probe-external-path delegates directly', async () => {
    const { deps } = createDeps()
    registerExternalPathGrantHandlers(deps)

    await expect(handlerFor('probe-external-path')({}, '/tmp/repo')).resolves.toEqual({
      absolutePath: '/tmp/repo',
      ok: true
    })
    expect(deps.probeExternalPath).toHaveBeenCalledWith('/tmp/repo')
  })
})
