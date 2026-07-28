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
  private readonly retryIntervalMs: number
  private restartRequested = false
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: UpdateRestartCoordinatorOptions) {
    this.updateService = options.updateService
    this.hasActiveWork = options.hasActiveWork
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
      this.stopRetrying()
      this.updateService.setRestartPending(false)
      return false
    }

    this.updateService.setRestartPending(true)
    if (this.hasActiveWork()) {
      this.startRetrying()
      return false
    }

    const restartStarted = this.updateService.quitAndInstall()
    this.restartRequested = false
    this.stopRetrying()
    this.updateService.setRestartPending(false)
    return restartStarted
  }

  dispose(): void {
    this.restartRequested = false
    this.stopRetrying()
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
