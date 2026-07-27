import { resolve } from 'path'
import type { WorkspaceActivitySnapshot } from './store/types'
import {
  createEmptyWorkspaceActivitySnapshot,
  normalizeWorkspaceActivityDayCount
} from './WorkspaceActivityService'

/**
 * Main-process front door for workspace-activity hydration.
 *
 * Scanning a cold non-git workspace can mean thousands of stat calls; even
 * asynchronous filesystem calls create enough completion work to starve the
 * Electron main loop. This module therefore only owns a tiny cache and the
 * worker dispatch. It never calls WorkspaceActivityService's scanner itself.
 */
const WORKSPACE_ACTIVITY_CACHE_MAX_AGE_MS = 30_000

export interface WorkspaceActivityScanRequest {
  workspacePath: string
  dayCount: number
}

export type WorkspaceActivityScanDriver = (
  request: WorkspaceActivityScanRequest
) => Promise<WorkspaceActivitySnapshot>

type CachedSnapshot = {
  snapshot: WorkspaceActivitySnapshot
  fetchedAt: number
}

let workspaceActivityScanDriver: WorkspaceActivityScanDriver | null = null
let workspaceActivityUpdateListener: ((snapshot: WorkspaceActivitySnapshot) => void) | null = null

const snapshotCache = new Map<string, CachedSnapshot>()
const scansInFlight = new Map<string, Promise<void>>()

function cacheKey(workspacePath: string, dayCount: number): string {
  return `${resolve(workspacePath)}:${dayCount}`
}

export function setWorkspaceActivityScanDriver(driver: WorkspaceActivityScanDriver | null): void {
  workspaceActivityScanDriver = driver
}

export function setWorkspaceActivityUpdateListener(
  listener: ((snapshot: WorkspaceActivitySnapshot) => void) | null
): void {
  workspaceActivityUpdateListener = listener
}

function notifyWorkspaceActivityUpdated(snapshot: WorkspaceActivitySnapshot): void {
  try {
    workspaceActivityUpdateListener?.(snapshot)
  } catch {
    // A renderer notification must never poison a background scan.
  }
}

function startWorkspaceActivityScan(workspacePath: string, dayCount: number, key: string): void {
  if (scansInFlight.has(key)) return
  const driver = workspaceActivityScanDriver
  if (!driver) return

  const scan = driver({ workspacePath, dayCount })
    .then((snapshot) => {
      // Do not trust a worker payload's bookkeeping fields over the request;
      // the real workspace path and requested range are main-authoritative.
      const normalized: WorkspaceActivitySnapshot = {
        ...snapshot,
        workspacePath,
        dayCount
      }
      snapshotCache.set(key, { snapshot: normalized, fetchedAt: Date.now() })
      notifyWorkspaceActivityUpdated(normalized)
    })
    .catch((error) => {
      // Keep the last cache (or empty placeholder) visible. A later request
      // can retry rather than routing the scan back onto Electron main.
      console.warn('[workspace-activity] background scan failed:', error)
    })
    .finally(() => {
      if (scansInFlight.get(key) === scan) scansInFlight.delete(key)
    })

  scansInFlight.set(key, scan)
}

/**
 * Return cached workspace activity without waiting for a cold scan. A worker
 * refresh is started opportunistically; its result is delivered through the
 * update listener. This keeps every renderer IPC call bounded to cache work.
 */
export function getCachedWorkspaceActivitySnapshot(
  workspacePath: string,
  dayCountInput?: number
): WorkspaceActivitySnapshot {
  const dayCount = normalizeWorkspaceActivityDayCount(dayCountInput)
  const key = cacheKey(workspacePath, dayCount)
  const cached = snapshotCache.get(key)
  const fresh = cached && Date.now() - cached.fetchedAt <= WORKSPACE_ACTIVITY_CACHE_MAX_AGE_MS

  if (!fresh) startWorkspaceActivityScan(workspacePath, dayCount, key)
  return cached?.snapshot ?? createEmptyWorkspaceActivitySnapshot(workspacePath, dayCount)
}

/** Test seam: clear process-local cache and injected dependencies. */
export function resetWorkspaceActivityBackgroundForTests(): void {
  snapshotCache.clear()
  scansInFlight.clear()
  workspaceActivityScanDriver = null
  workspaceActivityUpdateListener = null
}
