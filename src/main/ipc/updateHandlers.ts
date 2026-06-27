import { ipcMain } from 'electron'
import type { ProductChangelogSnapshot } from '../store/types'
import type { UpdateService } from '../UpdateService'

export interface UpdateHandlerDeps {
  updateService: Pick<
    UpdateService,
    'snapshot' | 'checkForUpdates' | 'downloadUpdate' | 'installOnQuit' | 'quitAndInstall'
  >
  changelogSnapshot: () => ProductChangelogSnapshot
  updateLastSeenChangelogVersion: (version: string) => void
}

export function registerUpdateHandlers(deps: UpdateHandlerDeps): void {
  ipcMain.handle('update-snapshot', () => deps.updateService.snapshot())
  ipcMain.handle('check-for-updates', async () => {
    await deps.updateService.checkForUpdates()
    return deps.updateService.snapshot()
  })
  ipcMain.handle('download-update', async () => {
    await deps.updateService.downloadUpdate()
    return deps.updateService.snapshot()
  })
  ipcMain.handle('install-update-on-quit', () => {
    deps.updateService.installOnQuit()
    return deps.updateService.snapshot()
  })
  ipcMain.handle('install-update-now', () => {
    deps.updateService.quitAndInstall()
    return deps.updateService.snapshot()
  })
  ipcMain.handle('changelog-snapshot', () => deps.changelogSnapshot())
  ipcMain.handle('mark-changelog-seen', (_event, version: unknown) => {
    const normalizedVersion = typeof version === 'string' ? version.trim() : ''
    if (!normalizedVersion) return deps.changelogSnapshot()
    deps.updateLastSeenChangelogVersion(normalizedVersion)
    return deps.changelogSnapshot()
  })
}
