/**
 * Image/clipboard attachment IPC handler bodies, extracted from
 * `src/main/index.ts` as a behavior-preserving move.
 *
 * The `ipcMain.on/handle` REGISTRATIONS deliberately stay in the composition
 * root as thin delegates: RendererIpcPolicy pins the channel strings there
 * and RegenerableHistoryByteMainIntegration slices the preview bodies, so
 * moving the registrations would red those suites. Do not "complete" this
 * extraction by moving the registration calls — the split is intentional.
 *
 * `composer-audio:transcribe` sits between these channels in the bootstrap
 * and is NOT part of this slice; it stays inline in `index.ts`.
 */
import { execFile } from 'child_process'
import { clipboard, dialog, nativeImage } from 'electron'
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { fileURLToPath } from 'url'
import type { AttachmentCapabilityRegistry } from '../AttachmentCapabilityRegistry'
import { saveClipboardImageFromTrustedPaste } from '../ClipboardImagePasteHandler'
import type { ClipboardPasteIntentRegistry } from '../ClipboardPasteIntentRegistry'
import {
  isPdfAttachmentPath,
  renderPdfAttachmentPages
} from '../services/PdfAttachmentRenderService'
import type {
  RegenerableHistoryByteReservation,
  RegenerableHistoryByteStore
} from '../services/RegenerableHistoryByteStore'
import type { TranscriptMediaAssetStore } from '../services/TranscriptMediaAssetStore'
import { requireNonEmptyString } from '../settings/MainSanitizers'
import type { ChatRecord } from '../store/types'

/**
 * Local alias mirroring the composition root (`index.ts`) and the ensemble
 * round handler module: only the sender side of the event is ever inspected.
 */
type RendererSenderEvent = Pick<IpcMainInvokeEvent, 'sender'>

/**
 * Collaborators owned by the composition root. The main window is read through
 * a getter on every invocation because `mainWindow` is a mutable module-level
 * binding assigned AFTER IPC registration — capturing it by value here would
 * pin `null` for the life of the process.
 */
export interface ImageAttachmentPreviewHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  authorizeImagePreviewPath: (
    rawPath: unknown,
    options?: { sender?: WebContents; mainAuthority?: boolean; appChatId?: string }
  ) => void
  isMainRendererSender: (event: RendererSenderEvent) => boolean
  clipboardPasteIntentRegistry: ClipboardPasteIntentRegistry
  registerRendererCapabilityCleanup: (sender: WebContents) => void
  assertRendererChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  getChat: (chatId: string) => ChatRecord | null
  historyClearAdmissionBlocked: (runId?: string, workspacePath?: string, chatId?: string) => boolean
  getTranscriptMediaAssetStore: () => TranscriptMediaAssetStore
  attachmentCapabilityRegistry: AttachmentCapabilityRegistry
  regenerableHistoryByteStore: RegenerableHistoryByteStore
  endRegenerableHistoryByteReservation: (reservation: RegenerableHistoryByteReservation) => void
  prunePdfAttachmentRenderCacheOnce: (cacheDir: string) => Promise<void>
}

export const IMAGE_PREVIEW_MAX_BYTES = 40 * 1024 * 1024

// C4: `read-image-preview` reads a local image and returns a data URL.
// Left open it is an arbitrary-image disclosure primitive — a future
// viewer that routes an agent-supplied `![](/Users/you/Pictures/x.jpg)`
// path through it would leak private images. Jail it to an allowlist of
// paths the USER explicitly attached. The composer authorizes every
// attachment (picker / drag-drop / paste) before its thumbnail renders;
// nothing else authorizes, so agent/transcript paths are rejected. Paths
// are stored realpath-resolved (symlink-safe) and bounded.
export function handleAuthorizeDroppedAttachment(
  deps: ImageAttachmentPreviewHandlerDeps,
  event: IpcMainEvent,
  rawPath: unknown
): void {
  // This event is emitted only inside preload immediately after
  // webUtils.getPathForFile succeeds for an OS-backed File object. The
  // context-isolated renderer has no generic ipcRenderer surface with which
  // to forge this channel.
  deps.authorizeImagePreviewPath(rawPath, {
    sender: event.sender,
    mainAuthority: deps.isMainRendererSender(event)
  })
}

export function handleAuthorizeClipboardPasteIntent(
  deps: ImageAttachmentPreviewHandlerDeps,
  event: IpcMainEvent,
  token: unknown
): void {
  if (deps.clipboardPasteIntentRegistry.issue(event.sender.id, token)) {
    deps.registerRendererCapabilityCleanup(event.sender)
  }
}

export async function handleSelectImageFiles(
  deps: ImageAttachmentPreviewHandlerDeps,
  event: IpcMainInvokeEvent
): Promise<string[]> {
  const mainWindow = deps.getMainWindow()
  if (!mainWindow) return []
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select attachments',
    properties: ['openFile', 'multiSelections']
  })

  if (result.canceled) {
    return []
  }
  const filePaths = result.filePaths || []
  for (const filePath of filePaths) {
    deps.authorizeImagePreviewPath(filePath, {
      sender: event.sender,
      mainAuthority: deps.isMainRendererSender(event)
    })
  }
  return filePaths
}

export async function handleSaveClipboardImageAttachment(
  deps: ImageAttachmentPreviewHandlerDeps,
  event: IpcMainInvokeEvent,
  rawAppChatId: unknown,
  token: unknown
): Promise<string[]> {
  const appChatId = requireNonEmptyString(rawAppChatId, 'Clipboard attachment chat id')
  deps.assertRendererChatScope(event, appChatId)
  const chat = deps.getChat(appChatId)
  if (!chat || deps.historyClearAdmissionBlocked(undefined, chat.workspacePath, chat.appChatId)) {
    return []
  }
  return saveClipboardImageFromTrustedPaste({
    appChatId,
    senderId: event.sender.id,
    token,
    consumeIntent: (senderId, candidate) =>
      deps.clipboardPasteIntentRegistry.consume(senderId, candidate),
    readImage: () => clipboard.readImage(),
    assetStore: deps.getTranscriptMediaAssetStore(),
    authorizePath: (filePath) =>
      deps.authorizeImagePreviewPath(filePath, {
        sender: event.sender,
        mainAuthority: deps.isMainRendererSender(event),
        appChatId
      })
  })
}

const readImageViaMacImageServices = async (
  real: string,
  reservation: RegenerableHistoryByteReservation,
  regenerableHistoryByteStore: RegenerableHistoryByteStore
): Promise<ReturnType<typeof nativeImage.createEmpty> | null> => {
  if (process.platform !== 'darwin') return null
  if (!regenerableHistoryByteStore.isCurrent(reservation)) return null
  const tempDir = await fs.mkdtemp(join(reservation.root, '.image-preview-'))
  const outPath = join(tempDir, 'preview.png')
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        '/usr/bin/sips',
        ['-s', 'format', 'png', real, '--out', outPath],
        { timeout: 15000, maxBuffer: 1024 * 1024 },
        (error) => {
          if (error) {
            rejectPromise(error)
            return
          }
          resolvePromise()
        }
      )
    })
    if (!regenerableHistoryByteStore.isCurrent(reservation)) return null
    const img = nativeImage.createFromPath(outPath)
    return img.isEmpty() ? null : img
  } catch {
    return null
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

// Composer attachment thumbnail. A raw file:// path can't be shown by the
// renderer (non-file origin + webSecurity), so read the image here and hand
// back a downscaled PNG data URL the <img> can actually load.
export async function handleReadImagePreview(
  deps: ImageAttachmentPreviewHandlerDeps,
  event: IpcMainInvokeEvent,
  rawPath: unknown
): Promise<string | null> {
  // Short alias for the two sips-fallback call sites below: the helper takes
  // the store as an explicit third parameter, and spelling out
  // `deps.regenerableHistoryByteStore` as that argument would exceed print width.
  const historyByteStore = deps.regenerableHistoryByteStore
  try {
    if (typeof rawPath !== 'string' || !rawPath) return null
    const filePath = rawPath.startsWith('file://') ? fileURLToPath(rawPath) : rawPath
    // C4 jail: only serve paths the user explicitly authorized as
    // attachments (see authorizeImagePreviewPath). realpath both sides so a
    // symlink can't smuggle an unauthorized target past the allowlist.
    let real: string
    try {
      real = await fs.realpath(filePath)
    } catch {
      return null
    }
    if (
      !deps.attachmentCapabilityRegistry.isAuthorizedForRenderer(event.sender.id, real, {
        includeMainAuthority: deps.isMainRendererSender(event)
      })
    ) {
      return null
    }
    const stat = await fs.lstat(real)
    if (!stat.isFile()) return null
    let img = nativeImage.createEmpty()
    if (isPdfAttachmentPath(real)) {
      const reservation = deps.regenerableHistoryByteStore.begin('pdf')
      try {
        await deps.prunePdfAttachmentRenderCacheOnce(reservation.root)
        if (!deps.regenerableHistoryByteStore.isCurrent(reservation)) return null
        const rendered = await renderPdfAttachmentPages([{ path: real, name: basename(real) }], {
          cacheDir: reservation.root
        })
        if (!deps.regenerableHistoryByteStore.isCurrent(reservation)) return null
        const firstPage = rendered.rendered[0]?.path
        if (!firstPage) return null
        img = nativeImage.createFromPath(firstPage)
        if (img.isEmpty()) {
          try {
            img = nativeImage.createFromBuffer(await fs.readFile(firstPage))
          } catch {
            img = nativeImage.createEmpty()
          }
        }
        if (img.isEmpty()) {
          img =
            (await readImageViaMacImageServices(firstPage, reservation, historyByteStore)) ??
            nativeImage.createEmpty()
        }
        if (!deps.regenerableHistoryByteStore.isCurrent(reservation)) return null
      } finally {
        deps.endRegenerableHistoryByteReservation(reservation)
      }
    } else {
      if (stat.size > IMAGE_PREVIEW_MAX_BYTES) return null
      img = nativeImage.createFromPath(real)
      if (img.isEmpty()) {
        try {
          img = nativeImage.createFromBuffer(await fs.readFile(real))
        } catch {
          img = nativeImage.createEmpty()
        }
      }
      if (img.isEmpty()) {
        const reservation = deps.regenerableHistoryByteStore.begin('media')
        try {
          img =
            (await readImageViaMacImageServices(real, reservation, historyByteStore)) ??
            nativeImage.createEmpty()
          if (!deps.regenerableHistoryByteStore.isCurrent(reservation)) return null
        } finally {
          deps.endRegenerableHistoryByteReservation(reservation)
        }
      }
    }
    if (img.isEmpty()) return null
    // Downscale large images so a screenshot isn't a multi-MB base64.
    const size = img.getSize()
    const scale = Math.min(1, 640 / Math.max(1, size.width), 320 / Math.max(1, size.height))
    const thumb =
      scale < 1
        ? img.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale))
          })
        : img
    return thumb.toDataURL()
  } catch {
    return null
  }
}
