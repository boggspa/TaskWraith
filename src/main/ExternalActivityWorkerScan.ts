/**
 * Main-process driver that runs the external-activity scan in an Electron
 * utilityProcess (out/main/externalActivityWorker.js) instead of on the main
 * event loop. One child per scan request: spawn, scan, exit — self-healing
 * and leak-proof. A worker failure leaves the cache empty/stale; it never
 * permits the same scan to run on Electron main.
 */
import { utilityProcess } from 'electron'
import { constants as osConstants, setPriority } from 'os'
import type { UsageRecord } from './store/types'
import type { DailyUsageDays } from '../shared/dailyUsageRollup'
import {
  applyCursorUsageRecords,
  defaultExternalActivityCachePaths,
  type ExternalScanDriver,
  type ExternalScanRequest
} from './ExternalProviderActivity'

/** A truly cold 90-day walk was measured at ~4 min; this is a hang backstop,
 * not a pace expectation. */
const WORKER_SCAN_TIMEOUT_MS = 30 * 60 * 1000

type WorkerMessage =
  | { type: 'partial'; records: UsageRecord[] }
  | { type: 'cursor-records'; records: UsageRecord[] }
  | { type: 'complete'; records: UsageRecord[] }
  | { type: 'error'; message: string }

type BackfillWorkerMessage =
  | { type: 'backfill-complete'; days: DailyUsageDays }
  | { type: 'cursor-records'; records: UsageRecord[] }
  | { type: 'error'; message: string }

export function createExternalActivityWorkerDriver(workerModulePath: string): ExternalScanDriver {
  return (request, onPartial) =>
    new Promise<UsageRecord[]>((resolve, reject) => {
      let child: Electron.UtilityProcess
      try {
        child = utilityProcess.fork(workerModulePath, [], {
          serviceName: 'taskwraith-external-activity-scan',
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
        // Best-effort: duty cycling still bounds contention on platforms that
        // reject priority changes for utility processes.
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
        finish(() => reject(new Error('External activity worker scan timed out.')))
      }, WORKER_SCAN_TIMEOUT_MS)
      timeout.unref?.()

      child.on('message', (raw: unknown) => {
        const message = raw as WorkerMessage
        switch (message?.type) {
          case 'partial':
            onPartial(message.records)
            break
          case 'cursor-records':
            // Chunked Cursor upgrades keep flowing while the rest of the
            // corpus is still scanning; merge them into main's cache now.
            applyCursorUsageRecords(message.records)
            break
          case 'complete':
            finish(() => resolve(message.records))
            break
          case 'error':
            finish(() => reject(new Error(message.message)))
            break
        }
      })
      child.on('exit', (code) => {
        finish(() =>
          reject(new Error(`External activity worker exited (code ${code}) before completing.`))
        )
      })

      child.postMessage({ type: 'scan', request: withExplicitCachePaths(request) })
    })
}

/**
 * Driver for the one-time deep backfill that seeds the daily rollup's tail.
 *
 * Deliberately NOT routed through `startExternalScan`: that front door returns
 * the in-flight scan and silently discards a joined caller's options, so a
 * backfill requested while any ordinary scan was running would be dropped with
 * no error and no retry.
 *
 * The caller supplies throwaway cache paths. `withExplicitCachePaths` only
 * fills in absent ones, so the shared 90-day file cache is never opened by this
 * pass — which is what stops the wide walk and the narrow walk from pruning
 * each other's entries and re-parsing the corpus on every alternation.
 *
 * The reply is per-day totals rather than records; see the worker header.
 */
export function createDailyUsageBackfillDriver(
  workerModulePath: string
): (request: ExternalScanRequest) => Promise<DailyUsageDays> {
  return (request) =>
    new Promise<DailyUsageDays>((resolve, reject) => {
      let child: Electron.UtilityProcess
      try {
        child = utilityProcess.fork(workerModulePath, [], {
          serviceName: 'taskwraith-daily-usage-backfill',
          // A wider window holds more records before the aggregation at the
          // scan's exit. This runs once, so the headroom costs nothing after.
          execArgv: ['--max-old-space-size=512']
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
        // Best-effort, as for the scan driver.
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
        finish(() => reject(new Error('Daily usage backfill worker timed out.')))
      }, WORKER_SCAN_TIMEOUT_MS)
      timeout.unref?.()

      child.on('message', (raw: unknown) => {
        const message = raw as BackfillWorkerMessage
        switch (message?.type) {
          case 'backfill-complete':
            finish(() => resolve(message.days ?? {}))
            break
          case 'error':
            finish(() => reject(new Error(message.message)))
            break
          // 'cursor-records' chunks are deliberately ignored: this pass's wide
          // Cursor set must not reach main's live 90-day cache.
        }
      })
      child.on('exit', (code) => {
        finish(() =>
          reject(new Error(`Daily usage backfill worker exited (code ${code}) before completing.`))
        )
      })

      child.postMessage({ type: 'backfill', request: withExplicitCachePaths(request) })
    })
}

/** The worker has no electron `app`, so default userData-relative cache paths
 * must be resolved here and travel with the request. */
function withExplicitCachePaths(request: ExternalScanRequest): ExternalScanRequest {
  const defaults = defaultExternalActivityCachePaths()
  return {
    ...request,
    options: {
      ...request.options,
      externalFileCachePath:
        request.options.externalFileCachePath ?? defaults.externalFileCachePath,
      cursorCachePath: request.options.cursorCachePath ?? defaults.cursorCachePath
    }
  }
}
