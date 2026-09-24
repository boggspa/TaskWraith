import { ipcMain } from 'electron'
import type { ProductChangelogSnapshot } from '../store/types'
import type { UpdateRestartCoordinator, UpdateRestartRequest } from '../UpdateRestartCoordinator'
import type { UpdateService } from '../UpdateService'

export interface UpdateHandlerDeps {
  updateService: Pick<UpdateService, 'snapshot' | 'checkForUpdates' | 'downloadUpdate'>
  updateRestartCoordinator: Pick<UpdateRestartCoordinator, 'requestRestartWhenIdle'>
  changelogSnapshot: () => ProductChangelogSnapshot
  updateLastSeenChangelogVersion: (version: string) => void
}

/** Only an explicit boolean `force` is honoured; anything else is a plain request. */
export function parseUpdateRestartRequest(value: unknown): UpdateRestartRequest {
  const force =
    typeof value === 'object' && value !== null && (value as { force?: unknown }).force === true
  return { force }
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
  ipcMain.handle('download-update-and-restart', async () => {
    await deps.updateService.downloadUpdate()
    deps.updateRestartCoordinator.requestRestartWhenIdle()
    return deps.updateService.snapshot()
  })
  ipcMain.handle('install-update-now', (_event, options: unknown) => {
    deps.updateRestartCoordinator.requestRestartWhenIdle(parseUpdateRestartRequest(options))
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
