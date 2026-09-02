import type { HostLifecycleActionResult, HostLifecycleSnapshot } from '../shared/hostLifecycle'
import type { HostProjectionSnapshotResult } from './host/HostProjectionBroker'
import type { UpdateRestartBarrierResult } from './UpdateRestartCoordinator'

export interface UpdateRestartHostBarrierDeps {
  preparedExternalHost: { readonly result: { readonly kind: 'existing' | 'launched' } }
  hostLifecycle: {
    getSnapshot(): Pick<HostLifecycleSnapshot, 'phase'>
    stop(): Promise<HostLifecycleActionResult>
  }
  desktopHostBroker: { snapshot(): Promise<HostProjectionSnapshotResult> }
  log?: (line: string) => void
}

const MAX_REASON_DETAIL = 200

/**
 * Prepares the TaskWraith Host for an updater restart.
 *
 * A Host this app launched is stopped once it has no running runs, so the
 * installer never races a supervised child. A Host this app merely adopted
 * (a TUI or another explicit user flow owns it) is never stopped: the restart
 * waits for its running runs and then proceeds without touching it. Every
 * "not yet" carries the reason so the user can see what the restart is
 * waiting on, and a forced restart skips the running-run wait.
 */
export function createUpdateRestartHostBarrier(
  deps: UpdateRestartHostBarrierDeps
): (request: { force: boolean }) => Promise<UpdateRestartBarrierResult> {
  const log = deps.log ?? (() => {})
  return async ({ force }) => {
    const owned = deps.preparedExternalHost.result.kind === 'launched'
    if (owned && deps.hostLifecycle.getSnapshot().phase === 'stopped') return { ready: true }

    const projected = await deps.desktopHostBroker.snapshot()
    if (!projected.ok) {
      if (!owned) {
        log(
          `[UpdateRestart] adopted Host status unavailable (${detail(
            projected.error
          )}); leaving it running`
        )
        return { ready: true }
      }
      if (!force) {
        return {
          ready: false,
          reason: `TaskWraith Host status is unavailable (${detail(projected.error)})`
        }
      }
    } else {
      const running = projected.snapshot.runs.filter(
        (run) => run.providerOutcome === 'running'
      ).length
      if (running > 0 && !force) {
        return {
          ready: false,
          reason: `${running} TaskWraith Host run${running === 1 ? '' : 's'} still running`
        }
      }
    }

    if (!owned) {
      log('[UpdateRestart] Host is owned by another process; restarting without stopping it')
      return { ready: true }
    }
    const stopped = await deps.hostLifecycle.stop()
    if (!stopped.ok) {
      return {
        ready: false,
        reason: `TaskWraith Host could not be stopped: ${detail(stopped.error)}`
      }
    }
    return { ready: true }
  }
}

function detail(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return 'unknown error'
  return normalized.length > MAX_REASON_DETAIL
    ? `${normalized.slice(0, MAX_REASON_DETAIL - 1)}…`
    : normalized
}
