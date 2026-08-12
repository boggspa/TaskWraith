/**
 * User-visible lifecycle owner for the in-process TaskWraith Host.
 *
 * The controller serializes every transition, publishes bounded state, and
 * obtains a fresh production supervisor after a successful stop. It never
 * retries in the background: only app startup or an explicit user action can
 * call start().
 */

import {
  HOST_LIFECYCLE_ERROR_MAX_LENGTH,
  cloneHostLifecycleSnapshot,
  type HostLifecycleActionResult,
  type HostLifecycleReason,
  type HostLifecycleSnapshot
} from '../../shared/hostLifecycle'
import type { HostSupervisor } from './HostSupervisor'

export interface HostLifecycleControllerOptions {
  readonly createSupervisor: () => HostSupervisor
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
  private readonly createSupervisor: () => HostSupervisor
  private readonly now: () => number
  private readonly onOffline?: () => void
  private readonly log?: (line: string) => void
  private readonly listeners = new Set<HostLifecycleListener>()
  private supervisor: HostSupervisor | null = null
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

  subscribe(listener: HostLifecycleListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(reason: 'app-start' | 'user-start' = 'user-start'): Promise<HostLifecycleActionResult> {
    return this.enqueue(() => this.performStart(reason))
  }

  stop(reason: 'user-stop' = 'user-stop'): Promise<HostLifecycleActionResult> {
    return this.enqueue(() => this.performStop(reason))
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

  private async performStart(
    reason: 'app-start' | 'user-start'
  ): Promise<HostLifecycleActionResult> {
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

  private async performStop(reason: 'user-stop'): Promise<HostLifecycleActionResult> {
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
    this.state = {
      revision: this.state.revision + 1,
      phase,
      desired,
      reason,
      changedAt: this.timestamp(),
      ...(error ? { error } : {})
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
