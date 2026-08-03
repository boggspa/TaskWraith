import { utilityProcess } from 'electron'
import type { WorkProvenanceProjection } from '../../shared/workProvenance'

const WORKER_TIMEOUT_MS = 12_000

export type WorkProvenanceQueryDriver = (root: string) => Promise<unknown>

type WorkerMessage =
  | { type: 'complete'; projection: WorkProvenanceProjection }
  | { type: 'error'; message: string }

/**
 * Run provenance sampling outside Electron main. The audited query brackets
 * multiple Git reads and fingerprints dirty paths, which is intentionally too
 * much synchronous work for the UI-owning process.
 */
export function createWorkProvenanceWorkerDriver(
  workerModulePath: string
): WorkProvenanceQueryDriver {
  return (root) =>
    new Promise<unknown>((resolve, reject) => {
      let child: Electron.UtilityProcess
      try {
        child = utilityProcess.fork(workerModulePath, [], {
          serviceName: 'taskwraith-work-provenance-query'
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
          // The single-use worker has already exited.
        }
        settle()
      }
      const timeout = setTimeout(() => {
        finish(() => reject(new Error('Work provenance query timed out.')))
      }, WORKER_TIMEOUT_MS)
      timeout.unref?.()

      child.on('message', (raw: unknown) => {
        const message = raw as WorkerMessage
        if (message?.type === 'complete') {
          finish(() => resolve(message.projection))
        } else if (message?.type === 'error') {
          finish(() => reject(new Error(message.message)))
        }
      })
      child.on('exit', (code) => {
        finish(() =>
          reject(new Error(`Work provenance worker exited (code ${code}) before completing.`))
        )
      })

      child.postMessage({ type: 'query', root })
    })
}
