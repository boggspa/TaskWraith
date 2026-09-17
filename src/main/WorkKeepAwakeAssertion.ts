/**
 * Keep-awake assertion for LOCAL agent work.
 *
 * TaskWraith already holds a `powerSaveBlocker` while at least one iOS pairing
 * is listening (`remotePowerBlockerId` in `src/main/index.ts`). That one exists
 * so the Mac can keep serving a phone after the screen locks. It says nothing
 * about work the user started here: a long local round with no paired device
 * held no assertion at all, so an idle-sleep timer could suspend the app —
 * and the Host with it — halfway through a round the user was relying on.
 *
 * This is the second, deliberately INDEPENDENT assertion. Two ids in one
 * process is the whole point rather than a leak: either reason alone is
 * sufficient to stay awake, and neither may release the other's id. Unpairing
 * a phone must not drop a running round's protection, and a round finishing
 * must not drop a paired phone's.
 *
 * `prevent-app-suspension` is the correct strength, matching the remote
 * assertion. It blocks system/app suspension while explicitly ALLOWING the
 * display to sleep — the screen still goes dark and still locks on schedule, so
 * this costs no security and no backlight. What it buys is that the process
 * behind the lock screen keeps running.
 *
 * Deliberate non-goals:
 *   - It does not touch renderer background throttling. Letting presentation go
 *     semi-frozen while unfocused is stated policy (see the long note in
 *     `02-transcript-messages-fx.css`), and spending that saving here would buy
 *     nothing: the Host is a separate process and is not throttled by it.
 *   - It cannot defeat an OS-level ceiling. A closed lid, or a sleep the user
 *     asks for from the Apple menu, still sleeps the Mac. The setting's copy
 *     says so rather than implying a guarantee this cannot make.
 */

export type PowerSaveBlockerKind = 'prevent-app-suspension' | 'prevent-display-sleep'

/** The slice of Electron's `powerSaveBlocker` this needs, so tests can fake it. */
export interface PowerSaveBlockerApi {
  start(kind: PowerSaveBlockerKind): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface WorkKeepAwakeAssertionDeps {
  powerSaveBlocker: PowerSaveBlockerApi
  /** Optional sink for the one-line transitions; defaults to silence in tests. */
  log?: (message: string) => void
}

/**
 * Holds an assertion exactly while (the user opted in) AND (local work is
 * running). Both inputs are pushed in; this owns no policy about what counts as
 * work, so the caller can widen that definition without touching this file.
 */
export class WorkKeepAwakeAssertion {
  private readonly power: PowerSaveBlockerApi
  private readonly log: (message: string) => void
  private blockerId: number | null = null
  private enabled = false
  private activeWorkCount = 0

  constructor(deps: WorkKeepAwakeAssertionDeps) {
    this.power = deps.powerSaveBlocker
    this.log = deps.log ?? ((): void => {})
  }

  /** Settings → General opt-in. Turning it off releases immediately. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.reconcile(enabled ? 'setting enabled' : 'setting disabled')
  }

  /** Count of locally running runs/rounds. Anything above zero is "working". */
  setActiveWorkCount(count: number): void {
    const next = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
    if (this.activeWorkCount === next) return
    const wasWorking = this.activeWorkCount > 0
    this.activeWorkCount = next
    if (wasWorking === next > 0) return
    this.reconcile(next > 0 ? 'work started' : 'work settled')
  }

  /**
   * Re-arm after an event that can invalidate the underlying assertion without
   * telling us — a forced sleep, or a lock the OS handled its own way. The
   * remote assertion does the same on `lock-screen` and `resume`; an id that is
   * no longer started is silently useless, so recreate rather than trust it.
   */
  renew(reason: string): void {
    if (!this.shouldHold()) return
    this.releaseBlocker()
    this.blockerId = this.power.start('prevent-app-suspension')
    this.log(`[keep-awake] work power assertion renewed (${reason})`)
  }

  /** Unconditional release, for app quit. */
  release(): void {
    if (this.blockerId === null) return
    this.releaseBlocker()
    this.log('[keep-awake] work power assertion released (shutdown)')
  }

  /** True while this instance owns a live assertion. */
  isHeld(): boolean {
    return this.blockerId !== null && this.power.isStarted(this.blockerId)
  }

  private shouldHold(): boolean {
    return this.enabled && this.activeWorkCount > 0
  }

  private reconcile(reason: string): void {
    if (!this.shouldHold()) {
      if (this.blockerId !== null) {
        this.releaseBlocker()
        this.log(`[keep-awake] work power assertion released (${reason})`)
      }
      return
    }
    if (this.blockerId !== null && this.power.isStarted(this.blockerId)) return
    this.releaseBlocker()
    this.blockerId = this.power.start('prevent-app-suspension')
    this.log(`[keep-awake] work power assertion held (${reason})`)
  }

  /**
   * Stop only an id we started and that is still started. Calling `stop` on an
   * id the OS already invalidated is what turns a repair into a crash in some
   * Electron versions, and we must never stop an id we do not own — the remote
   * assertion's id lives in the same process.
   */
  private releaseBlocker(): void {
    if (this.blockerId === null) return
    if (this.power.isStarted(this.blockerId)) {
      this.power.stop(this.blockerId)
    }
    this.blockerId = null
  }
}

/** Default cadence. Work starting a second late costs nothing; the assertion
 *  only has to beat the system idle-sleep timer, measured in minutes. */
export const WORK_KEEP_AWAKE_POLL_INTERVAL_MS = 1_000

export interface WorkKeepAwakeMonitorDeps {
  /** True while any local run/round is in flight. */
  hasActiveWork: () => boolean
  /** The Settings → General opt-in, read fresh each tick (there is no
   *  settings-changed event in main, and `getSettings()` is mtime-cached). */
  isEnabled: () => boolean
  intervalMs?: number
  setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void
}

/**
 * Polls both inputs and pushes them into the assertion. Polling rather than
 * subscribing is deliberate: `RunManager` emits change events but the Ensemble
 * host-admission queue does not, so a subscription would hold the Mac awake
 * through run churn and then miss the queue draining. One cheap tick sees both.
 *
 * Returns its own stop function.
 */
export function startWorkKeepAwakeMonitor(
  assertion: WorkKeepAwakeAssertion,
  deps: WorkKeepAwakeMonitorDeps
): () => void {
  const start = deps.setInterval ?? setInterval
  const stop = deps.clearInterval ?? clearInterval
  let lastEnabled = false

  const tick = (): void => {
    // A failed read must never SUSPEND work we cannot see — the same
    // fail-safe direction `TuiHeadlessHostSession` takes for host retention.
    let working: boolean
    try {
      working = deps.hasActiveWork() === true
    } catch {
      working = true
    }
    // A failed settings read holds the previous answer instead. Defaulting it
    // either way would silently enable a feature the user turned off, or
    // disable one they are relying on, on a transient error.
    try {
      lastEnabled = deps.isEnabled() === true
    } catch {
      /* keep lastEnabled */
    }
    assertion.setEnabled(lastEnabled)
    assertion.setActiveWorkCount(working ? 1 : 0)
  }

  tick()
  const handle = start(tick, deps.intervalMs ?? WORK_KEEP_AWAKE_POLL_INTERVAL_MS)
  // Never keep the process alive on this timer's account.
  ;(handle as unknown as { unref?: () => void }).unref?.()
  return () => stop(handle)
}
