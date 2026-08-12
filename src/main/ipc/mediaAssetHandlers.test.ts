import fs from 'fs'
import os from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import {
  TRANSCRIPT_MEDIA_ASSET_DIR,
  TranscriptMediaAssetStore,
  transcriptMediaAssetPath
} from '../services/TranscriptMediaAssetStore'
import { registerMediaAssetHandlers } from './mediaAssetHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
  currentUserData = fs.mkdtempSync(join(os.tmpdir(), 'tw-media-handler-'))
  roots.push(currentUserData)
  const store = new TranscriptMediaAssetStore(join(currentUserData, TRANSCRIPT_MEDIA_ASSET_DIR))
  expect(
    store.write({ sha256: VALID_SHA, mimeType: 'image/png', buffer: ORIGINAL_BYTES })
  ).toEqual({ ok: true })
})

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown
const VALID_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdef'
const ORIGINAL_BYTES = Buffer.from('original-transcript-image-bytes')
const roots: string[] = []
let currentUserData = ''

function validAssetPath(): string {
  return transcriptMediaAssetPath(
    fs.realpathSync.native(join(currentUserData, TRANSCRIPT_MEDIA_ASSET_DIR)),
    VALID_SHA,
    'image/png'
  )
}

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  let requestingWindow: BrowserWindow | null = { id: 1 } as unknown as BrowserWindow
  const deps = {
    isRecord: (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)),
    getUserDataPath: vi.fn(() => currentUserData),
    statIsFile: vi.fn(() => true),
    authorizeSender: vi.fn(() => true),
    getRequestingWindow: vi.fn(() => requestingWindow),
    showItemInFolder: vi.fn(),
    showSaveDialog: vi.fn(
      async (): Promise<{ canceled: boolean; filePath?: string }> => ({
        canceled: false,
        filePath: '/tmp/export.png'
      })
    ),
    copyFile: vi.fn(async () => undefined),
    copyOpenedAsset: vi.fn(async () => undefined),
    openInStudio: vi.fn(async () => ({ ok: true }))
  }

  return {
    deps,
    setRequestingWindow(next: BrowserWindow | null) {
      requestingWindow = next
    }
  }
}

describe('registerMediaAssetHandlers', () => {
  it('registers media-asset IPC channels', () => {
    registerMediaAssetHandlers(createDeps().deps)

    expect(handlerFor('media-asset:open-in-studio')).toBeTypeOf('function')
    expect(handlerFor('media-asset:reveal')).toBeTypeOf('function')
    expect(handlerFor('media-asset:get-path')).toBeTypeOf('function')
    expect(handlerFor('media-asset:save-as')).toBeTypeOf('function')
    expect(handlerFor('media-asset:copy-image')).toBeTypeOf('function')
  })

  it('opens only an authorized host-owned video in Studio', async () => {
    const { deps } = createDeps()
    const videoSha = 'videoHash_abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGH'
    const store = new TranscriptMediaAssetStore(join(currentUserData, TRANSCRIPT_MEDIA_ASSET_DIR))
    expect(
      store.write({ sha256: videoSha, mimeType: 'video/mp4', buffer: Buffer.from('video') })
    ).toEqual({ ok: true })
    registerMediaAssetHandlers(deps)

    await expect(
      handlerFor('media-asset:open-in-studio')({}, { sha256: videoSha, mimeType: 'video/mp4' })
    ).resolves.toEqual({ ok: true })
    expect(deps.openInStudio).toHaveBeenCalledWith({
      assetId: videoSha,
      path: transcriptMediaAssetPath(
        fs.realpathSync.native(join(currentUserData, TRANSCRIPT_MEDIA_ASSET_DIR)),
        videoSha,
        'video/mp4'
      ),
      mediaKind: 'video'
    })

    await expect(
      handlerFor('media-asset:open-in-studio')({}, { sha256: VALID_SHA, mimeType: 'image/png' })
    ).resolves.toEqual({ ok: false })
    deps.authorizeSender.mockReturnValueOnce(false)
    await expect(
      handlerFor('media-asset:open-in-studio')({}, { sha256: videoSha, mimeType: 'video/mp4' })
    ).resolves.toEqual({ ok: false })
    expect(deps.openInStudio).toHaveBeenCalledTimes(1)
  })

  it('resolver returns null for invalid input, path-jail failures, and missing assets', async () => {
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
    ).resolves.toBe(validAssetPath())

    fs.renameSync(validAssetPath(), `${validAssetPath()}.gone`)
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
    const { deps, setRequestingWindow } = createDeps()
    registerMediaAssetHandlers(deps)

    await expect(handlerFor('media-asset:save-as')({}, null)).resolves.toEqual({
      ok: false,
      canceled: false
    })

    setRequestingWindow(null)
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })

    setRequestingWindow({ id: 1 } as unknown as BrowserWindow)
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
    deps.copyOpenedAsset.mockImplementationOnce(async () => {
      throw new Error('copy failed')
    })
    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })

    deps.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/export.png' })
    deps.copyOpenedAsset.mockResolvedValueOnce(undefined)
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

  it('fails closed before filesystem or shell effects when sender authorization is absent', async () => {
    const { deps } = createDeps()
    deps.authorizeSender.mockReturnValue(false)
    registerMediaAssetHandlers(deps)
    const event = { sender: { id: 99 } }
    const input = { sha256: VALID_SHA, mimeType: 'image/png' }

    await expect(handlerFor('media-asset:get-path')(event, input)).resolves.toBeNull()
    await expect(handlerFor('media-asset:reveal')(event, input)).resolves.toEqual({ ok: false })
    await expect(handlerFor('media-asset:save-as')(event, input)).resolves.toEqual({
      ok: false,
      canceled: false
    })

    expect(deps.authorizeSender).toHaveBeenCalledWith(event, {
      sha256: VALID_SHA,
      mimeType: 'image/png'
    })
    expect(deps.statIsFile).not.toHaveBeenCalled()
    expect(deps.getRequestingWindow).not.toHaveBeenCalled()
    expect(deps.showItemInFolder).not.toHaveBeenCalled()
    expect(deps.showSaveDialog).not.toHaveBeenCalled()
    expect(deps.copyFile).not.toHaveBeenCalled()
    expect(deps.copyOpenedAsset).not.toHaveBeenCalled()
  })

  it('uses the exact requesting BrowserWindow for an authorized save dialog', async () => {
    const { deps, setRequestingWindow } = createDeps()
    const event = { sender: { id: 41 } }
    const window = { id: 41 } as unknown as BrowserWindow
    setRequestingWindow(window)
    registerMediaAssetHandlers(deps)

    await handlerFor('media-asset:save-as')(event, {
      sha256: VALID_SHA,
      mimeType: 'image/png'
    })

    expect(deps.getRequestingWindow).toHaveBeenCalledWith(event)
    expect(deps.showSaveDialog).toHaveBeenCalledWith(window, expect.anything())
  })

  it('fails closed when requesting-window resolution throws', async () => {
    const { deps } = createDeps()
    deps.getRequestingWindow.mockImplementation(() => {
      throw new Error('destroyed sender')
    })
    registerMediaAssetHandlers(deps)

    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })
    expect(deps.showSaveDialog).not.toHaveBeenCalled()
    expect(deps.copyFile).not.toHaveBeenCalled()
  })

  it('reduces POSIX and Windows suggested paths to a safe leaf basename', async () => {
    const { deps } = createDeps()
    registerMediaAssetHandlers(deps)
    const input = { sha256: VALID_SHA, mimeType: 'image/png' }

    await handlerFor('media-asset:save-as')({}, {
      ...input,
      suggestedName: '/private/tmp/export/posix-name.png'
    })
    expect(deps.showSaveDialog).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: 'posix-name.png' })
    )

    await handlerFor('media-asset:save-as')({}, {
      ...input,
      suggestedName: 'C:\\Users\\attacker\\windows-name.png'
    })
    expect(deps.showSaveDialog).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: 'windows-name.png' })
    )

    await handlerFor('media-asset:save-as')({}, { ...input, suggestedName: '..' })
    expect(deps.showSaveDialog).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: `${VALID_SHA}.png` })
    )
  })

  it('exports from the exact opened descriptor when the store path is replaced during the dialog', async () => {
    const { deps } = createDeps()
    const destination = join(currentUserData, 'export.png')
    const assetPath = validAssetPath()
    deps.showSaveDialog.mockImplementationOnce(async () => {
      fs.renameSync(assetPath, `${assetPath}.original`)
      fs.writeFileSync(assetPath, Buffer.alloc(ORIGINAL_BYTES.length, 0x58), { mode: 0o600 })
      return { canceled: false, filePath: destination }
    })
    delete (deps as Partial<typeof deps>).copyOpenedAsset
    registerMediaAssetHandlers(deps)

    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: true, canceled: false })
    expect(fs.readFileSync(destination)).toEqual(ORIGINAL_BYTES)
  })

  it('fails closed without publishing an export when the opened inode changes in place', async () => {
    const { deps } = createDeps()
    const destination = join(currentUserData, 'must-not-exist.png')
    deps.showSaveDialog.mockImplementationOnce(async () => {
      fs.truncateSync(validAssetPath(), 1)
      return { canceled: false, filePath: destination }
    })
    delete (deps as Partial<typeof deps>).copyOpenedAsset
    registerMediaAssetHandlers(deps)

    await expect(
      handlerFor('media-asset:save-as')({}, {
        sha256: VALID_SHA,
        mimeType: 'image/png'
      })
    ).resolves.toEqual({ ok: false, canceled: false })
    expect(fs.existsSync(destination)).toBe(false)
  })

  it('copies large media with a fixed-size buffer instead of loading the asset whole', async () => {
    const { deps } = createDeps()
    const sha256 = 'largeExportHash_abcdefghijklmnopqrstuvwxyz0123456789'
    const body = Buffer.alloc(1024 * 1024 + 17, 0x6a)
    const store = new TranscriptMediaAssetStore(join(currentUserData, TRANSCRIPT_MEDIA_ASSET_DIR))
    expect(store.write({ sha256, mimeType: 'video/mp4', buffer: body })).toEqual({ ok: true })
    const destination = join(currentUserData, 'large-export.mp4')
    deps.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination })
    delete (deps as Partial<typeof deps>).copyOpenedAsset
    const allocSpy = vi.spyOn(Buffer, 'allocUnsafe')
    registerMediaAssetHandlers(deps)

    await expect(
      handlerFor('media-asset:save-as')({}, { sha256, mimeType: 'video/mp4' })
    ).resolves.toEqual({ ok: true, canceled: false })
    expect(allocSpy.mock.calls.some(([size]) => size === 256 * 1024)).toBe(true)
    expect(allocSpy.mock.calls.every(([size]) => size <= 256 * 1024)).toBe(true)
    expect(fs.readFileSync(destination).equals(body)).toBe(true)
  })
})
