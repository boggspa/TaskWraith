import { ipcMain } from 'electron'
import * as pty from 'node-pty'
import os from 'os'
import { optionalString } from '../settings/MainSanitizers'
import type { AgenticServiceId, ProviderId } from '../store/types'

/**
 * Trust Assistant PTY handlers (`start-pty`, `stop-pty`, `pty-write`,
 * `pty-resize`) — the first slice carved out of the ~21k-line main-process
 * IPC god-module in index.ts. Lifted verbatim from the `app.whenReady()`
 * block; behavior is unchanged.
 *
 * The two per-session collections (`ptyProcesses` / `stoppedPtySessions`)
 * were already PTY-local in index.ts (no other handler touched them) and
 * move here intact. The two index-local collaborators the handlers close
 * over — `requireRegisteredWorkspace` and `requestAgenticServiceApproval` —
 * are injected via {@link PtyHandlerDeps} so this module never imports back
 * into index.ts (no import cycle).
 *
 * `ipcMain` is the same Electron singleton that `installIpcValidation(ipcMain)`
 * patches in index.ts before any registration runs, so every channel below
 * still flows through `validateIpcArgs`. `IpcValidation.test.ts` statically
 * scans `src/main/ipc/*.ts` in addition to index.ts, so these channels' arg
 * schemas stay enforced at build time.
 */
export interface PtyHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderWorkspaceScope: (
    event: Electron.IpcMainInvokeEvent,
    workspacePath: string
  ) => void
  requestAgenticServiceApproval: (
    sender: Electron.WebContents | null,
    provider: ProviderId,
    service: AgenticServiceId,
    workspacePath: string | undefined,
    request: {
      method: string
      title: string
      body: string
      preview?: unknown
    }
  ) => Promise<boolean>
}

export function registerPtyHandlers(deps: PtyHandlerDeps): void {
  const { requireRegisteredWorkspace, assertSenderWorkspaceScope, requestAgenticServiceApproval } = deps

  // PTY for Trust Assistant
  const ptyProcesses = new Map<string, pty.IPty>()
  const stoppedPtySessions = new Set<string>()
  const ptySessionKey = (senderId: number, sessionId: string): string => `${senderId}:${sessionId}`

  ipcMain.handle(
    'start-pty',
    async (event, workspacePath: string, sessionId: string = 'default') => {
      const registeredWorkspace = requireRegisteredWorkspace(workspacePath)
      assertSenderWorkspaceScope(event, registeredWorkspace)
      const ptySessionId = optionalString(sessionId) || 'default'
      const sessionKey = ptySessionKey(event.sender.id, ptySessionId)
      stoppedPtySessions.delete(sessionKey)
      const allowed = await requestAgenticServiceApproval(
        event.sender,
        'gemini',
        'shellCommands',
        registeredWorkspace,
        {
          method: 'pty/start',
          title: 'Approve setup terminal',
          body: `${registeredWorkspace}\n${process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash')}`,
          preview: {
            kind: 'terminal',
            workspacePath: registeredWorkspace,
            sessionId: ptySessionId
          }
        }
      )
      if (!allowed) {
        event.sender.send(
          'pty-data',
          'Terminal start denied by TaskWraith approval policy.\r\n',
          ptySessionId
        )
        event.sender.send('pty-exit', -1, ptySessionId)
        return
      }
      if (stoppedPtySessions.delete(sessionKey)) {
        event.sender.send('pty-exit', null, ptySessionId)
        return
      }

      const existing = ptyProcesses.get(sessionKey)
      if (existing) {
        existing.kill()
        ptyProcesses.delete(sessionKey)
      }

      const shellCommand =
        os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'

      const ptyProcess = pty.spawn(shellCommand, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: registeredWorkspace,
        env: process.env as Record<string, string>
      })
      ptyProcesses.set(sessionKey, ptyProcess)

      ptyProcess.onData((data) => {
        event.sender.send('pty-data', data, ptySessionId)
      })

      ptyProcess.onExit((e) => {
        event.sender.send('pty-exit', e.exitCode, ptySessionId)
        if (ptyProcesses.get(sessionKey) === ptyProcess) {
          ptyProcesses.delete(sessionKey)
        }
      })
    }
  )

  ipcMain.handle('stop-pty', (event, sessionId: string = 'default') => {
    const ptySessionId = optionalString(sessionId) || 'default'
    const sessionKey = ptySessionKey(event.sender.id, ptySessionId)
    const ptyProcess = ptyProcesses.get(sessionKey)
    if (ptyProcess) {
      ptyProcess.kill()
      ptyProcesses.delete(sessionKey)
    } else {
      stoppedPtySessions.add(sessionKey)
    }
  })

  ipcMain.handle('pty-write', (event, data: string, sessionId: string = 'default') => {
    const ptySessionId = optionalString(sessionId) || 'default'
    const ptyProcess = ptyProcesses.get(ptySessionKey(event.sender.id, ptySessionId))
    if (ptyProcess) {
      ptyProcess.write(data)
    }
  })

  ipcMain.handle('pty-resize', (event, cols: number, rows: number, sessionId: string = 'default') => {
    const ptySessionId = optionalString(sessionId) || 'default'
    const ptyProcess = ptyProcesses.get(ptySessionKey(event.sender.id, ptySessionId))
    if (ptyProcess) {
      ptyProcess.resize(cols, rows)
    }
  })
}
