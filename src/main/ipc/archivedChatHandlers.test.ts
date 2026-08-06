import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { ChatRecord } from '../store/types'
import { registerArchivedChatHandlers, type ArchivedChatHandlersDeps } from './archivedChatHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

type RegisteredHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'archived-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Archived review',
    workspaceId: 'workspace-1',
    workspacePath: '/tmp/workspace',
    createdAt: 1,
    updatedAt: 2,
    archived: true,
    messages: [
      {
        id: 'message-1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-08-07T10:00:00.000Z'
      }
    ],
    runs: [],
    ...overrides
  }
}

function createDeps(chat = makeChat()): ArchivedChatHandlersDeps {
  const requestingWindow = { id: 1 } as unknown as BrowserWindow
  return {
    chatService: {
      getChat: vi.fn(() => chat),
      saveChat: vi.fn((next) => next)
    },
    getWorkspaces: vi.fn(() => []),
    getRequestingWindow: vi.fn(() => requestingWindow),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/tmp/archived-review' })),
    writeFile: vi.fn(async () => undefined),
    assertSafeChatId: vi.fn((value) => String(value)),
    assertSenderChatScope: vi.fn(),
    homedir: vi.fn(() => '/Users/chris'),
    broadcastChatUpdated: vi.fn(),
    broadcastThreadList: vi.fn()
  }
}

beforeEach(() => {
  mockedHandle.mockReset()
})

describe('registerArchivedChatHandlers', () => {
  it('registers unarchive and export channels', () => {
    registerArchivedChatHandlers(createDeps())

    expect(handlerFor('unarchive-chat')).toBeTypeOf('function')
    expect(handlerFor('export-archived-chat')).toBeTypeOf('function')
  })

  it('unarchives the canonical record and broadcasts the list change', () => {
    const deps = createDeps()
    registerArchivedChatHandlers(deps)

    const result = handlerFor('unarchive-chat')({ sender: {} }, 'archived-1') as {
      ok: boolean
      chat?: ChatRecord
    }

    expect(result.ok).toBe(true)
    expect(result.chat?.archived).toBe(false)
    expect(deps.chatService.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ appChatId: 'archived-1', archived: false })
    )
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ archived: false })
    )
    expect(deps.broadcastThreadList).toHaveBeenCalledOnce()
  })

  it('opens a format-specific save dialog and writes the selected export', async () => {
    const deps = createDeps()
    registerArchivedChatHandlers(deps)

    const result = await handlerFor('export-archived-chat')(
      { sender: {} },
      { chatId: 'archived-1', format: 'markdown' }
    )

    expect(result).toEqual(
      expect.objectContaining({ ok: true, canceled: false, path: '/tmp/archived-review.md' })
    )
    expect(deps.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: 'Archived review.md' })
    )
    expect(deps.writeFile).toHaveBeenCalledWith(
      '/tmp/archived-review.md',
      expect.stringContaining('# Archived review')
    )
  })
})
