import { type BrowserWindow, type SaveDialogOptions, ipcMain } from 'electron'
import { basename, join } from 'path'
import {
  TRANSCRIPT_MEDIA_ASSET_DIR,
  transcriptMediaAssetPath
} from '../services/TranscriptMediaAssetStore'

export interface MediaAssetHandlersDeps {
  isRecord: (value: unknown) => value is Record<string, unknown>
  getUserDataPath: () => string
  statIsFile: (assetPath: string) => boolean
  getMainWindow: () => BrowserWindow | null
  showItemInFolder: (assetPath: string) => void
  showSaveDialog: (
    window: BrowserWindow,
    options: SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
  copyFile: (src: string, dest: string) => Promise<void>
}

function resolveMediaAssetPath(deps: MediaAssetHandlersDeps, input: unknown): string | null {
  if (!deps.isRecord(input)) return null
  const sha256 = typeof input.sha256 === 'string' ? input.sha256.trim() : ''
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim() : ''
  if (!sha256 || !mimeType) return null
  const baseDir = join(deps.getUserDataPath(), TRANSCRIPT_MEDIA_ASSET_DIR)
  let assetPath: string
  try {
    assetPath = transcriptMediaAssetPath(baseDir, sha256, mimeType)
  } catch {
    return null
  }
  try {
    if (!deps.statIsFile(assetPath)) return null
  } catch {
    return null
  }
  return assetPath
}

export function registerMediaAssetHandlers(deps: MediaAssetHandlersDeps): void {
  ipcMain.handle('media-asset:reveal', async (_event, input: unknown): Promise<{ ok: boolean }> => {
    const assetPath = resolveMediaAssetPath(deps, input)
    if (!assetPath) return { ok: false }
    try {
      deps.showItemInFolder(assetPath)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle('media-asset:get-path', async (_event, input: unknown): Promise<string | null> => {
    return resolveMediaAssetPath(deps, input)
  })

  ipcMain.handle(
    'media-asset:save-as',
    async (_event, input: unknown): Promise<{ ok: boolean; canceled: boolean }> => {
      const assetPath = resolveMediaAssetPath(deps, input)
      if (!assetPath) return { ok: false, canceled: false }
      const mainWindow = deps.getMainWindow()
      if (!mainWindow) return { ok: false, canceled: false }
      const suggestedName =
        deps.isRecord(input) && typeof input.suggestedName === 'string' && input.suggestedName.trim()
          ? input.suggestedName.trim()
          : basename(assetPath)
      let chosen: string | undefined
      try {
        const result = await deps.showSaveDialog(mainWindow, { defaultPath: suggestedName })
        if (result.canceled || !result.filePath) return { ok: false, canceled: true }
        chosen = result.filePath
      } catch {
        return { ok: false, canceled: false }
      }
      try {
        await deps.copyFile(assetPath, chosen)
        return { ok: true, canceled: false }
      } catch {
        return { ok: false, canceled: false }
      }
    }
  )
}
