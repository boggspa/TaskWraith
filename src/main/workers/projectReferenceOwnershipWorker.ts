/**
 * Project-reference ownership scan worker (Electron utilityProcess entry).
 *
 * The run-event archive grows to multiple gigabytes. Rebuilding ownership in
 * Electron main after first paint freezes every renderer IPC even with async
 * file reads. This worker streams only canonical reference-context records and
 * returns their bounded ownership projection; main remains the sole authority
 * that validates snapshot bytes, publishes the ledger, and deletes orphans.
 */
import {
  PROJECT_REFERENCE_OWNERSHIP_SCAN_INTEGRITY,
  scanProjectReferenceOwnership,
  type ProjectReferenceOwnershipScanRequest
} from '../services/ProjectReferenceOwnershipScanner'

const parentPort = process.parentPort

parentPort?.on('message', (event) => {
  const message = event?.data as
    | { type?: string; request?: ProjectReferenceOwnershipScanRequest }
    | undefined
  if (!message || message.type !== 'scan' || !message.request) return
  void scanProjectReferenceOwnership(message.request).then(
    (references) => {
      parentPort?.postMessage({
        type: 'complete',
        integrity: PROJECT_REFERENCE_OWNERSHIP_SCAN_INTEGRITY,
        references
      })
    },
    (error) => {
      parentPort?.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  )
})
