export interface LateBackgroundRefreshCoordinatorOptions {
  isBusy: () => boolean
  runFollowup: () => Promise<void>
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
  retryDelayMs?: number
  cooldownMs?: number
}

type Phase = 'idle' | 'queued' | 'running' | 'cooldown' | 'disposed'

/**
 * Coalesces late background reads into one bounded follow-up refresh.
 *
 * The follow-up remains claimed through its cooldown, so several providers
 * resolving late cannot each start another refresh. Callers must also make the
 * follow-up itself non-notifying; otherwise a permanently slow source can turn
 * a UI deadline into an endless retry loop.
 */
export class LateBackgroundRefreshCoordinator {
  private phase: Phase = 'idle'
  private timer: unknown = null
  private readonly retryDelayMs: number
  private readonly cooldownMs: number

  constructor(private readonly options: LateBackgroundRefreshCoordinatorOptions) {
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250)
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000)
  }

  queue(): boolean {
    if (this.phase !== 'idle') return false
    this.phase = 'queued'
    this.schedulePoll(this.retryDelayMs)
    return true
  }

  dispose(): void {
    if (this.phase === 'disposed') return
    this.phase = 'disposed'
    if (this.timer !== null) {
      this.options.cancel(this.timer)
      this.timer = null
    }
  }

  private schedulePoll(delayMs: number): void {
    this.timer = this.options.schedule(() => {
      this.timer = null
      this.poll()
    }, delayMs)
  }

  private poll(): void {
    if (this.phase !== 'queued') return
    if (this.options.isBusy()) {
      this.schedulePoll(this.retryDelayMs)
      return
    }

    this.phase = 'running'
    void Promise.resolve()
      .then(() => this.options.runFollowup())
      .catch(() => {})
      .finally(() => this.enterCooldown())
  }

  private enterCooldown(): void {
    if (this.phase !== 'running') return
    if (this.cooldownMs === 0) {
      this.phase = 'idle'
      return
    }
    this.phase = 'cooldown'
    this.timer = this.options.schedule(() => {
      this.timer = null
      if (this.phase === 'cooldown') this.phase = 'idle'
    }, this.cooldownMs)
  }
}
