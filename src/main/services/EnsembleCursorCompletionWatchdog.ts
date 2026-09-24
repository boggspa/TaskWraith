import { isActiveRunSessionStatus, type RunSession } from '../RunManager'
import {
  CURSOR_CONTEXT_PRESSURE_QUIET_MS,
  decideCursorContextPressureRecovery
} from './CursorContextPressureRecovery'

/**
 * Cursor's stream transport normally emits a provider-agnostic `result` line
 * before its child closes.  If the child exits (or the stream becomes
 * unobservable) without that line, EnsembleOrchestrator's completion promise
 * otherwise has no terminal path and the whole round can wait forever.
 *
 * A known-live Cursor process gets a longer quiescence window than an
 * unobservable transport. A model may legitimately spend a long time
 * reasoning, and active tool/approval work keeps the watchdog alive without a
 * deadline. Once the exact child has been silent beyond the bounded
 * quiescence window and has no active tool/approval, the run fails closed so
 * an OS-alive hung process cannot strand the round forever.
 *
 * A seat whose child has not spawned yet is a third case entirely. Cursor
 * installs transient `.cursor/` policy under a workspace-wide lease, and
 * `CursorWorkspaceConfigLease` fairly queues an incompatible posture behind
 * the current holder for the whole of that holder's turn. That queue wait is
 * setup latency, not a silent transport, so it gets its own bounded startup
 * window rather than the post-stream silence deadline.
 *
 * Separately, critical context pressure with stalled token growth triggers a
 * discreet Path-B recovery (host prune + same-seat respawn) instead of a
 * user-visible failed seat.
 */

export const CURSOR_COMPLETION_WATCHDOG_TIMEOUT_MS = 30_000
export const CURSOR_COMPLETION_WATCHDOG_POLL_MS = 1_000
export const CURSOR_COMPLETION_WATCHDOG_ALIVE_QUIESCENCE_MS = 180_000
/**
 * Bounded window for a seat that has not spawned its child yet. Sized from the
 * queue it has to absorb, not from spawn latency: a queued seat waits out the
 * whole of the holder's turn, and over 40 local Cursor runs measured
 * 2026-09-03 those turns ran p50 3m44s, p90 9m45s, p95 11m31s. Normal spawn
 * latency by contrast is 2-13s, so nothing legitimate sits in the gap between
 * the two. Wide enough for a p95 holder ahead in the queue, still a hard bound
 * so a genuinely wedged setup cannot strand a seat forever. A round the user
 * cancels aborts the lease wait immediately and never reaches this window.
 */
export const CURSOR_COMPLETION_WATCHDOG_STARTUP_MS = 900_000

export type CursorTransportLiveness = 'alive' | 'starting' | 'exited' | 'unknown'

/**
 * Read only the exact RunManager-owned child handle. An untracked session is
 * deliberately `unknown`; the watchdog decides whether that unknown state has
 * remained silent long enough to fail the run closed.
 *
 * A session RunManager still holds as active, with no child attached, is
 * `starting` rather than `unknown`. The two used to collapse together, which
 * charged every pre-spawn seat the silence deadline meant for an unobservable
 * transport and killed seats that were only queued for the workspace-config
 * lease.
 */
export function cursorTransportLivenessFromRunSession(
  session: RunSession | undefined
): CursorTransportLiveness {
  if (!session) return 'unknown'
  if (!isActiveRunSessionStatus(session.status)) return 'exited'
  const process = session.process as { exitCode?: number | null; killed?: boolean } | undefined
  if (!process) return 'starting'
  return typeof process.exitCode === 'number' || process.killed === true ? 'exited' : 'alive'
}

export type CursorCompletionWatchdogDecision =
  | { readonly kind: 'stop' }
  | { readonly kind: 'wait'; readonly delayMs: number }
  | { readonly kind: 'recover_context'; readonly reason: string }
  | { readonly kind: 'recover_startup'; readonly reason: string }
  | { readonly kind: 'fail'; readonly reason: string }

export function decideCursorCompletionWatchdog(input: {
  readonly active: boolean
  readonly nowMs: number
  readonly lastActivityAt: number
  readonly hasActiveToolOrApproval: boolean
  readonly transportLiveness: CursorTransportLiveness
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly aliveQuiescenceMs?: number
  readonly startupMs?: number
  readonly contextPressurePercent?: number | null
  readonly lastTokenGrowthAt?: number | null
  readonly contextPressureQuietMs?: number
}): CursorCompletionWatchdogDecision {
  if (!input.active) return { kind: 'stop' }

  const timeoutMs = input.timeoutMs ?? CURSOR_COMPLETION_WATCHDOG_TIMEOUT_MS
  const pollMs = input.pollMs ?? CURSOR_COMPLETION_WATCHDOG_POLL_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Cursor completion watchdog timeout must be positive.')
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('Cursor completion watchdog poll interval must be positive.')
  }
  const aliveQuiescenceMs =
    input.aliveQuiescenceMs ?? CURSOR_COMPLETION_WATCHDOG_ALIVE_QUIESCENCE_MS
  if (!Number.isFinite(aliveQuiescenceMs) || aliveQuiescenceMs <= 0) {
    throw new Error('Cursor completion watchdog alive quiescence must be positive.')
  }
  const startupMs = input.startupMs ?? CURSOR_COMPLETION_WATCHDOG_STARTUP_MS
  if (!Number.isFinite(startupMs) || startupMs <= 0) {
    throw new Error('Cursor completion watchdog startup window must be positive.')
  }

  if (input.transportLiveness === 'exited') {
    return {
      kind: 'fail',
      reason: 'Cursor transport exited without publishing a terminal result.'
    }
  }

  // A pending approval or provider tool is real work, not silent transport.
  // Keep waiting even when the provider does not emit another stream event
  // until the approval/tool result arrives.
  if (input.hasActiveToolOrApproval) return { kind: 'wait', delayMs: pollMs }

  // Nothing has spawned yet, so no provider output can arrive to extend the
  // deadline: judging this window by the silence timeout kills a seat that is
  // only waiting its turn on the workspace-config lease. Bounded all the same,
  // because a setup that never spawns must not hold the round forever.
  if (input.transportLiveness === 'starting') {
    const startupRemainingMs = Math.max(0, input.lastActivityAt + startupMs - input.nowMs)
    if (startupRemainingMs > 0) {
      return { kind: 'wait', delayMs: Math.min(pollMs, startupRemainingMs) }
    }
    return {
      kind: 'recover_startup',
      reason:
        `Cursor transport did not start within ${Math.round(startupMs / 1000)}s; ` +
        'another Cursor seat may still hold the workspace configuration lease.'
    }
  }

  const pressureRecovery = decideCursorContextPressureRecovery({
    transportLiveness: input.transportLiveness,
    hasActiveToolOrApproval: false,
    contextPressurePercent: input.contextPressurePercent,
    nowMs: input.nowMs,
    lastTokenGrowthAt: input.lastTokenGrowthAt,
    quietMs: input.contextPressureQuietMs ?? CURSOR_CONTEXT_PRESSURE_QUIET_MS
  })
  if (pressureRecovery.kind === 'recover') {
    return { kind: 'recover_context', reason: pressureRecovery.reason }
  }

  const remainingMs = Math.max(0, input.lastActivityAt + timeoutMs - input.nowMs)
  if (remainingMs > 0) {
    return { kind: 'wait', delayMs: Math.min(pollMs, remainingMs) }
  }

  // A known-live child may simply be doing model work. Give it a longer,
  // explicit quiescence window than an unobservable transport, but do not let
  // a hung child hold the round forever. Provider output calls `touch`, so
  // genuine streamed model work continually extends this deadline.
  if (input.transportLiveness === 'alive') {
    const aliveRemainingMs = Math.max(0, input.lastActivityAt + aliveQuiescenceMs - input.nowMs)
    if (aliveRemainingMs > 0) {
      return { kind: 'wait', delayMs: Math.min(pollMs, aliveRemainingMs) }
    }
    return {
      kind: 'fail',
      reason: 'Cursor transport remained alive but quiescent without publishing a terminal result.'
    }
  }

  return {
    kind: 'fail',
    reason: 'Cursor transport became silent without publishing a terminal result.'
  }
}

export interface CursorCompletionWatchdogOptions {
  runId: string
  now?: () => number
  timeoutMs?: number
  pollMs?: number
  aliveQuiescenceMs?: number
  startupMs?: number
  contextPressureQuietMs?: number
  hasActiveToolOrApproval: () => boolean
  transportLiveness: () => CursorTransportLiveness
  /** Latest live occupancy percent when known; null/undefined skips pressure recovery. */
  contextPressurePercent?: () => number | null | undefined
  isActive: () => boolean
  onMissingTerminal: (reason: string) => void
  /** Discreet Path-B recovery — must not surface a failed seat to the user. */
  onContextPressureRecovery?: (reason: string) => void
  /**
   * Discreet recovery for a seat whose transport never started. Nothing was
   * produced, so a re-dispatch loses no work and must not surface a failed
   * seat either.
   */
  onStartupRecovery?: (reason: string) => void
}

type WatchdogEntry = Omit<CursorCompletionWatchdogOptions, 'now'> & {
  now: () => number
  lastActivityAt: number
  lastTokenGrowthAt: number
  lastEstimatedTokens: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * Small per-run timer owner. `stop` is safe to call repeatedly and the entry
 * is removed before invoking the terminal callback, so provider exit,
 * cancellation, and watchdog races cannot fire the callback twice.
 */
export class EnsembleCursorCompletionWatchdog {
  private entries = new Map<string, WatchdogEntry>()

  start(options: CursorCompletionWatchdogOptions): void {
    this.stop(options.runId)
    const now = options.now ?? Date.now
    const startedAt = now()
    const entry: WatchdogEntry = {
      ...options,
      now,
      lastActivityAt: startedAt,
      lastTokenGrowthAt: startedAt,
      lastEstimatedTokens: 0
    }
    this.entries.set(options.runId, entry)
    this.schedule(entry, this.initialDelay(entry))
  }

  touch(runId: string): void {
    const entry = this.entries.get(runId)
    if (!entry) return
    entry.lastActivityAt = entry.now()
    this.schedule(entry, entry.timeoutMs ?? CURSOR_COMPLETION_WATCHDOG_TIMEOUT_MS)
  }

  /**
   * Record estimated/authoritative token growth for pressure-quiet detection.
   * Growth resets the quiet clock; identical samples leave it alone.
   */
  noteTokenSample(runId: string, estimatedTokens: number): void {
    const entry = this.entries.get(runId)
    if (!entry) return
    const tokens =
      typeof estimatedTokens === 'number' && Number.isFinite(estimatedTokens)
        ? Math.max(0, estimatedTokens)
        : 0
    if (tokens > entry.lastEstimatedTokens) {
      entry.lastEstimatedTokens = tokens
      entry.lastTokenGrowthAt = entry.now()
    }
  }

  stop(runId: string): void {
    const entry = this.entries.get(runId)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(runId)
  }

  has(runId: string): boolean {
    return this.entries.has(runId)
  }

  private initialDelay(entry: WatchdogEntry): number {
    return entry.timeoutMs ?? CURSOR_COMPLETION_WATCHDOG_TIMEOUT_MS
  }

  private schedule(entry: WatchdogEntry, delayMs: number): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.check(entry), Math.max(1, delayMs))
  }

  private check(entry: WatchdogEntry): void {
    if (this.entries.get(entry.runId) !== entry) return
    entry.timer = undefined
    const decision = decideCursorCompletionWatchdog({
      active: entry.isActive(),
      nowMs: entry.now(),
      lastActivityAt: entry.lastActivityAt,
      hasActiveToolOrApproval: entry.hasActiveToolOrApproval(),
      transportLiveness: entry.transportLiveness(),
      timeoutMs: entry.timeoutMs,
      pollMs: entry.pollMs,
      aliveQuiescenceMs: entry.aliveQuiescenceMs,
      startupMs: entry.startupMs,
      contextPressurePercent: entry.contextPressurePercent?.() ?? null,
      lastTokenGrowthAt: entry.lastTokenGrowthAt,
      contextPressureQuietMs: entry.contextPressureQuietMs
    })
    if (decision.kind === 'stop') {
      this.stop(entry.runId)
      return
    }
    if (decision.kind === 'recover_context') {
      this.entries.delete(entry.runId)
      if (entry.onContextPressureRecovery) {
        entry.onContextPressureRecovery(decision.reason)
      } else {
        // Legacy embedders without a recovery lane keep the fail-closed path.
        entry.onMissingTerminal(decision.reason)
      }
      return
    }
    if (decision.kind === 'recover_startup') {
      this.entries.delete(entry.runId)
      if (entry.onStartupRecovery) {
        entry.onStartupRecovery(decision.reason)
      } else {
        // Legacy embedders without a recovery lane keep the fail-closed path.
        entry.onMissingTerminal(decision.reason)
      }
      return
    }
    if (decision.kind === 'fail') {
      // Remove before the callback: a synchronous terminal/exit callback can
      // otherwise race a late provider event and produce duplicate recovery.
      this.entries.delete(entry.runId)
      entry.onMissingTerminal(decision.reason)
      return
    }
    this.schedule(entry, decision.delayMs)
  }
}
