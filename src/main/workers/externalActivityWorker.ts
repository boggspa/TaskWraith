/**
 * External-activity scan worker (Electron utilityProcess entry).
 *
 * The 90-day provider-log walk is tens of GB cold; run on the main process it
 * pegged the event loop for minutes (the 2026-07 launch stall). Process
 * isolation keeps Electron main responsive, while duty cycling keeps this
 * background job from monopolising a CPU core and the system page cache.
 *
 * Protocol (all messages are structured-clone JSON):
 *  in:  { type: 'scan', request: ExternalScanRequest }
 *  out: { type: 'partial',        records: UsageRecord[] }  cold short-window pass
 *       { type: 'cursor-records', records: UsageRecord[] }  Cursor chunk upgrades
 *       { type: 'complete',       records: UsageRecord[] }  full-window result
 *       { type: 'error',          message: string }
 *
 * The scan request MUST carry explicit externalFileCachePath/cursorCachePath:
 * this process has no electron `app`, so default userData resolution would
 * throw. The driver stamps them in (defaultExternalActivityCachePaths).
 */
import {
  loadExternalProviderUsageRecords,
  setCursorRecordsForwarder,
  setExternalScanYieldMode,
  type ExternalScanRequest
} from '../ExternalProviderActivity'

const parentPort = process.parentPort

setExternalScanYieldMode('duty-cycle')
setCursorRecordsForwarder((records) => {
  parentPort?.postMessage({ type: 'cursor-records', records })
})

parentPort?.on('message', (event) => {
  const message = event?.data as { type?: string; request?: ExternalScanRequest } | undefined
  if (!message || message.type !== 'scan' || !message.request) return
  const request = message.request
  void (async () => {
    try {
      if (request.partialLookbackDays) {
        const partial = await loadExternalProviderUsageRecords({
          ...request.options,
          lookbackDays: request.partialLookbackDays,
          force: false
        })
        parentPort?.postMessage({ type: 'partial', records: partial })
      }
      const full = await loadExternalProviderUsageRecords(request.options)
      parentPort?.postMessage({ type: 'complete', records: full })
    } catch (error) {
      parentPort?.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })()
})
