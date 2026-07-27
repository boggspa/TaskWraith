/**
 * Utility-process driver for workspace activity hydration. The worker owns
 * git history and filesystem scans so a cold 90-day heatmap cannot monopolise
 * Electron main or delay renderer IPC.
 */
import { utilityProcess } from 'electron'
import type { WorkspaceActivitySnapshot } from './store/types'
import type { WorkspaceActivityScanDriver } from './WorkspaceActivityBackground'

// Slow network volumes can genuinely need a couple of minutes for the
// bounded scan. That is harmless in a utility process, so prefer eventual
// hydration while the UI stays on its empty cache placeholder.
const WORKER_SCAN_TIMEOUT_MS = 5 * 60 * 1000

type WorkerMessage =
  | { type: 'complete'; snapshot: WorkspaceActivitySnapshot }
  | { type: 'error'; message: string }

export function createWorkspaceActivityWorkerDriver(
  workerModulePath: string
): WorkspaceActivityScanDriver {
  return (request) =>
    new Promise<WorkspaceActivitySnapshot>((resolve, reject) => {
      let child: Electron.UtilityProcess
      try {
        child = utilityProcess.fork(workerModulePath, [], {
          serviceName: 'taskwraith-workspace-activity-scan'
        })
      } catch (error) {
        reject(error)
        return
      }

      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        try {
          child.kill()
        } catch {
          // Already exited.
        }
        settle()
      }
      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Workspace activity worker scan timed out.')))
      }, WORKER_SCAN_TIMEOUT_MS)
      timeout.unref?.()

      child.on('message', (raw: unknown) => {
        const message = raw as WorkerMessage
        if (message?.type === 'complete') {
          finish(() => resolve(message.snapshot))
        } else if (message?.type === 'error') {
          finish(() => reject(new Error(message.message)))
        }
      })
      child.on('exit', (code) => {
        finish(() =>
          reject(new Error(`Workspace activity worker exited (code ${code}) before completing.`))
        )
      })

      child.postMessage({ type: 'scan', request })
    })
}
