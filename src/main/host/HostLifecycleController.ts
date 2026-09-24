/**
 * User-visible lifecycle owner for the TaskWraith Host this app attaches to.
 *
 * The controller serializes every transition, publishes bounded state, and
 * obtains a fresh production supervisor after a successful stop. A Host is
 * brought up only by: app startup; an explicit user action (start, or the
 * restart action); a lease re-acquire (`ensure`), which re-verifies the Host
 * behind a running lifecycle and relaunches it if it exited, and never starts
 * one the user stopped or one whose start failed; and a confirmed poisoned
 * Desktop session (`restart('poison-restart')`, bounded by
 * `HostPoisonDetector`'s loop guard). Each goes through the same serial queue,
 * so nothing revives the Host after `stopSync()`. A failed start is never
 * retried in the background.
 */

import {
  HOST_LIFECYCLE_ERROR_MAX_LENGTH,
  cloneHostLifecycleHostIdentity,
  cloneHostLifecycleSnapshot,
  type HostLifecycleActionResult,
  type HostLifecycleHostIdentity,
  type HostLifecycleReason,
  type HostLifecycleSnapshot
} from '../../shared/hostLifecycle'
import type { HostSupervisor } from '../../host-runtime/HostSupervisor'

/**
 * What an external Host adapter adds to the in-process supervisor surface.
 * Both are optional: the in-process compatibility Host has neither.
 */
export interface HostLifecycleSupervisorExtras {
  /** The Host process this supervisor is attached to, once observed. */
  readonly hostIdentity?: HostLifecycleHostIdentity | null
  /**
   * Re-verify the running Host, relaunching it if it exited. Resolves whether
   * the Host behind the lifecycle changed.
   */
  ensureLive?(): Promise<boolean>
}

export type HostLifecycleSupervisor = HostSupervisor & HostLifecycleSupervisorExtras

type StartReason = 'app-start' | 'user-start' | 'user-restart' | 'poison-restart'
type StopReason = 'user-stop' | 'user-restart' | 'poison-restart'

export interface HostLifecycleControllerOptions {
  readonly createSupervisor: () => HostLifecycleSupervisor
  readonly now?: () => number
  /** Drops any authenticated Desktop socket after Host goes offline. */
  readonly onOffline?: () => void
  readonly log?: (line: string) => void
}

export type HostLifecycleListener = (snapshot: HostLifecycleSnapshot) => void

function boundedError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const normalized = raw.replace(/\s+/g, ' ').trim() || fallback
  return normalized.slice(0, HOST_LIFECYCLE_ERROR_MAX_LENGTH)
}

export class HostLifecycleController {
  private readonly createSupervisor: () => HostLifecycleSupervisor
  private readonly now: () => number
  private readonly onOffline?: () => void
  private readonly log?: (line: string) => void
  private readonly listeners = new Set<HostLifecycleListener>()
  private supervisor: HostLifecycleSupervisor | null = null
  private closing = false
  private operationTail: Promise<void> = Promise.resolve()
  private state: HostLifecycleSnapshot

  constructor(options: HostLifecycleControllerOptions) {
    if (!options || typeof options.createSupervisor !== 'function') {
      throw new Error('HostLifecycleController requires createSupervisor')
    }
    this.createSupervisor = options.createSupervisor
    this.now = options.now ?? (() => Date.now())
    this.onOffline = options.onOffline
    this.log = options.log
    this.state = {
      revision: 0,
      phase: 'stopped',
      desired: 'stopped',
      reason: 'not-started',
      changedAt: this.timestamp()
    }
  }

  getSnapshot(): HostLifecycleSnapshot {
    return cloneHostLifecycleSnapshot(this.state)
  }

  getConnectedClientCount(): number {
    const count = this.supervisor?.connectedClientCount
    return typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  }

  subscribe(listener: HostLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** True once `stopSync()` fenced the process exit: nothing may revive the Host. */
  get isClosing(): boolean {
    return this.closing
  }

  start(reason: 'app-start' | 'user-start' = 'user-start'): Promise<HostLifecycleActionResult> {
    return this.enqueue(() => this.performStart(reason))
  }

  stop(reason: 'user-stop' = 'user-stop'): Promise<HostLifecycleActionResult> {
    return this.enqueue(() => this.performStop(reason))
  }

  /**
   * Stop (with the adapter's verified fallback) then start a fresh supervisor,
   * as one serialized transition. Refused once `stopSync()` fenced the exit.
   */
  restart(
    reason: 'user-restart' | 'poison-restart' = 'user-restart',
    expectedHost?: HostLifecycleHostIdentity
  ): Promise<HostLifecycleActionResult> {
    return this.enqueue(() => this.performRestart(reason, expectedHost))
  }

  /**
   * Main lost its Host lease: re-verify the running Host and relaunch it if it
   * exited. A no-op for a Host that is still there, and refused unless the
   * lifecycle is running — a Host the user stopped, or whose start failed, is
   * never started from here.
   */
  ensure(reason: 'lease-reacquire' = 'lease-reacquire'): Promise<HostLifecycleActionResult> {
    return this.enqueue(() => this.performEnsure(reason))
  }

  /** Synchronous process-exit path. No later transition may revive Host. */
  stopSync(): void {
    this.closing = true
    const active = this.supervisor
    this.transition('stopping', 'stopped', 'app-quit')
    if (active) {
      try {
        active.stopSync()
      } catch (error) {
        this.log?.(`[host-lifecycle] stopSync failed: ${boundedError(error, 'unknown failure')}`)
      }
    }
    this.supervisor = null
    this.notifyOffline()
    this.transition('stopped', 'stopped', 'app-quit')
  }

  private enqueue(
    operation: () => Promise<HostLifecycleActionResult>
  ): Promise<HostLifecycleActionResult> {
    const result = this.operationTail.then(operation, operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async performRestart(
    reason: 'user-restart' | 'poison-restart',
    expectedHost?: HostLifecycleHostIdentity
  ): Promise<HostLifecycleActionResult> {
    if (this.closing) {
      return {
        ok: false,
        error: 'TaskWraith is shutting down; Host cannot be restarted.',
        snapshot: this.getSnapshot()
      }
    }
    if (
      reason === 'poison-restart' &&
      (this.state.phase !== 'running' ||
        this.state.desired !== 'running' ||
        (expectedHost &&
          (this.state.host?.pid !== expectedHost.pid ||
            this.state.host?.startedAt !== expectedHost.startedAt ||
            this.state.host?.hostId !== expectedHost.hostId)))
    ) {
      return {
        ok: false,
        error: 'The confirmed Host or lifecycle intent changed; automatic restart abandoned.',
        snapshot: this.getSnapshot()
      }
    }
    const stopped = await this.performStop(reason)
    if (!stopped.ok) return stopped
    return this.performStart(reason)
  }

  private async performEnsure(reason: 'lease-reacquire'): Promise<HostLifecycleActionResult> {
    if (this.closing) {
      return {
        ok: false,
        error: 'TaskWraith is shutting down; Host cannot be re-attached.',
        snapshot: this.getSnapshot()
      }
    }
    const active = this.supervisor
    if (!active || this.state.phase !== 'running' || this.state.desired !== 'running') {
      return {
        ok: false,
        error: 'Host is not running; only an explicit start brings it back.',
        snapshot: this.getSnapshot()
      }
    }
    if (typeof active.ensureLive !== 'function') {
      return { ok: true, snapshot: this.getSnapshot() }
    }
    try {
      const changed = await active.ensureLive()
      if (this.supervisor !== active) {
        return {
          ok: false,
          error: 'Host changed while it was being re-attached.',
          snapshot: this.getSnapshot()
        }
      }
      if (changed) this.transition('running', 'running', reason)
      return { ok: true, snapshot: this.getSnapshot() }
    } catch (error) {
      // Re-attachment can fail after a healthy shared Host answered (for
      // example, launch resolution failed). Detach our failed handle without
      // turning that local error into a shutdown of the shared process.
      try {
        active.stopSync()
      } catch (cleanupError) {
        this.log?.(
          `[host-lifecycle] failed re-attach cleanup error: ${boundedError(cleanupError, 'unknown failure')}`
        )
      }
      if (this.supervisor === active) this.supervisor = null
      this.notifyOffline()
      const message = boundedError(error, 'Host could not be re-attached.')
      this.transition('failed', 'running', 'start-failed', message)
      this.log?.(`[host-lifecycle] Host re-attach failed: ${message}`)
      return { ok: false, error: message, snapshot: this.getSnapshot() }
    }
  }

  private async performStart(reason: StartReason): Promise<HostLifecycleActionResult> {
    if (this.closing) {
      return {
        ok: false,
        error: 'TaskWraith is shutting down; Host cannot be started.',
        snapshot: this.getSnapshot()
      }
    }
    if (this.supervisor?.isRunning && this.state.phase === 'running') {
      return { ok: true, snapshot: this.getSnapshot() }
    }

    this.transition('starting', 'running', reason)
    let candidate = this.supervisor
    try {
      candidate ??= this.createSupervisor()
      this.supervisor = candidate
      await candidate.start()
      if (this.closing) {
        candidate.stopSync()
        this.supervisor = null
        this.notifyOffline()
        this.transition('stopped', 'stopped', 'app-quit')
        return {
          ok: false,
          error: 'TaskWraith shut down while Host was starting.',
          snapshot: this.getSnapshot()
        }
      }
      if (!candidate.isRunning) {
        throw new Error('Host supervisor returned without entering the running state.')
      }
      this.transition('running', 'running', reason)
      return { ok: true, snapshot: this.getSnapshot() }
    } catch (error) {
      if (candidate) {
        try {
          await candidate.stop()
        } catch (cleanupError) {
          this.log?.(
            `[host-lifecycle] failed-start cleanup error: ${boundedError(cleanupError, 'unknown failure')}`
          )
        }
      }
      this.supervisor = null
      this.notifyOffline()
      const message = boundedError(error, 'Host failed to start.')
      this.transition('failed', 'running', 'start-failed', message)
      this.log?.(`[host-lifecycle] Host start failed: ${message}`)
      return { ok: false, error: message, snapshot: this.getSnapshot() }
    }
  }

  private async performStop(reason: StopReason): Promise<HostLifecycleActionResult> {
    const active = this.supervisor
    this.transition('stopping', 'stopped', reason)
    if (!active) {
      this.notifyOffline()
      this.transition('stopped', 'stopped', reason)
      return { ok: true, snapshot: this.getSnapshot() }
    }

    try {
      await active.stop()
      // Production bootstrap purges its journal-directory registry on stop.
      // Discard this handle so the next explicit start obtains a fresh owner.
      this.supervisor = null
      this.notifyOffline()
      this.transition('stopped', 'stopped', reason)
      return { ok: true, snapshot: this.getSnapshot() }
    } catch (error) {
      // Keep the handle so a user can retry stop without constructing a second
      // potential owner for the same Host journal.
      this.supervisor = active
      this.notifyOffline()
      const message = boundedError(error, 'Host failed to stop.')
      this.transition('failed', 'stopped', 'stop-failed', message)
      this.log?.(`[host-lifecycle] Host stop failed: ${message}`)
      return { ok: false, error: message, snapshot: this.getSnapshot() }
    }
  }

  private transition(
    phase: HostLifecycleSnapshot['phase'],
    desired: HostLifecycleSnapshot['desired'],
    reason: HostLifecycleReason,
    error?: string
  ): void {
    const host = this.supervisor?.hostIdentity
    this.state = {
      revision: this.state.revision + 1,
      phase,
      desired,
      reason,
      changedAt: this.timestamp(),
      ...(error ? { error } : {}),
      // The Host behind the transition, while this lifecycle is attached to one.
      ...(host ? { host: cloneHostLifecycleHostIdentity(host) } : {})
    }
    for (const listener of this.listeners) {
      try {
        listener(this.getSnapshot())
      } catch (listenerError) {
        this.log?.(
          `[host-lifecycle] listener failed: ${boundedError(listenerError, 'unknown failure')}`
        )
      }
    }
  }

  private notifyOffline(): void {
    try {
      this.onOffline?.()
    } catch (error) {
      this.log?.(
        `[host-lifecycle] offline callback failed: ${boundedError(error, 'unknown failure')}`
      )
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }
}
