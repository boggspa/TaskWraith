import { ipcMain, webContents } from 'electron'
import { TerminalSessionManager } from '../terminal/TerminalSessionManager'

export interface TerminalHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderWorkspaceScope: (
    event: Electron.IpcMainInvokeEvent,
    workspacePath: string
  ) => void
}

export function registerTerminalHandlers(deps: TerminalHandlerDeps, manager: TerminalSessionManager): void {
  const { requireRegisteredWorkspace, assertSenderWorkspaceScope } = deps

  ipcMain.handle('terminal:create', async (event, workspacePath: string, sessionId: string) => {
    const registeredWorkspace = requireRegisteredWorkspace(workspacePath)
    assertSenderWorkspaceScope(event, registeredWorkspace)
    // No requestAgenticServiceApproval gate here as per binding ruling
    manager.create(registeredWorkspace, sessionId)
  })

  ipcMain.handle('terminal:write', (event, sessionId: string, data: string) => {
    manager.write(sessionId, data)
  })

  ipcMain.handle('terminal:resize', (event, sessionId: string, cols: number, rows: number) => {
    manager.resize(sessionId, cols, rows)
  })

  ipcMain.handle('terminal:detach', (event, sessionId: string) => {
    manager.detach(sessionId)
  })

  ipcMain.handle('terminal:kill', (event, sessionId: string) => {
    manager.kill(sessionId)
  })

  ipcMain.handle('terminal:list', (event) => {
    return manager.list()
  })

  ipcMain.handle('terminal:getScrollback', (event, sessionId: string) => {
    return manager.getScrollback(sessionId)
  })

  manager.on('data', (sessionId: string, data: string) => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send('terminal:data', sessionId, data)
    }
  })

  manager.on('exit', (sessionId: string, exitCode: number) => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send('terminal:exit', sessionId, exitCode)
    }
  })
}
