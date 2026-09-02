import type { UpdateStateSnapshot } from './UpdateService'

/** How often a user-requested restart rechecks for live TaskWraith work. */
export const UPDATE_RESTART_RETRY_MS = 1_000

/**
 * How long a user-requested restart may wait for live work or the Host before
 * it stops waiting. The downloaded update is kept; the user is shown what was
 * blocking the restart and can queue it again or restart anyway.
 */
export const UPDATE_RESTART_DEFERRAL_TIMEOUT_MS = 30 * 60 * 1000

export interface UpdateRestartDeferral {
  /** What the restart is (or was) waiting on, in user-facing words. */
  reason: string
  /** ISO timestamp of when the wait began. */
  since: string
  /** True once the wait exceeded the deferral timeout and was abandoned. */
  expired: boolean
}

export type UpdateRestartBarrierResult = { ready: true } | { ready: false; reason: string }

export interface UpdateRestartRequest {
  /** Restart without waiting for live work or running Host runs. */
  force?: boolean
}

export interface UpdateRestartService {
  snapshot(): Pick<UpdateStateSnapshot, 'status'>
  setRestartPending(pending: boolean, deferral?: UpdateRestartDeferral): void
  quitAndInstall(): boolean
}

export interface UpdateRestartCoordinatorOptions {
  updateService: UpdateRestartService
  /** Names the live work a restart should wait for, or null when idle. */
  activeWorkReason: () => string | null
  /** Async Host/update preparation. `ready` means installer handoff may proceed. */
  beforeRestart?: (request: { force: boolean }) => Promise<UpdateRestartBarrierResult>
  retryIntervalMs?: number
  deferralTimeoutMs?: number
  now?: () => number
  log?: (line: string) => void
}

const DEFAULT_BARRIER_REASON = 'Preparing the TaskWraith Host for restart'

/**
 * Defers a user-requested updater restart until every live TaskWraith run and
 * task has settled. The timer exists only while a downloaded update is waiting
 * on active work, and is intentionally unref'd so it cannot keep the process
 * alive on its own. Every wait is published with its reason, gives up after
 * `deferralTimeoutMs` instead of silently waiting forever, and a forced
 * request skips the wait entirely.
 */
export class UpdateRestartCoordinator {
  private readonly updateService: UpdateRestartService
  private readonly activeWorkReason: () => string | null
  private readonly beforeRestart?: (request: {
    force: boolean
  }) => Promise<UpdateRestartBarrierResult>
  private readonly retryIntervalMs: number
  private readonly deferralTimeoutMs: number
  private readonly now: () => number
  private readonly log: (line: string) => void
  private restartRequested = false
  private force = false
  private deferredSince: number | null = null
  private barrierReason: string | null = null
  private restartBarrierSatisfied = false
  private barrierInFlight: Promise<void> | null = null
  private barrierEpoch = 0
  private retryTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: UpdateRestartCoordinatorOptions) {
    this.updateService = options.updateService
    this.activeWorkReason = options.activeWorkReason
    this.beforeRestart = options.beforeRestart
    this.retryIntervalMs = options.retryIntervalMs ?? UPDATE_RESTART_RETRY_MS
    this.deferralTimeoutMs = options.deferralTimeoutMs ?? UPDATE_RESTART_DEFERRAL_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
  }

  /**
   * Request installation after the update download finishes. Returns true only
   * when the restart was initiated immediately; otherwise it stays pending.
   */
  requestRestartWhenIdle(request: UpdateRestartRequest = {}): boolean {
    const status = this.updateService.snapshot().status
    if (status !== 'downloading' && status !== 'downloaded') return false
    this.restartRequested = true
    this.force = request.force === true
    this.restartBarrierSatisfied = false
    this.deferredSince = null
    this.barrierReason = null
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
      this.reset()
      this.updateService.setRestartPending(false)
      return false
    }

    const workReason = this.force ? null : this.activeWorkReason()
    if (workReason) return this.defer(workReason)

    if (this.beforeRestart && !this.restartBarrierSatisfied) {
      this.startBarrier()
      return this.defer(this.barrierReason ?? DEFAULT_BARRIER_REASON)
    }

    const restartStarted = this.updateService.quitAndInstall()
    this.reset()
    this.updateService.setRestartPending(false)
    return restartStarted
  }

  dispose(): void {
    this.reset()
    this.barrierInFlight = null
  }

  /**
   * Publish why the restart is waiting and keep polling, or abandon the wait
   * once it has outlived the deferral timeout. Abandoning keeps the download
   * and reports the last reason so the user can decide what to do.
   */
  private defer(reason: string): boolean {
    const now = this.now()
    if (this.deferredSince === null) this.deferredSince = now
    const since = new Date(this.deferredSince).toISOString()
    if (now - this.deferredSince >= this.deferralTimeoutMs) {
      this.log(
        `[UpdateRestart] stopped waiting after ${Math.round(
          (now - this.deferredSince) / 60_000
        )} min: ${reason}`
      )
      this.reset()
      this.updateService.setRestartPending(false, { reason, since, expired: true })
      return false
    }
    this.updateService.setRestartPending(true, { reason, since, expired: false })
    this.startRetrying()
    return false
  }

  private reset(): void {
    this.restartRequested = false
    this.force = false
    this.deferredSince = null
    this.barrierReason = null
    this.restartBarrierSatisfied = false
    this.barrierEpoch += 1
    this.stopRetrying()
  }

  private startBarrier(): void {
    if (this.barrierInFlight || !this.beforeRestart) return
    const epoch = this.barrierEpoch
    const operation = Promise.resolve()
      .then(() => this.beforeRestart!({ force: this.force }))
      .then(
        (result) => {
          if (this.barrierInFlight !== operation) return
          this.barrierInFlight = null
          if (!this.restartRequested || epoch !== this.barrierEpoch) return
          if (result.ready) {
            this.restartBarrierSatisfied = true
            this.tryRestart()
            return
          }
          // The next retry tick republishes this reason and re-runs the barrier.
          this.barrierReason = result.reason
        },
        (error) => {
          if (this.barrierInFlight !== operation) return
          this.barrierInFlight = null
          if (!this.restartRequested || epoch !== this.barrierEpoch) return
          this.barrierReason = `Host preparation failed: ${
            error instanceof Error ? error.message : String(error)
          }`
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
