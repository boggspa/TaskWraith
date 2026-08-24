import type { UpdateStateSnapshot } from './UpdateService'

/** How often a user-requested restart rechecks for live TaskWraith work. */
export const UPDATE_RESTART_RETRY_MS = 1_000

export interface UpdateRestartService {
  snapshot(): Pick<UpdateStateSnapshot, 'status'>
  setRestartPending(pending: boolean): void
  quitAndInstall(): boolean
}

export interface UpdateRestartCoordinatorOptions {
  updateService: UpdateRestartService
  hasActiveWork: () => boolean
  /** Async Host/update preparation. True means installer handoff may proceed. */
  beforeRestart?: () => Promise<boolean>
  retryIntervalMs?: number
}

/**
 * Defers a user-requested updater restart until every live TaskWraith run and
 * task has settled. The timer exists only while a downloaded update is waiting
 * on active work, and is intentionally unref'd so it cannot keep the process
 * alive on its own.
 */
export class UpdateRestartCoordinator {
  private readonly updateService: UpdateRestartService
  private readonly hasActiveWork: () => boolean
  private readonly beforeRestart?: () => Promise<boolean>
  private readonly retryIntervalMs: number
  private restartRequested = false
  private restartBarrierSatisfied = false
  private barrierInFlight: Promise<void> | null = null
  private barrierEpoch = 0
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: UpdateRestartCoordinatorOptions) {
    this.updateService = options.updateService
    this.hasActiveWork = options.hasActiveWork
    this.beforeRestart = options.beforeRestart
    this.retryIntervalMs = options.retryIntervalMs ?? UPDATE_RESTART_RETRY_MS
  }

  /**
   * Request installation after the update download finishes. Returns true only
   * when the restart was initiated immediately; otherwise it stays pending.
   */
  requestRestartWhenIdle(): boolean {
    const status = this.updateService.snapshot().status
    if (status !== 'downloading' && status !== 'downloaded') return false
    this.restartRequested = true
    this.restartBarrierSatisfied = false
    return this.tryRestart()
  }

  /** Re-evaluate a deferred restart. Safe to call from any lifecycle event. */
  tryRestart(): boolean {
    if (!this.restartRequested) return false

    const status = this.updateService.snapshot().status
    if (status === 'downloading') {
      this.startRetrying()
      return false
    }
    if (status !== 'downloaded') {
      this.restartRequested = false
      this.restartBarrierSatisfied = false
      this.barrierEpoch += 1
      this.stopRetrying()
      this.updateService.setRestartPending(false)
      return false
    }

    this.updateService.setRestartPending(true)
    if (this.hasActiveWork()) {
      this.startRetrying()
      return false
    }

    if (this.beforeRestart && !this.restartBarrierSatisfied) {
      this.startBarrier()
      this.startRetrying()
      return false
    }

    const restartStarted = this.updateService.quitAndInstall()
    this.restartRequested = false
    this.restartBarrierSatisfied = false
    this.barrierEpoch += 1
    this.stopRetrying()
    this.updateService.setRestartPending(false)
    return restartStarted
  }

  dispose(): void {
    this.restartRequested = false
    this.restartBarrierSatisfied = false
    this.barrierEpoch += 1
    this.barrierInFlight = null
    this.stopRetrying()
  }

  private startBarrier(): void {
    if (this.barrierInFlight || !this.beforeRestart) return
    const epoch = this.barrierEpoch
    const operation = Promise.resolve()
      .then(() => this.beforeRestart!())
      .then(
        (ready) => {
          if (this.barrierInFlight !== operation) return
          this.barrierInFlight = null
          if (!this.restartRequested || epoch !== this.barrierEpoch || ready !== true) return
          this.restartBarrierSatisfied = true
          this.tryRestart()
        },
        () => {
          if (this.barrierInFlight === operation) this.barrierInFlight = null
        }
      )
    this.barrierInFlight = operation
  }

  private startRetrying(): void {
    if (this.retryTimer) return
    this.retryTimer = setInterval(() => this.tryRestart(), this.retryIntervalMs)
    ;(this.retryTimer as unknown as { unref?: () => void }).unref?.()
  }

  private stopRetrying(): void {
    if (!this.retryTimer) return
    clearInterval(this.retryTimer)
    this.retryTimer = null
  }
}
