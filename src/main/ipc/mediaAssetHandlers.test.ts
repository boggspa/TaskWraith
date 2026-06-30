import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { registerMediaAssetHandlers } from './mediaAssetHandlers'

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
const VALID_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdef'
const VALID_ASSET_PATH = `/tmp/user-data/transcript-media/ab/${VALID_SHA}.png`

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  let mainWindow: BrowserWindow | null = { id: 1 } as unknown as BrowserWindow
  const deps = {
    isRecord: (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    getUserDataPath: vi.fn(() => '/tmp/user-data'),
    statIsFile: vi.fn((assetPath: string) => assetPath === VALID_ASSET_PATH),
    getMainWindow: vi.fn(() => mainWindow),
    showItemInFolder: vi.fn(),
    showSaveDialog: vi.fn(
      async (): Promise<{ canceled: boolean; filePath?: string }> => ({
        canceled: false,
        filePath: '/tmp/export.png'
      })
    ),
    copyFile: vi.fn(async () => undefined)
  }

  return {
    deps,
    setMainWindow(next: BrowserWindow | null) {
      mainWindow = next
    }
  }
}

describe('registerMediaAssetHandlers', () => {
  it('registers media-asset IPC channels', () => {
    registerMediaAssetHandlers(createDeps().deps)

    expect(handlerFor('media-asset:reveal')).toBeTypeOf('function')
    expect(handlerFor('media-asset:get-path')).toBeTypeOf('function')
    expect(handlerFor('media-asset:save-as')).toBeTypeOf('function')
  })

  it('resolver returns null for invalid input, path-jail failures, and non-file stats', async () => {
    const { deps } = createDeps()
    registerMediaAssetHandlers(deps)

    await expect(handlerFor('media-asset:get-path')({}, null)).resolves.toBeNull()
    await expect(
      handlerFor('media-asset:get-path')({}, { sha256: '', mimeType: 'image/png' })
    ).resolves.toBeNull()
    await expect(
      handlerFor('media-asset:get-path')({}, { sha256: '../../etc/passwd', mimeType: 'image/png' })
    ).resolves.toBeNull()

    await expect(
      handlerFor('media-asset:get-path')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toBe(VALID_ASSET_PATH)

    deps.statIsFile.mockImplementationOnce(() => {
      throw new Error('stat failed')
    })
    await expect(
      handlerFor('media-asset:get-path')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toBeNull()

    deps.statIsFile.mockReturnValue(false)
    await expect(
      handlerFor('media-asset:get-path')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toBeNull()
  })

  it('reveal returns false on invalid path or shell failure and true on success', async () => {
    const { deps } = createDeps()
    registerMediaAssetHandlers(deps)

    await expect(handlerFor('media-asset:reveal')({}, null)).resolves.toEqual({ ok: false })

    deps.showItemInFolder.mockImplementation(() => {
      throw new Error('finder failed')
    })
    await expect(
      handlerFor('media-asset:reveal')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false })

    deps.showItemInFolder.mockImplementation(() => undefined)
    await expect(
      handlerFor('media-asset:reveal')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: true })
  })

  it('save-as preserves invalid/no-window, cancel, dialog-failure, copy-failure, and success shapes', async () => {
    const { deps, setMainWindow } = createDeps()
    registerMediaAssetHandlers(deps)

    await expect(handlerFor('media-asset:save-as')({}, null)).resolves.toEqual({
      ok: false,
      canceled: false
    })

    setMainWindow(null)
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })

    setMainWindow({ id: 1 } as unknown as BrowserWindow)
    deps.showSaveDialog.mockResolvedValueOnce({ canceled: true })
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: true })

    deps.showSaveDialog.mockImplementationOnce(async () => {
      throw new Error('dialog failed')
    })
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })

    deps.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/export.png' })
    deps.copyFile.mockImplementationOnce(async () => {
      throw new Error('copy failed')
    })
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })

    deps.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/export.png' })
    deps.copyFile.mockResolvedValueOnce(undefined)
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: true, canceled: false })
  })

  it('save-as preserves suggestedName fallback to basename(assetPath)', async () => {
    const { deps } = createDeps()
    registerMediaAssetHandlers(deps)

    await handlerFor('media-asset:save-as')({}, {
      sha256: VALID_SHA,
      mimeType: 'image/png',
      suggestedName: '  custom-name.png  '
    })
    expect(deps.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: 'custom-name.png' })
    )

    deps.showSaveDialog.mockClear()
    await handlerFor('media-asset:save-as')({}, {
      sha256: VALID_SHA,
      mimeType: 'image/png'
    })
    expect(deps.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: `${VALID_SHA}.png` })
    )
  })
})
