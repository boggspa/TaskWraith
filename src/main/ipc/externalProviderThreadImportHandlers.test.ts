import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { ChatRecord } from '../store/types'
import {
  registerExternalProviderThreadImportHandlers,
  type ExternalProviderThreadImportHandlersDeps
} from './externalProviderThreadImportHandlers'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const mockedHandle = vi.mocked(ipcMain.handle)
type Handler = (event: { sender: unknown }, input: unknown) => Promise<unknown>

function handler(): Handler {
  const registered = mockedHandle.mock.calls.find(
    ([channel]) => channel === 'import-external-provider-thread'
  )?.[1] as Handler | undefined
  if (!registered) throw new Error('handler not registered')
  return registered
}

function importedChat(): ChatRecord {
  return {
    appChatId: 'imported-chat',
    scope: 'global',
    chatKind: 'single',
    provider: 'codex',
    title: 'Imported Codex',
    createdAt: 1,
    updatedAt: 1,
    archived: true,
    messages: [],
    runs: [],
    externalProviderThreadImport: {
      schemaVersion: 1,
      provider: 'codex',
      trust: 'external_untrusted',
      sourceFileName: 'thread.jsonl',
      sourceFingerprintSha256: 'a'.repeat(64),
      sourceMessageCount: 2,
      importedMessageCount: 2,
      omittedRecordCount: 0,
      invalidRecordCount: 0,
      importedAt: '2026-08-20T00:00:00.000Z',
      truncated: false,
      promptBridgeEnabled: false,
      nativeResumeAllowed: false
    }
  }
}

function deps(): ExternalProviderThreadImportHandlersDeps {
  return {
    importer: {
      importFile: vi.fn(async () => ({
        chat: importedChat(),
        duplicate: false,
        truncated: false,
        importedMessageCount: 2,
        sourceMessageCount: 2
      }))
    },
    getRequestingWindow: vi.fn(() => ({ id: 1 }) as unknown as BrowserWindow),
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ['/Users/test/.codex/sessions/thread.jsonl']
    })),
    assertMainRendererSender: vi.fn(),
    broadcastThreadList: vi.fn()
  }
}

beforeEach(() => mockedHandle.mockReset())

describe('external provider thread import handlers', () => {
  it('opens one file only after an explicit provider choice and broadcasts the import', async () => {
    const harness = deps()
    registerExternalProviderThreadImportHandlers(harness)
    const event = { sender: {} }
    const result = await handler()(event, { provider: 'codex' })

    expect(harness.assertMainRendererSender).toHaveBeenCalledWith(event)
    expect(harness.assertMainRendererSender).toHaveBeenCalledTimes(2)
    expect(harness.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ properties: ['openFile'] })
    )
    expect(harness.importer.importFile).toHaveBeenCalledWith({
      provider: 'codex',
      filePath: '/Users/test/.codex/sessions/thread.jsonl'
    })
    expect(result).toMatchObject({ ok: true, canceled: false, chat: { archived: true } })
    expect(harness.broadcastThreadList).toHaveBeenCalledOnce()
  })

  it('rejects an unsupported provider before opening the picker', async () => {
    const harness = deps()
    registerExternalProviderThreadImportHandlers(harness)
    await expect(handler()({ sender: {} }, { provider: 'gemini' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid-provider'
    })
    expect(harness.showOpenDialog).not.toHaveBeenCalled()
  })

  it('returns a cancellation without reading any file', async () => {
    const harness = deps()
    vi.mocked(harness.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    registerExternalProviderThreadImportHandlers(harness)
    await expect(handler()({ sender: {} }, { provider: 'claude' })).resolves.toEqual({
      ok: true,
      canceled: true
    })
    expect(harness.importer.importFile).not.toHaveBeenCalled()
  })
})
