import { execFile, type ChildProcess } from 'child_process'
import { clipboard, dialog, nativeImage } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron'
import { promises as fsPromises } from 'fs'
import type { Stats } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveClipboardImageFromTrustedPaste } from '../ClipboardImagePasteHandler'
import {
  isPdfAttachmentPath,
  renderPdfAttachmentPages
} from '../services/PdfAttachmentRenderService'
import {
  handleAuthorizeClipboardPasteIntent,
  handleAuthorizeDroppedAttachment,
  handleReadImagePreview,
  handleSaveClipboardImageAttachment,
  handleSelectImageFiles,
  IMAGE_PREVIEW_MAX_BYTES,
  type ImageAttachmentPreviewHandlerDeps
} from './imageAttachmentPreviewHandlers'

vi.mock('electron', () => ({
  clipboard: { readImage: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  nativeImage: { createEmpty: vi.fn(), createFromPath: vi.fn(), createFromBuffer: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdtemp: vi.fn(),
      rm: vi.fn(),
      realpath: vi.fn(),
      lstat: vi.fn(),
      readFile: vi.fn()
    }
  }
})

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile: vi.fn() }
})

vi.mock('../ClipboardImagePasteHandler', () => ({
  saveClipboardImageFromTrustedPaste: vi.fn()
}))

vi.mock('../services/PdfAttachmentRenderService', () => ({
  isPdfAttachmentPath: vi.fn(),
  renderPdfAttachmentPages: vi.fn()
}))

function createDeps() {
  const getMainWindow = vi.fn()
  const authorizeImagePreviewPath = vi.fn()
  const isMainRendererSender = vi.fn(() => true)
  const pasteIssue = vi.fn(() => true)
  const pasteConsume = vi.fn(() => true)
  const registerRendererCapabilityCleanup = vi.fn()
  const assertRendererChatScope = vi.fn()
  const getChat = vi.fn()
  const historyClearAdmissionBlocked = vi.fn(() => false)
  const getTranscriptMediaAssetStore = vi.fn()
  const isAuthorizedForRenderer = vi.fn(() => true)
  const historyBegin = vi.fn(() => ({ root: '/tmp/w9a-reservation' }))
  const historyIsCurrent = vi.fn(() => true)
  const endRegenerableHistoryByteReservation = vi.fn()
  const prunePdfAttachmentRenderCacheOnce = vi.fn(async () => {})
  const deps = {
    getMainWindow,
    authorizeImagePreviewPath,
    isMainRendererSender,
    clipboardPasteIntentRegistry: { issue: pasteIssue, consume: pasteConsume },
    registerRendererCapabilityCleanup,
    assertRendererChatScope,
    getChat,
    historyClearAdmissionBlocked,
    getTranscriptMediaAssetStore,
    attachmentCapabilityRegistry: { isAuthorizedForRenderer },
    regenerableHistoryByteStore: { begin: historyBegin, isCurrent: historyIsCurrent },
    endRegenerableHistoryByteReservation,
    prunePdfAttachmentRenderCacheOnce
  } as unknown as ImageAttachmentPreviewHandlerDeps
  return {
    deps,
    getMainWindow,
    authorizeImagePreviewPath,
    isMainRendererSender,
    pasteIssue,
    pasteConsume,
    registerRendererCapabilityCleanup,
    assertRendererChatScope,
    getChat,
    historyClearAdmissionBlocked,
    getTranscriptMediaAssetStore,
    isAuthorizedForRenderer,
    historyBegin,
    historyIsCurrent,
    endRegenerableHistoryByteReservation,
    prunePdfAttachmentRenderCacheOnce
  }
}

const invokeEvent = (senderId = 7) =>
  ({ sender: { id: senderId } }) as unknown as IpcMainInvokeEvent
const onEvent = (senderId = 7) => ({ sender: { id: senderId } }) as unknown as IpcMainEvent

function makeImage(
  options: { empty?: boolean; width?: number; height?: number; dataUrl?: string } = {}
) {
  const image = {
    isEmpty: vi.fn(() => options.empty ?? false),
    getSize: vi.fn(() => ({ width: options.width ?? 100, height: options.height ?? 50 })),
    resize: vi.fn(),
    toDataURL: vi.fn(() => options.dataUrl ?? 'data:image/png;base64,AAA')
  }
  image.resize.mockReturnValue(image)
  return image
}

function asNativeImage(image: ReturnType<typeof makeImage>): NativeImage {
  return image as unknown as NativeImage
}

function succeedSips() {
  vi.mocked(execFile).mockImplementation(((...args: Array<unknown>) => {
    const callback = args[args.length - 1] as (error: Error | null) => void
    callback(null)
    return undefined as unknown as ChildProcess
  }) as never)
}

function failSips() {
  vi.mocked(execFile).mockImplementation(((...args: Array<unknown>) => {
    const callback = args[args.length - 1] as (error: Error | null) => void
    callback(new Error('sips failed'))
    return undefined as unknown as ChildProcess
  }) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fsPromises.realpath).mockResolvedValue('/real/default.png')
  vi.mocked(fsPromises.lstat).mockResolvedValue({
    isFile: () => true,
    size: 1024
  } as unknown as Stats)
  vi.mocked(fsPromises.readFile).mockResolvedValue(Buffer.from('fake-bytes'))
  vi.mocked(fsPromises.mkdtemp).mockResolvedValue('/tmp/w9a-mkdtemp')
  vi.mocked(fsPromises.rm).mockResolvedValue(undefined)
  vi.mocked(isPdfAttachmentPath).mockReturnValue(false)
  vi.mocked(renderPdfAttachmentPages).mockResolvedValue({ rendered: [], skipped: [] })
  vi.mocked(nativeImage.createEmpty).mockImplementation(() =>
    asNativeImage(makeImage({ empty: true }))
  )
  vi.mocked(nativeImage.createFromPath).mockImplementation(() =>
    asNativeImage(makeImage({ empty: true }))
  )
  vi.mocked(nativeImage.createFromBuffer).mockImplementation(() =>
    asNativeImage(makeImage({ empty: true }))
  )
})

describe('handleAuthorizeDroppedAttachment', () => {
  it('authorizes the dropped path with sender and main authority', () => {
    const harness = createDeps()
    const event = onEvent(11)
    handleAuthorizeDroppedAttachment(harness.deps, event, '/tmp/drop.png')
    expect(harness.isMainRendererSender).toHaveBeenCalledWith(event)
    expect(harness.authorizeImagePreviewPath).toHaveBeenCalledWith('/tmp/drop.png', {
      sender: event.sender,
      mainAuthority: true
    })
  })

  it('forwards a false main authority for secondary renderers', () => {
    const harness = createDeps()
    harness.isMainRendererSender.mockReturnValue(false)
    const event = onEvent(12)
    handleAuthorizeDroppedAttachment(harness.deps, event, '/tmp/drop.png')
    expect(harness.authorizeImagePreviewPath).toHaveBeenCalledWith('/tmp/drop.png', {
      sender: event.sender,
      mainAuthority: false
    })
  })
})

describe('handleAuthorizeClipboardPasteIntent', () => {
  it('registers capability cleanup when the intent is issued', () => {
    const harness = createDeps()
    const event = onEvent(7)
    handleAuthorizeClipboardPasteIntent(harness.deps, event, 'token-1')
    expect(harness.pasteIssue).toHaveBeenCalledWith(7, 'token-1')
    expect(harness.registerRendererCapabilityCleanup).toHaveBeenCalledWith(event.sender)
  })

  it('skips cleanup when the intent is rejected', () => {
    const harness = createDeps()
    harness.pasteIssue.mockReturnValue(false)
    handleAuthorizeClipboardPasteIntent(harness.deps, onEvent(7), 'token-1')
    expect(harness.registerRendererCapabilityCleanup).not.toHaveBeenCalled()
  })
})

describe('handleSelectImageFiles', () => {
  it('returns empty without a dialog when no window is live', async () => {
    const harness = createDeps()
    harness.getMainWindow.mockReturnValue(null)
    const result = await handleSelectImageFiles(harness.deps, invokeEvent())
    expect(result).toEqual([])
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('returns empty when the dialog is cancelled', async () => {
    const harness = createDeps()
    const window = {}
    harness.getMainWindow.mockReturnValue(window)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    const result = await handleSelectImageFiles(harness.deps, invokeEvent())
    expect(result).toEqual([])
    expect(harness.authorizeImagePreviewPath).not.toHaveBeenCalled()
  })

  it('authorizes every picked path and returns them', async () => {
    const harness = createDeps()
    const window = {}
    harness.getMainWindow.mockReturnValue(window)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/a.png', '/b.png']
    })
    const event = invokeEvent(9)
    const result = await handleSelectImageFiles(harness.deps, event)
    expect(dialog.showOpenDialog).toHaveBeenCalledWith(window, {
      title: 'Select attachments',
      properties: ['openFile', 'multiSelections']
    })
    expect(result).toEqual(['/a.png', '/b.png'])
    expect(harness.authorizeImagePreviewPath).toHaveBeenCalledTimes(2)
    expect(harness.authorizeImagePreviewPath).toHaveBeenNthCalledWith(1, '/a.png', {
      sender: event.sender,
      mainAuthority: true
    })
    expect(harness.authorizeImagePreviewPath).toHaveBeenNthCalledWith(2, '/b.png', {
      sender: event.sender,
      mainAuthority: true
    })
  })

  it('returns empty when the picker yields no paths', async () => {
    const harness = createDeps()
    harness.getMainWindow.mockReturnValue({})
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [] })
    const result = await handleSelectImageFiles(harness.deps, invokeEvent())
    expect(result).toEqual([])
    expect(harness.authorizeImagePreviewPath).not.toHaveBeenCalled()
  })
})

describe('handleSaveClipboardImageAttachment', () => {
  it('rejects an empty chat id before touching scope or chat state', async () => {
    const harness = createDeps()
    await expect(
      handleSaveClipboardImageAttachment(harness.deps, invokeEvent(), '', 'tok')
    ).rejects.toThrow()
    expect(harness.assertRendererChatScope).not.toHaveBeenCalled()
    expect(harness.getChat).not.toHaveBeenCalled()
    expect(saveClipboardImageFromTrustedPaste).not.toHaveBeenCalled()
  })

  it('asserts sender scope for the chat before reading it', async () => {
    const harness = createDeps()
    harness.getChat.mockReturnValue(null)
    const event = invokeEvent()
    await handleSaveClipboardImageAttachment(harness.deps, event, 'chat-1', 'tok')
    expect(harness.assertRendererChatScope).toHaveBeenCalledWith(event, 'chat-1')
  })

  it('returns empty for a missing chat without pasting', async () => {
    const harness = createDeps()
    harness.getChat.mockReturnValue(null)
    const result = await handleSaveClipboardImageAttachment(
      harness.deps,
      invokeEvent(),
      'chat-1',
      'tok'
    )
    expect(result).toEqual([])
    expect(saveClipboardImageFromTrustedPaste).not.toHaveBeenCalled()
  })

  it('returns empty while history admission is blocked without pasting', async () => {
    const harness = createDeps()
    harness.getChat.mockReturnValue({ workspacePath: '/w', appChatId: 'chat-1' })
    harness.historyClearAdmissionBlocked.mockReturnValue(true)
    const result = await handleSaveClipboardImageAttachment(
      harness.deps,
      invokeEvent(),
      'chat-1',
      'tok'
    )
    expect(result).toEqual([])
    expect(harness.historyClearAdmissionBlocked).toHaveBeenCalledWith(undefined, '/w', 'chat-1')
    expect(saveClipboardImageFromTrustedPaste).not.toHaveBeenCalled()
  })

  it('delegates to the trusted paste writer with wired collaborators', async () => {
    const harness = createDeps()
    harness.getChat.mockReturnValue({ workspacePath: '/w', appChatId: 'chat-1' })
    const store = { name: 'media-store' }
    harness.getTranscriptMediaAssetStore.mockReturnValue(store)
    vi.mocked(saveClipboardImageFromTrustedPaste).mockResolvedValue(['/chat-1/media/x.png'])
    const event = invokeEvent(21)
    const result = await handleSaveClipboardImageAttachment(harness.deps, event, 'chat-1', 'tok-9')
    expect(result).toEqual(['/chat-1/media/x.png'])
    expect(saveClipboardImageFromTrustedPaste).toHaveBeenCalledTimes(1)
    const input = vi.mocked(saveClipboardImageFromTrustedPaste).mock.calls[0][0]
    expect(input.appChatId).toBe('chat-1')
    expect(input.senderId).toBe(21)
    expect(input.token).toBe('tok-9')
    expect(input.assetStore).toBe(store)
    expect(input.consumeIntent(21, 'tok-9')).toBe(true)
    expect(harness.pasteConsume).toHaveBeenCalledWith(21, 'tok-9')
    input.readImage()
    expect(clipboard.readImage).toHaveBeenCalledTimes(1)
    input.authorizePath('/chat-1/media/x.png')
    expect(harness.authorizeImagePreviewPath).toHaveBeenCalledWith('/chat-1/media/x.png', {
      sender: event.sender,
      mainAuthority: true,
      appChatId: 'chat-1'
    })
  })
})

describe('handleReadImagePreview', () => {
  it('keeps the 40 MiB preview ceiling intact', () => {
    expect(IMAGE_PREVIEW_MAX_BYTES).toBe(40 * 1024 * 1024)
  })

  it('returns null for a non-string path without touching the filesystem', async () => {
    const harness = createDeps()
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), 42)
    expect(result).toBeNull()
    expect(fsPromises.realpath).not.toHaveBeenCalled()
  })

  it('returns null for an empty path', async () => {
    const harness = createDeps()
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '')
    expect(result).toBeNull()
    expect(fsPromises.realpath).not.toHaveBeenCalled()
  })

  it('returns null when realpath fails', async () => {
    const harness = createDeps()
    vi.mocked(fsPromises.realpath).mockRejectedValue(new Error('gone'))
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/gone.png')
    expect(result).toBeNull()
    expect(harness.isAuthorizedForRenderer).not.toHaveBeenCalled()
  })

  it('enforces the C4 jail against unauthorized paths', async () => {
    const harness = createDeps()
    harness.isMainRendererSender.mockReturnValue(false)
    harness.isAuthorizedForRenderer.mockReturnValue(false)
    vi.mocked(fsPromises.realpath).mockResolvedValue('/real/evil.png')
    const event = invokeEvent(31)
    const result = await handleReadImagePreview(harness.deps, event, '/evil.png')
    expect(result).toBeNull()
    expect(harness.isAuthorizedForRenderer).toHaveBeenCalledWith(31, '/real/evil.png', {
      includeMainAuthority: false
    })
    expect(fsPromises.lstat).not.toHaveBeenCalled()
  })

  it('returns null for a non-file path', async () => {
    const harness = createDeps()
    vi.mocked(fsPromises.lstat).mockResolvedValue({
      isFile: () => false,
      size: 8
    } as unknown as Stats)
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/dir')
    expect(result).toBeNull()
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
  })

  it('rejects oversized non-PDF images before decoding', async () => {
    const harness = createDeps()
    vi.mocked(fsPromises.lstat).mockResolvedValue({
      isFile: () => true,
      size: IMAGE_PREVIEW_MAX_BYTES + 1
    } as unknown as Stats)
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/huge.png')
    expect(result).toBeNull()
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
  })

  it('serves a small image without resizing', async () => {
    const harness = createDeps()
    const image = makeImage({ width: 100, height: 50, dataUrl: 'data:image/png;base64,SMALL' })
    vi.mocked(nativeImage.createFromPath).mockReturnValue(asNativeImage(image))
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/small.png')
    expect(result).toBe('data:image/png;base64,SMALL')
    expect(image.resize).not.toHaveBeenCalled()
    expect(image.toDataURL).toHaveBeenCalledTimes(1)
  })

  it('downscales a large screenshot before encoding', async () => {
    const harness = createDeps()
    const image = makeImage({ width: 1280, height: 800 })
    vi.mocked(nativeImage.createFromPath).mockReturnValue(asNativeImage(image))
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/shot.png')
    expect(image.resize).toHaveBeenCalledWith({ width: 512, height: 320 })
    expect(image.toDataURL).toHaveBeenCalledTimes(1)
    expect(result).toBe('data:image/png;base64,AAA')
  })

  it('resolves file:// URLs before the jail check', async () => {
    const harness = createDeps()
    const image = makeImage({ dataUrl: 'data:image/png;base64,FILEURL' })
    vi.mocked(nativeImage.createFromPath).mockReturnValue(asNativeImage(image))
    // Built from a host-shaped absolute path: fileURLToPath yields a drive
    // letter and backslashes on win32, so a literal /tmp/x.png cannot match.
    const filePath = resolve('/tmp/x.png')
    const result = await handleReadImagePreview(
      harness.deps,
      invokeEvent(),
      pathToFileURL(filePath).href
    )
    expect(fsPromises.realpath).toHaveBeenCalledWith(filePath)
    expect(result).toBe('data:image/png;base64,FILEURL')
  })

  it('renders PDF previews under a cache lease in order', async () => {
    const harness = createDeps()
    vi.mocked(isPdfAttachmentPath).mockReturnValue(true)
    vi.mocked(renderPdfAttachmentPages).mockResolvedValue({
      rendered: [{ path: '/cache/p1.png' }],
      skipped: []
    } as never)
    const image = makeImage({ dataUrl: 'data:image/png;base64,PDF' })
    vi.mocked(nativeImage.createFromPath).mockReturnValue(asNativeImage(image))
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/doc.pdf')
    expect(result).toBe('data:image/png;base64,PDF')
    expect(harness.historyBegin).toHaveBeenCalledWith('pdf')
    const reservation = harness.historyBegin.mock.results[0].value
    expect(harness.prunePdfAttachmentRenderCacheOnce).toHaveBeenCalledWith('/tmp/w9a-reservation')
    expect(renderPdfAttachmentPages).toHaveBeenCalledWith(
      [{ path: '/real/default.png', name: 'default.png' }],
      {
        cacheDir: '/tmp/w9a-reservation'
      }
    )
    expect(nativeImage.createFromPath).toHaveBeenCalledWith('/cache/p1.png')
    expect(harness.endRegenerableHistoryByteReservation).toHaveBeenCalledWith(reservation)
    const order = [
      harness.historyBegin.mock.invocationCallOrder[0],
      harness.prunePdfAttachmentRenderCacheOnce.mock.invocationCallOrder[0],
      vi.mocked(renderPdfAttachmentPages).mock.invocationCallOrder[0],
      harness.endRegenerableHistoryByteReservation.mock.invocationCallOrder[0]
    ]
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
    expect(order[2]).toBeLessThan(order[3])
  })

  it('releases the PDF lease when rendering yields no pages', async () => {
    const harness = createDeps()
    vi.mocked(isPdfAttachmentPath).mockReturnValue(true)
    const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/empty.pdf')
    expect(result).toBeNull()
    expect(harness.endRegenerableHistoryByteReservation).toHaveBeenCalledTimes(1)
  })

  // The fallback is a macOS Image Services shell-out and the handler gates it
  // on process.platform, so these two only mean something where /usr/bin/sips
  // exists. The off-darwin branch is pinned by the last test in this group.
  it.skipIf(process.platform !== 'darwin')(
    'falls back to sips when native decoding fails and serves the result',
    async () => {
      const harness = createDeps()
      succeedSips()
      const outPath = join('/tmp/w9a-mkdtemp', 'preview.png')
      const sipsImage = makeImage({ dataUrl: 'data:image/png;base64,SIPS' })
      vi.mocked(nativeImage.createFromPath).mockImplementation((imagePath: string) =>
        asNativeImage(imagePath === outPath ? sipsImage : makeImage({ empty: true }))
      )
      const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/odd.heic')
      expect(fsPromises.mkdtemp).toHaveBeenCalledWith(
        join('/tmp/w9a-reservation', '.image-preview-')
      )
      expect(execFile).toHaveBeenCalledWith(
        '/usr/bin/sips',
        ['-s', 'format', 'png', '/real/default.png', '--out', outPath],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
        expect.any(Function)
      )
      expect(fsPromises.rm).toHaveBeenCalledWith('/tmp/w9a-mkdtemp', {
        recursive: true,
        force: true
      })
      expect(result).toBe('data:image/png;base64,SIPS')
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'returns null when sips fails instead of throwing',
    async () => {
      const harness = createDeps()
      failSips()
      const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/odd.heic')
      expect(result).toBeNull()
      expect(fsPromises.rm).toHaveBeenCalledTimes(1)
    }
  )

  // Runs everywhere: the platform is stubbed rather than skipped so the
  // no-sips branch is proven on a Mac too, not only observed on Linux/Windows.
  it('never shells out to sips off darwin', async () => {
    const harness = createDeps()
    succeedSips()
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const result = await handleReadImagePreview(harness.deps, invokeEvent(), '/odd.heic')
      expect(result).toBeNull()
      expect(execFile).not.toHaveBeenCalled()
      expect(fsPromises.mkdtemp).not.toHaveBeenCalled()
      expect(fsPromises.rm).not.toHaveBeenCalled()
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })
})
