/**
 * External-activity scan worker (Electron utilityProcess entry).
 *
 * The 90-day provider-log walk is tens of GB cold; run on the main process it
 * pegged the event loop for minutes (the 2026-07 launch stall). Process
 * isolation keeps Electron main responsive, while duty cycling keeps this
 * background job from monopolising a CPU core and the system page cache.
 *
 * Protocol (all messages are structured-clone JSON):
 *  in:  { type: 'scan',     request: ExternalScanRequest }
 *       { type: 'backfill', request: ExternalScanRequest }  one-time deep walk
 *  out: { type: 'partial',           records: UsageRecord[] }  cold short-window pass
 *       { type: 'cursor-records',    records: UsageRecord[] }  Cursor chunk upgrades
 *       { type: 'complete',          records: UsageRecord[] }  full-window result
 *       { type: 'backfill-complete', days: DailyUsageDays }    daily totals only
 *       { type: 'error',             message: string }
 *
 * The scan request MUST carry explicit externalFileCachePath/cursorCachePath:
 * this process has no electron `app`, so default userData resolution would
 * throw. The driver stamps them in (defaultExternalActivityCachePaths).
 *
 * WHY `backfill` RETURNS DAYS, NOT RECORDS: it walks a much wider window than
 * the 90-day pass, and the raw array crossing a process boundary is the exact
 * shape of the 2026-07 launch beachball. Bucketing to per-day/per-provider
 * totals here keeps the reply at a few thousand small entries whatever the
 * window. The caller hands it throwaway cache paths, so this pass never prunes
 * or rewrites the shared 90-day file cache.
 */
import {
  loadExternalProviderUsageRecords,
  setCursorRecordsForwarder,
  setExternalScanYieldMode,
  type ExternalScanRequest
} from '../ExternalProviderActivity'
import { buildDailyUsageTotals } from '../../shared/dailyUsageRollup'

const parentPort = process.parentPort

setExternalScanYieldMode('duty-cycle')
setCursorRecordsForwarder((records) => {
  parentPort?.postMessage({ type: 'cursor-records', records })
})

parentPort?.on('message', (event) => {
  const message = event?.data as { type?: string; request?: ExternalScanRequest } | undefined
  if (!message?.request) return
  const request = message.request

  if (message.type === 'backfill') {
    void (async () => {
      try {
        const records = await loadExternalProviderUsageRecords(request.options)
        parentPort?.postMessage({
          type: 'backfill-complete',
          days: buildDailyUsageTotals(records)
        })
      } catch (error) {
        parentPort?.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })()
    return
  }

  if (message.type !== 'scan') return
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
