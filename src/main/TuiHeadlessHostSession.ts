/**
 * Process-lifecycle policy for a TUI-launched, windowless TaskWraith Host.
 *
 * This module is deliberately Electron-free. The composition root supplies
 * the final presentation and quit callbacks while this class owns only the
 * bounded parent/client/run lifetime decision.
 */

export const TUI_HEADLESS_HOST_ARG = '--taskwraith-headless-host'
export const TUI_HEADLESS_HOST_PARENT_ARG = '--taskwraith-headless-parent='

const DEFAULT_PARENT_POLL_MS = 1_000
const DEFAULT_ORPHAN_GRACE_MS = 3_000

export type TuiHeadlessHostLaunchPosture =
  | { kind: 'desktop' }
  | { kind: 'headless'; parentPid: number }
  | { kind: 'invalid'; error: string }

export interface TuiHeadlessHostSessionOptions {
  readonly argv?: readonly string[]
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly isProcessAlive?: (pid: number) => boolean
  readonly setInterval?: typeof globalThis.setInterval
  readonly clearInterval?: typeof globalThis.clearInterval
  readonly parentPollMs?: number
  readonly orphanGraceMs?: number
}

export interface TuiHeadlessHostMonitor {
  readonly getConnectedClientCount: () => number
  readonly hasActiveWork: () => boolean
  readonly quit: () => void
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function resolveTuiHeadlessHostLaunchPosture(
  argv: readonly string[] = process.argv
): TuiHeadlessHostLaunchPosture {
  if (!argv.includes(TUI_HEADLESS_HOST_ARG)) return { kind: 'desktop' }
  const parentArgs = argv.filter((value) => value.startsWith(TUI_HEADLESS_HOST_PARENT_ARG))
  if (parentArgs.length !== 1) {
    return { kind: 'invalid', error: 'Headless Host requires one parent process identity.' }
  }
  const parentPid = positiveInteger(parentArgs[0].slice(TUI_HEADLESS_HOST_PARENT_ARG.length))
  if (parentPid === null) {
    return { kind: 'invalid', error: 'Headless Host parent process identity is invalid.' }
  }
  return { kind: 'headless', parentPid }
}

/** A second headless launch request must never surface the primary app window. */
export function isTuiHeadlessHostLaunchRequest(argv: readonly string[]): boolean {
  return argv.includes(TUI_HEADLESS_HOST_ARG)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM'
  }
}

function boundedNonNegativeCount(read: () => number): number {
  try {
    const value = read()
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  } catch {
    // A failed occupancy read must retain the Host rather than manufacture idle.
    return 1
  }
}

function activeWork(read: () => boolean): boolean {
  try {
    return read() === true
  } catch {
    // A failed run-state read must retain the Host rather than kill active work.
    return true
  }
}

export class TuiHeadlessHostSession {
  readonly posture: TuiHeadlessHostLaunchPosture
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly scheduleInterval: typeof globalThis.setInterval
  private readonly cancelInterval: typeof globalThis.clearInterval
  private readonly parentPollMs: number
  private readonly orphanGraceMs: number
  private timer: ReturnType<typeof globalThis.setInterval> | null = null
  private parentMissingSince: number | null = null
  private promoted = false
  private quitRequested = false

  constructor(options: TuiHeadlessHostSessionOptions = {}) {
    this.posture = resolveTuiHeadlessHostLaunchPosture(options.argv)
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => Date.now())
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive
    this.scheduleInterval = options.setInterval ?? globalThis.setInterval
    this.cancelInterval = options.clearInterval ?? globalThis.clearInterval
    this.parentPollMs = options.parentPollMs ?? DEFAULT_PARENT_POLL_MS
    this.orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS
    if (this.posture.kind === 'invalid') throw new Error(this.posture.error)
  }

  get isHeadless(): boolean {
    return this.posture.kind === 'headless' && !this.promoted
  }

  get shouldSuppressMacPresentation(): boolean {
    return this.platform === 'darwin' && this.isHeadless
  }

  /**
   * Headless duplicate launches are ignored. An ordinary app launch promotes
   * the existing process into the normal desktop without restarting Host.
   */
  shouldPresentForSecondInstance(argv: readonly string[]): boolean {
    if (isTuiHeadlessHostLaunchRequest(argv)) return false
    this.promoteToDesktop()
    return true
  }

  promoteToDesktop(): void {
    if (this.promoted) return
    this.promoted = true
    this.dispose()
  }

  startMonitoring(monitor: TuiHeadlessHostMonitor): void {
    if (!this.isHeadless || this.timer || this.posture.kind !== 'headless') return
    const parentPid = this.posture.parentPid
    const tick = (): void => {
      if (!this.isHeadless || this.quitRequested) return
      if (this.isProcessAlive(parentPid)) {
        this.parentMissingSince = null
        return
      }
      const now = this.now()
      this.parentMissingSince ??= now
      if (now - this.parentMissingSince < this.orphanGraceMs) return
      if (boundedNonNegativeCount(monitor.getConnectedClientCount) > 0) return
      if (activeWork(monitor.hasActiveWork)) return
      this.quitRequested = true
      this.dispose()
      monitor.quit()
    }
    this.timer = this.scheduleInterval(tick, this.parentPollMs)
    this.timer.unref?.()
    tick()
  }

  dispose(): void {
    if (!this.timer) return
    this.cancelInterval(this.timer)
    this.timer = null
  }
}
