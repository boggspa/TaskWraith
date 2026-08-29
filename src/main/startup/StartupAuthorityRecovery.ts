/**
 * Startup authority recovery: classification, bounded retry, and a state a
 * surface can render.
 *
 * Measured 2026-08-29, under contention on the shared workspace-lock authority
 * root, 2 of 12 launches booted with run and schedule recovery silently
 * disabled and the only signal was a console line. The app looked usable while
 * workspace mutation, provider admission, run recovery, and scheduling were all
 * fail-closed. This module exists so that state is (a) classified, (b) retried
 * when it is transient, and (c) legible to the person using the app.
 *
 * It deliberately owns no Electron or store types: the composition root injects
 * the open attempt and the deferred recovery, so this stays testable.
 */

import type {
  StartupAuthorityFailure,
  StartupAuthorityRecoveryState,
  StartupAuthorityStatus
} from '../../shared/startupAuthority'

export type {
  StartupAuthorityFailure,
  StartupAuthorityFailureClass,
  StartupAuthorityRecoveryState,
  StartupAuthorityStatus
} from '../../shared/startupAuthority'
export {
  describeStartupAuthorityState,
  startupAuthorityBlocksMutation,
  startupAuthorityHeadline,
  startupAuthorityNeedsAttention
} from '../../shared/startupAuthority'

export interface StartupAuthorityRecoveryTimer {
  cancel(): void
}

export interface StartupAuthorityRecoveryOptions {
  /** One attempt at bringing the authority up. Must use the real fencing path. */
  open: () => Promise<void>
  /**
   * Runs after a *later* attempt succeeds. `canRunBootOnlyRecovery` reports
   * whether the boot-only steps are still safe.
   */
  onRecovered?: (context: { canRunBootOnlyRecovery: boolean }) => void | Promise<void>
  /** False once anything has started that boot-only recovery would mis-settle. */
  canRunBootOnlyRecovery?: () => boolean
  onStateChange?: (state: StartupAuthorityRecoveryState) => void
  logError?: (message: string, error: unknown) => void
  now?: () => number
  schedule?: (run: () => void, delayMs: number) => StartupAuthorityRecoveryTimer
  /** Bounded on purpose: a wedged authority must not be retried forever. */
  maxAutomaticAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

const DEFAULT_MAX_AUTOMATIC_ATTEMPTS = 5
const DEFAULT_BASE_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

/**
 * Separates transient contention from a history or filesystem problem no amount
 * of retrying will fix. The strings matched here are the exact ones the
 * authority and its persistence raise.
 */
export function classifyStartupAuthorityFailure(error: unknown): StartupAuthorityFailure {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (
    name === 'WorkspaceLockAuthorityBusyError' ||
    /is committing a workspace-lock transition/i.test(message)
  ) {
    return { failureClass: 'authority_busy', retryable: true, message }
  }
  if (
    /WAL changed identity or revision/i.test(message) ||
    /byte fence changed/i.test(message) ||
    /changed while validating/i.test(message) ||
    /fence was replaced before/i.test(message) ||
    /generation changed repeatedly during startup/i.test(message) ||
    /WAL changed during torn-tail repair/i.test(message)
  ) {
    return { failureClass: 'wal_identity_conflict', retryable: true, message }
  }
  if (
    /WAL is corrupt/i.test(message) ||
    /checkpoint digest mismatch/i.test(message) ||
    /does not continue checkpoint/i.test(message) ||
    /no checkpoint to chain it to/i.test(message) ||
    /uncommitted torn tail/i.test(message) ||
    /shorter than its published checkpoint/i.test(message)
  ) {
    return { failureClass: 'wal_corrupt', retryable: false, message }
  }
  if (
    /EACCES|EPERM|EROFS|ENOSPC/i.test(message) ||
    /is not a real directory/i.test(message) ||
    /is not private/i.test(message)
  ) {
    return { failureClass: 'authority_root_unavailable', retryable: false, message }
  }
  return { failureClass: 'unknown', retryable: false, message }
}

export class StartupAuthorityRecoverySupervisor {
  private readonly options: Required<
    Pick<StartupAuthorityRecoveryOptions, 'open' | 'now' | 'schedule'>
  > &
    StartupAuthorityRecoveryOptions
  private readonly maxAutomaticAttempts: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private status: StartupAuthorityStatus = 'pending'
  private failure: StartupAuthorityFailure | null = null
  private attempts = 0
  private automaticAttempts = 0
  private nextRetryAtMs: number | null = null
  private lastAttemptAtMs: number | null = null
  private recoveredAfterRetry = false
  private bootRecoveryIncomplete = false
  private timer: StartupAuthorityRecoveryTimer | null = null
  private inFlight: Promise<StartupAuthorityRecoveryState> | null = null
  private disposed = false

  constructor(options: StartupAuthorityRecoveryOptions) {
    this.options = {
      now: () => Date.now(),
      schedule: (run, delayMs) => {
        const handle = setTimeout(run, delayMs)
        handle.unref?.()
        return { cancel: () => clearTimeout(handle) }
      },
      ...options
    }
    this.maxAutomaticAttempts = options.maxAutomaticAttempts ?? DEFAULT_MAX_AUTOMATIC_ATTEMPTS
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    if (this.maxAutomaticAttempts < 0 || !Number.isSafeInteger(this.maxAutomaticAttempts)) {
      throw new Error('Startup authority retry budget must be a non-negative integer.')
    }
  }

  state(): StartupAuthorityRecoveryState {
    return {
      status: this.status,
      failure: this.failure ? { ...this.failure } : null,
      attempts: this.attempts,
      nextRetryAtMs: this.nextRetryAtMs,
      lastAttemptAtMs: this.lastAttemptAtMs,
      recoveredAfterRetry: this.recoveredAfterRetry,
      bootRecoveryIncomplete: this.bootRecoveryIncomplete
    }
  }

  /** The boot attempt. Never schedules a retry before the window exists. */
  async runInitialAttempt(): Promise<StartupAuthorityRecoveryState> {
    await this.attempt(false)
    return this.state()
  }

  /**
   * Starts the bounded automatic retry schedule. Called once the window is up,
   * so a retry can never delay first paint.
   */
  startAutomaticRetries(): void {
    if (this.disposed || this.isAvailable()) return
    if (!this.failure?.retryable) return
    this.scheduleNextAttempt()
  }

  /** Explicit user action. Ignores the automatic budget but never runs concurrently. */
  async retryNow(): Promise<StartupAuthorityRecoveryState> {
    if (this.isAvailable()) return this.state()
    if (this.inFlight) return this.inFlight
    this.cancelTimer()
    await this.attempt(true)
    if (!this.isAvailable() && this.failure?.retryable) this.scheduleNextAttempt()
    return this.state()
  }

  /** Read through a method so control-flow narrowing cannot outlive an await. */
  private isAvailable(): boolean {
    return this.status === 'available'
  }

  dispose(): void {
    this.disposed = true
    this.cancelTimer()
  }

  private scheduleNextAttempt(): void {
    if (this.disposed || this.timer) return
    if (this.automaticAttempts >= this.maxAutomaticAttempts) {
      this.nextRetryAtMs = null
      this.emit()
      return
    }
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.automaticAttempts)
    this.nextRetryAtMs = this.options.now() + delay
    this.emit()
    this.timer = this.options.schedule(() => {
      this.timer = null
      this.automaticAttempts += 1
      void this.attempt(true).then(() => {
        if (!this.isAvailable() && this.failure?.retryable) this.scheduleNextAttempt()
      })
    }, delay)
  }

  private cancelTimer(): void {
    this.timer?.cancel()
    this.timer = null
    this.nextRetryAtMs = null
  }

  private attempt(isRetry: boolean): Promise<StartupAuthorityRecoveryState> {
    if (this.inFlight) return this.inFlight
    const run = (async (): Promise<StartupAuthorityRecoveryState> => {
      this.attempts += 1
      this.lastAttemptAtMs = this.options.now()
      if (isRetry) {
        this.status = 'retrying'
        this.emit()
      }
      try {
        await this.options.open()
      } catch (error) {
        this.failure = classifyStartupAuthorityFailure(error)
        this.status = this.failure.retryable ? 'degraded' : 'permanently_failed'
        this.options.logError?.(
          `[workspace-lock] startup recovery failed (${this.failure.failureClass}, ${
            this.failure.retryable ? 'retryable' : 'permanent'
          }); run and schedule recovery remain disabled`,
          error
        )
        this.emit()
        return this.state()
      }
      this.failure = null
      this.status = 'available'
      this.nextRetryAtMs = null
      if (isRetry) {
        this.recoveredAfterRetry = true
        const canRunBootOnlyRecovery = this.options.canRunBootOnlyRecovery?.() ?? false
        this.bootRecoveryIncomplete = !canRunBootOnlyRecovery
        try {
          await this.options.onRecovered?.({ canRunBootOnlyRecovery })
        } catch (error) {
          this.options.logError?.(
            '[workspace-lock] deferred startup recovery failed after a successful retry',
            error
          )
          this.bootRecoveryIncomplete = true
        }
      }
      this.emit()
      return this.state()
    })()
    this.inFlight = run
    return run.finally(() => {
      this.inFlight = null
    })
  }

  private emit(): void {
    try {
      this.options.onStateChange?.(this.state())
    } catch {
      // A projection listener must never be able to fail recovery.
    }
  }
}
