import { ipcMain } from 'electron'
import {
  resolveAuthorizedRendererLocalPath,
  type AuthorizeRendererLocalPath
} from '../RendererLocalPathAuthority'

interface FileIconLike {
  toDataURL(): string
}

export interface FileIconHandlersDeps {
  getFileIcon: (normalizedPath: string, options: { size: 'small' }) => Promise<FileIconLike>
  cache?: Map<string, string | null>
  /** Optional only so a missing integration fails closed instead of weakening authority. */
  authorizeLocalPath?: AuthorizeRendererLocalPath
}

export function registerFileIconHandlers(deps: FileIconHandlersDeps): void {
  const cache = deps.cache ?? new Map<string, string | null>()

  ipcMain.handle('get-file-icon', async (event, requestedPath: string) => {
    if (typeof requestedPath !== 'string') {
      return null
    }

    const trimmedPath = requestedPath.trim()
    if (!trimmedPath) {
      return null
    }

    const normalizedPath = await resolveAuthorizedRendererLocalPath(
      deps.authorizeLocalPath,
      event,
      { operation: 'file-icon', requestedPath: trimmedPath }
    )

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
