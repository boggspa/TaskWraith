import { ipcMain } from 'electron'

interface FileIconLike {
  toDataURL(): string
}

export interface FileIconHandlersDeps {
  getFileIcon: (
    normalizedPath: string,
    options: { size: 'small' }
  ) => Promise<FileIconLike>
  cache?: Map<string, string | null>
}

export function registerFileIconHandlers(deps: FileIconHandlersDeps): void {
  const cache = deps.cache ?? new Map<string, string | null>()

  ipcMain.handle('get-file-icon', async (_, requestedPath: string) => {
    if (typeof requestedPath !== 'string') {
      return null
    }

    const normalizedPath = requestedPath.trim()
    if (!normalizedPath) {
      return null
    }

    if (cache.has(normalizedPath)) {
      return cache.get(normalizedPath) ?? null
    }

    try {
      const icon = await deps.getFileIcon(normalizedPath, { size: 'small' })
      const dataUrl = icon.toDataURL()
      cache.set(normalizedPath, dataUrl)
      return dataUrl
    } catch {
      cache.set(normalizedPath, null)
      return null
    }
  })
}
