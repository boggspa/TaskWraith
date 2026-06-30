import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { ChatRecord, WorkspaceRecord } from '../store/types'
import { registerSidebarHandlers, type SidebarHandlersDeps } from './sidebarHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'ws-1',
    path: '/tmp/workspace',
    displayName: 'Workspace',
    ...overrides
  } as unknown as WorkspaceRecord
}

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'app-chat-1',
    title: 'Chat 1',
    scope: 'workspace',
    workspaceId: 'ws-1',
    archived: false,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  } as unknown as ChatRecord
}

function createDeps() {
  const workspace = makeWorkspace()
  const chat = makeChat()
  const fromWebContents = vi.fn<SidebarHandlersDeps['fromWebContents']>(() => ({
    isDestroyed: () => false
  }))
  const buildChatMarkdownTranscript = vi.fn<SidebarHandlersDeps['buildChatMarkdownTranscript']>(
    () => ({
      markdown: '# Chat',
      messageCount: 1,
      charCount: 100,
      omissions: []
    })
  )
  return {
    fromWebContents,
    getWorkspaces: vi.fn<SidebarHandlersDeps['getWorkspaces']>(() => [workspace]),
    getChat: vi.fn<SidebarHandlersDeps['getChat']>((chatId) =>
      chatId === 'chat-1' ? chat : undefined
    ),
    getSettings: vi.fn<SidebarHandlersDeps['getSettings']>(() => ({
      storeLocalChatHistory: true
    })),
    getChatRecordPath: vi.fn<SidebarHandlersDeps['getChatRecordPath']>(() => '/tmp/chat.json'),
    existsSync: vi.fn<SidebarHandlersDeps['existsSync']>(
      (pathValue) => pathValue !== '/tmp/missing.json'
    ),
    showItemInFolder: vi.fn<SidebarHandlersDeps['showItemInFolder']>(),
    writeClipboardText: vi.fn<SidebarHandlersDeps['writeClipboardText']>(),
    buildChatMarkdownTranscript,
    estimateChatMarkdownTranscriptChars:
      vi.fn<SidebarHandlersDeps['estimateChatMarkdownTranscriptChars']>(() => 100),
    assertSafeChatId: vi.fn<SidebarHandlersDeps['assertSafeChatId']>((chatId) => String(chatId)),
    homedir: vi.fn<SidebarHandlersDeps['homedir']>(() => '/Users/test')
  } satisfies SidebarHandlersDeps
}

describe('registerSidebarHandlers', () => {
  it('registers sidebar and transcript IPC channels', () => {
    registerSidebarHandlers(createDeps())

    expect(handlerFor('sidebar:show-workspace-in-finder')).toBeTypeOf('function')
    expect(handlerFor('sidebar:copy-workspace-directory')).toBeTypeOf('function')
    expect(handlerFor('sidebar:show-chat-workspace-in-finder')).toBeTypeOf('function')
    expect(handlerFor('sidebar:copy-chat-working-directory')).toBeTypeOf('function')
    expect(handlerFor('sidebar:copy-chat-transcript-path')).toBeTypeOf('function')
    expect(handlerFor('copy-chat-markdown-transcript')).toBeTypeOf('function')
  })

  it('rejects unauthorized sidebar actions', () => {
    const deps = createDeps()
    deps.fromWebContents.mockReturnValue(null)
    registerSidebarHandlers(deps)

    expect(handlerFor('sidebar:show-workspace-in-finder')({ sender: {} }, 'ws-1')).toEqual({
      ok: false,
      reason: 'unauthorized'
    })
  })

  it('reveals and copies workspace paths through the injected shell and clipboard', () => {
    const deps = createDeps()
    registerSidebarHandlers(deps)

    expect(handlerFor('sidebar:show-workspace-in-finder')({ sender: {} }, 'ws-1')).toEqual({
      ok: true,
      path: '/tmp/workspace'
    })
    expect(deps.showItemInFolder).toHaveBeenCalledWith('/tmp/workspace')

    expect(handlerFor('sidebar:copy-workspace-directory')({ sender: {} }, 'ws-1')).toEqual({
      ok: true,
      path: '/tmp/workspace'
    })
    expect(deps.writeClipboardText).toHaveBeenCalledWith('/tmp/workspace', 'clipboard')
  })

  it('returns no-workspace for global chats when resolving sidebar workspace actions', () => {
    const deps = createDeps()
    deps.getChat.mockReturnValue(
      makeChat({ scope: 'global', workspaceId: undefined, workspacePath: undefined })
    )
    registerSidebarHandlers(deps)

    expect(handlerFor('sidebar:show-chat-workspace-in-finder')({ sender: {} }, 'chat-1')).toEqual({
      ok: false,
      reason: 'no-workspace'
    })
  })

  it('handles local-history-disabled and missing transcript files', () => {
    const deps = createDeps()
    registerSidebarHandlers(deps)

    deps.getSettings.mockReturnValue({ storeLocalChatHistory: false })
    expect(handlerFor('sidebar:copy-chat-transcript-path')({ sender: {} }, 'chat-1')).toEqual({
      ok: false,
      reason: 'local-history-disabled'
    })

    deps.getSettings.mockReturnValue({ storeLocalChatHistory: true })
    deps.getChatRecordPath.mockReturnValue('/tmp/missing.json')
    expect(handlerFor('sidebar:copy-chat-transcript-path')({ sender: {} }, 'chat-1')).toEqual({
      ok: false,
      reason: 'missing'
    })
  })

  it('copies chat transcript paths when local history is enabled and the file exists', () => {
    const deps = createDeps()
    registerSidebarHandlers(deps)

    expect(handlerFor('sidebar:copy-chat-transcript-path')({ sender: {} }, 'chat-1')).toEqual({
      ok: true,
      path: '/tmp/chat.json'
    })
    expect(deps.writeClipboardText).toHaveBeenCalledWith('/tmp/chat.json', 'clipboard')
  })

  it('returns too-large before markdown export when the estimate exceeds the clipboard limit', async () => {
    const deps = createDeps()
    deps.estimateChatMarkdownTranscriptChars.mockReturnValue(2_000_001)
    registerSidebarHandlers(deps)

    await expect(
      handlerFor('copy-chat-markdown-transcript')({ sender: {} }, 'chat-1')
    ).resolves.toEqual({
      ok: false,
      reason: 'too-large',
      messageCount: 1,
      charCount: 2_000_001,
      omissions: ['transcript too large for clipboard copy']
    })
    expect(deps.buildChatMarkdownTranscript).not.toHaveBeenCalled()
  })

  it('copies markdown transcripts and threads workspace/homeDir into the export helper', async () => {
    const deps = createDeps()
    registerSidebarHandlers(deps)

    await expect(
      handlerFor('copy-chat-markdown-transcript')({ sender: {} }, 'chat-1')
    ).resolves.toEqual({
      ok: true,
      messageCount: 1,
      charCount: 100,
      omissions: []
    })
    expect(deps.buildChatMarkdownTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'chat-1' }),
      {
        workspace: expect.objectContaining({ id: 'ws-1' }),
        homeDir: '/Users/test'
      }
    )
    expect(deps.writeClipboardText).toHaveBeenCalledWith('# Chat', 'clipboard')
  })

  it('returns too-large after export when markdown output crosses the clipboard limit', async () => {
    const deps = createDeps()
    deps.buildChatMarkdownTranscript.mockReturnValue({
      markdown: '# Chat',
      messageCount: 2,
      charCount: 2_000_100,
      omissions: ['omitted attachment metadata']
    })
    registerSidebarHandlers(deps)

    await expect(
      handlerFor('copy-chat-markdown-transcript')({ sender: {} }, 'chat-1')
    ).resolves.toEqual({
      ok: false,
      reason: 'too-large',
      messageCount: 2,
      charCount: 2_000_100,
      omissions: ['omitted attachment metadata']
    })
  })
})
