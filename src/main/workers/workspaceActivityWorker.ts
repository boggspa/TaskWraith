/** Workspace-activity utility-process entry. */
import { getWorkspaceActivitySnapshot } from '../WorkspaceActivityService'
import type { WorkspaceActivityScanRequest } from '../WorkspaceActivityBackground'

const parentPort = process.parentPort

parentPort?.on('message', (event) => {
  const message = event?.data as
    | { type?: string; request?: WorkspaceActivityScanRequest }
    | undefined
  if (!message || message.type !== 'scan' || !message.request) return
  const request = message.request

  void (async () => {
    try {
      const snapshot = await getWorkspaceActivitySnapshot(
        request.workspacePath,
        request.dayCount,
        // The worker is single-use. Its own cache buys nothing and retaining
        // it would only obscure the fact that each main-side cache miss scans.
        { cacheTtlMs: 0 }
      )
      parentPort?.postMessage({ type: 'complete', snapshot })
    } catch (error) {
      parentPort?.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })()
})
