import { utilityProcess } from 'electron'
import { constants as osConstants, setPriority } from 'node:os'

import type { ProjectReferenceLegacyArtifactRef } from './services/ProjectReferenceArtifactStore'
import {
  PROJECT_REFERENCE_OWNERSHIP_SCAN_INTEGRITY,
  type ProjectReferenceOwnershipScanRequest,
  validateProjectReferenceOwnershipProjection
} from './services/ProjectReferenceOwnershipScanner'

const WORKER_SCAN_TIMEOUT_MS = 30 * 60 * 1000

type WorkerMessage =
  | { type: 'complete'; integrity: unknown; references: unknown }
  | { type: 'error'; message: string }

function validatedReferences(value: unknown): ProjectReferenceLegacyArtifactRef[] {
  return validateProjectReferenceOwnershipProjection(value)
}

/**
 * Runs the recurring multi-gigabyte ownership rebuild outside Electron main.
 * There is intentionally no in-process fallback: failure retains the existing
 * capture hold instead of freezing the UI or reconciling from partial data.
 */
export function createProjectReferenceOwnershipWorkerLoader(
  workerModulePath: string,
  request: ProjectReferenceOwnershipScanRequest
): () => Promise<ProjectReferenceLegacyArtifactRef[]> {
  return () =>
    new Promise<ProjectReferenceLegacyArtifactRef[]>((resolve, reject) => {
      let child: Electron.UtilityProcess
      try {
        child = utilityProcess.fork(workerModulePath, [], {
          serviceName: 'taskwraith-project-reference-ownership-scan',
          execArgv: ['--max-old-space-size=256']
        })
      } catch (error) {
        reject(error)
        return
      }
      try {
        if (typeof child.pid === 'number' && child.pid > 0) {
          setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
        }
      } catch {
        // Best-effort. Process isolation still keeps the Electron event loop responsive.
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
        finish(() => reject(new Error('Project-reference ownership worker scan timed out.')))
      }, WORKER_SCAN_TIMEOUT_MS)
      timeout.unref?.()

      child.on('message', (raw: unknown) => {
        const message = raw as WorkerMessage
        if (message?.type === 'complete') {
          try {
            if (message.integrity !== PROJECT_REFERENCE_OWNERSHIP_SCAN_INTEGRITY) {
              throw new Error('Project-reference ownership worker integrity mode changed.')
            }
            const references = validatedReferences(message.references)
            finish(() => resolve(references))
          } catch (error) {
            finish(() => reject(error))
          }
        } else if (message?.type === 'error') {
          finish(() =>
            reject(
              new Error(
                typeof message.message === 'string' && message.message
                  ? message.message
                  : 'Project-reference ownership worker failed.'
              )
            )
          )
        } else {
          finish(() =>
            reject(new Error('Project-reference ownership worker returned an invalid message.'))
          )
        }
      })
      child.on('error', (error) => {
        finish(() => reject(error))
      })
      child.on('exit', (code) => {
        finish(() =>
          reject(
            new Error(`Project-reference ownership worker exited (code ${code}) before completing.`)
          )
        )
      })

      try {
        child.postMessage({ type: 'scan', request })
      } catch (error) {
        finish(() => reject(error))
      }
    })
}
