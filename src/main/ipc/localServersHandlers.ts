import { ipcMain } from 'electron'
import type { LocalServersService } from '../LocalServersService'

export interface LocalServersHandlerDeps {
  localServersService: Pick<
    LocalServersService,
    'snapshot' | 'refreshNow' | 'stopServer' | 'stopAll'
  >
}

export function registerLocalServersHandlers(deps: LocalServersHandlerDeps): void {
  ipcMain.handle('local-servers-snapshot', () => deps.localServersService.snapshot())
  ipcMain.handle('local-servers-refresh', () => deps.localServersService.refreshNow())
  ipcMain.handle('local-servers-stop', (_event, pid) =>
    deps.localServersService.stopServer(Number(pid))
  )
  ipcMain.handle('local-servers-stop-all', () => deps.localServersService.stopAll())
}
