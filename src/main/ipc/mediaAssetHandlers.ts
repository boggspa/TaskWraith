import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type SaveDialogOptions,
  ipcMain
} from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { TRANSCRIPT_MEDIA_ASSET_DIR } from '../services/TranscriptMediaAssetStore'
import {
  type ResolvedTwMediaAsset,
  openTranscriptMediaAsset,
  verifyOpenedTwMediaAssetSnapshot
} from '../media/twMediaRange'

export interface MediaAssetHandlersDeps {
  isRecord: (value: unknown) => value is Record<string, unknown>
  getUserDataPath: () => string
  /** @deprecated Retained until the root registration is simplified. */
  statIsFile: (assetPath: string) => boolean
  /** Main-owned sender lookup; payload chat ids are never authority. */
  authorizeSender: (event: IpcMainInvokeEvent, asset: MediaAssetIdentity) => boolean
  getRequestingWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null
  showItemInFolder: (assetPath: string) => void
  showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
  /** @deprecated Secure exports use the already-open descriptor instead. */
  copyFile: (src: string, dest: string) => Promise<void>
  /** Test seam; production defaults to the descriptor-backed streaming copy. */
  copyOpenedAsset?: (asset: ResolvedTwMediaAsset, dest: string) => Promise<void>
}

export interface MediaAssetIdentity {
  sha256: string
  mimeType: string
}

function resolveMediaAssetIdentity(
  deps: Pick<MediaAssetHandlersDeps, 'isRecord'>,
  input: unknown
): MediaAssetIdentity | null {
  if (!deps.isRecord(input)) return null
  const sha256 = typeof input.sha256 === 'string' ? input.sha256.trim() : ''
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : ''
  if (!sha256 || !mimeType) return null
  return { sha256, mimeType }
}

function openAuthorizedMediaAsset(
  deps: MediaAssetHandlersDeps,
  event: IpcMainInvokeEvent,
  input: unknown
): ResolvedTwMediaAsset | null {
  const identity = resolveMediaAssetIdentity(deps, input)
  if (!identity) return null
  try {
    if (!deps.authorizeSender(event, identity)) return null
  } catch {
    return null
  }
  try {
    const baseDir = join(deps.getUserDataPath(), TRANSCRIPT_MEDIA_ASSET_DIR)
    return openTranscriptMediaAsset({
      baseDir,
      sha256: identity.sha256,
      mimeType: identity.mimeType
    })
  } catch {
    return null
  }
}

function safeSuggestedName(input: unknown, deps: MediaAssetHandlersDeps, fallback: string): string {
  if (!deps.isRecord(input) || typeof input.suggestedName !== 'string') return fallback
  const candidate = input.suggestedName.trim()
  if (!candidate || candidate.includes('\0')) return fallback
  const leaf = basename(candidate.replace(/\\/g, '/')).trim()
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : fallback
}

/**
 * Stream an export from the exact verified source descriptor into a private
 * sibling temp file, then atomically replace the chosen destination. No source
 * pathname is reopened, so a path replacement while the save dialog is open
 * cannot redirect the copy. The fixed I/O buffer keeps large AV out
 * of memory.
 */
export async function copyOpenedMediaAssetToPath(
  asset: ResolvedTwMediaAsset,
  destination: string
): Promise<void> {
  if (!isAbsolute(destination) || resolve(destination) === resolve(asset.realPath)) {
    throw new Error('Invalid transcript media export destination.')
  }
  if (!verifyOpenedTwMediaAssetSnapshot(asset)) {
    throw new Error('Transcript media asset changed before export.')
  }

  const tempPath = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`
  )
  let tempFd: number | null = null
  let committed = false
  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    )
    fs.fchmodSync(tempFd, 0o600)
    const buffer = Buffer.allocUnsafe(Math.min(asset.size, 256 * 1024))
    let copied = 0
    while (copied < asset.size) {
      const requested = Math.min(buffer.length, asset.size - copied)
      const bytesRead = await new Promise<number>((accept, reject) => {
        fs.read(asset.fd, buffer, 0, requested, copied, (error, count) => {
          if (error) reject(error)
          else accept(count)
        })
      })
      if (bytesRead !== requested) {
        throw new Error('Transcript media asset was truncated during export.')
      }
      let written = 0
      while (written < bytesRead) {
        const count = await new Promise<number>((accept, reject) => {
          fs.write(
            tempFd as number,
            buffer,
            written,
            bytesRead - written,
            copied + written,
            (error, n) => {
              if (error) reject(error)
              else accept(n)
            }
          )
        })
        if (count <= 0) throw new Error('Transcript media export write was truncated.')
        written += count
      }
      copied += bytesRead
    }
    if (copied !== asset.size || !verifyOpenedTwMediaAssetSnapshot(asset)) {
      throw new Error('Transcript media asset changed during export.')
    }
    fs.fsyncSync(tempFd)
    if (fs.fstatSync(tempFd).size !== asset.size) {
      throw new Error('Transcript media export was truncated.')
    }
    fs.closeSync(tempFd)
    tempFd = null
    fs.renameSync(tempPath, destination)
    committed = true
  } finally {
    if (tempFd !== null) {
      try {
        fs.closeSync(tempFd)
      } catch {
        // Preserve the copy failure.
      }
    }
    if (!committed) {
      try {
        fs.unlinkSync(tempPath)
      } catch {
        // The temp may not have been created or may already be gone.
      }
    }
  }
}

export function registerMediaAssetHandlers(deps: MediaAssetHandlersDeps): void {
  ipcMain.handle('media-asset:reveal', async (event, input: unknown): Promise<{ ok: boolean }> => {
    const asset = openAuthorizedMediaAsset(deps, event, input)
    if (!asset) return { ok: false }
    try {
      deps.showItemInFolder(asset.realPath)
      return { ok: true }
    } catch {
      return { ok: false }
    } finally {
      asset.close()
    }
  })

  ipcMain.handle('media-asset:get-path', async (event, input: unknown): Promise<string | null> => {
    const asset = openAuthorizedMediaAsset(deps, event, input)
    if (!asset) return null
    try {
      return asset.realPath
    } finally {
      asset.close()
    }
  })

  ipcMain.handle(
    'media-asset:save-as',
    async (event, input: unknown): Promise<{ ok: boolean; canceled: boolean }> => {
      const asset = openAuthorizedMediaAsset(deps, event, input)
      if (!asset) return { ok: false, canceled: false }
      try {
        let requestingWindow: BrowserWindow | null
        try {
          requestingWindow = deps.getRequestingWindow(event)
        } catch {
          return { ok: false, canceled: false }
        }
        if (!requestingWindow) return { ok: false, canceled: false }
        const suggestedName = safeSuggestedName(input, deps, basename(asset.realPath))
        let chosen: string | undefined
        try {
          const result = await deps.showSaveDialog(requestingWindow, { defaultPath: suggestedName })
          if (result.canceled || !result.filePath) return { ok: false, canceled: true }
          chosen = result.filePath
        } catch {
          return { ok: false, canceled: false }
        }
        try {
          await (deps.copyOpenedAsset ?? copyOpenedMediaAssetToPath)(asset, chosen)
          return { ok: true, canceled: false }
        } catch {
          return { ok: false, canceled: false }
        }
      } finally {
        asset.close()
      }
    }
  )
}
