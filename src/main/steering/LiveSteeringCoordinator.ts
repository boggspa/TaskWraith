import type { RunManager, RunSessionChangeEvent } from '../RunManager'
import type { MidRunSteeringEntry, MidRunSteeringRegistry } from '../run/MidRunSteering'
import type { ProviderId } from '../store/types'
import {
  routeSteerDelivery,
  type SteeringAttemptResult,
  type SteeringOrchestratorDeps
} from './SteeringOrchestrator'

export interface LiveSteeringCoordinatorDeps {
  runManager: RunManager
  registry: MidRunSteeringRegistry
  steering: Omit<SteeringOrchestratorDeps, 'runManager' | 'registry'>
  completeQueuedRun: (runId: string, reason: string) => boolean
  fallbackQueuedRun: (input: { runId: string; ownerToken: string; reason: string }) => boolean
  now?: () => number
  timeoutMs?: number
}

export interface StartLiveSteeringInput {
  chatId: string
  activeRunId: string
  queuedRunId: string
  ownerToken: string
  provider: ProviderId
  entry: MidRunSteeringEntry
}

interface PendingLiveSteeringAttempt extends StartLiveSteeringInput {
  strategy: string
  timeout?: ReturnType<typeof setTimeout>
}

const DEFAULT_LIVE_STEER_TIMEOUT_MS = 30_000

/**
 * Owns the durable queue half of a live steering attempt.
 *
 * A prepared solo-steer row remains `steer_promoting` while a provider
 * transport is trying to consume it. Concrete delivery evidence terminalizes
 * that queue job as completed. Refusal, timeout, cancellation, or active-run
 * terminalization releases the exact same row back to `queued`, preserving the
 * established natural-boundary path without ever appending a duplicate row.
 */
export class LiveSteeringCoordinator {
  private readonly attemptsByQueuedRunId = new Map<string, PendingLiveSteeringAttempt>()
  private readonly queuedRunIdByActiveRunId = new Map<string, string>()

  constructor(private readonly deps: LiveSteeringCoordinatorDeps) {}

  start(input: StartLiveSteeringInput): SteeringAttemptResult {
    const existingQueuedRunId = this.queuedRunIdByActiveRunId.get(input.activeRunId)
    if (existingQueuedRunId) {
      this.deps.fallbackQueuedRun({
        runId: input.queuedRunId,
        ownerToken: input.ownerToken,
        reason:
          'Another live steering attempt already owns this active run; queued for boundary delivery.'
      })
      return {
        status: 'boundary',
        strategy: 'boundary',
        entryId: input.entry.id,
        reason: 'Another live steering attempt is already pending for this run.'
      }
    }

    const attempt: PendingLiveSteeringAttempt = { ...input, strategy: 'pending' }
    this.attemptsByQueuedRunId.set(input.queuedRunId, attempt)
    this.queuedRunIdByActiveRunId.set(input.activeRunId, input.queuedRunId)

    const result = routeSteerDelivery(
      {
        runManager: this.deps.runManager,
        registry: this.deps.registry,
        ...this.deps.steering
      },
      {
        chatId: input.chatId,
        runId: input.activeRunId,
        entry: input.entry,
        provider: input.provider,
        deliveryHooks: {
          entryId: input.entry.id,
          onDelivered: () => this.markDelivered(input.queuedRunId)
        }
      }
    )
    attempt.strategy = result.strategy

    if (result.status !== 'injected' && result.status !== 'broker-pending') {
      this.releaseToBoundary(input.queuedRunId, result.reason || 'Live steering was not available.')
      return result
    }

    // A transport is allowed to report delivery synchronously. Only arm the
    // timeout when the delivery callback has not already settled this attempt.
    if (result.strategy !== 'pi-live-frame' && this.attemptsByQueuedRunId.has(input.queuedRunId)) {
      attempt.timeout = setTimeout(
        () =>
          this.releaseToBoundary(
            input.queuedRunId,
            'Live steering delivery was not confirmed before timeout; queued for boundary delivery.'
          ),
        this.deps.timeoutMs ?? DEFAULT_LIVE_STEER_TIMEOUT_MS
      )
      attempt.timeout.unref?.()
    }
    return result
  }

  cancel(activeRunId: string): { cancelled: boolean; hadPending: boolean } {
    const queuedRunId = this.queuedRunIdByActiveRunId.get(activeRunId)
    if (!queuedRunId) return { cancelled: false, hadPending: false }
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    // Pi has already accepted an irrevocable stdin frame. Releasing its row
    // while that frame can still drain would duplicate the user's message.
    if (attempt?.strategy === 'pi-live-frame') {
      return { cancelled: false, hadPending: true }
    }
    this.releaseToBoundary(
      queuedRunId,
      'Live steering was cancelled; queued for natural-boundary delivery.'
    )
    return { cancelled: true, hadPending: true }
  }

  handleRunSessionChange(event: RunSessionChangeEvent): void {
    if (
      event.type !== 'removed' &&
      event.session.status !== 'completed' &&
      event.session.status !== 'failed' &&
      event.session.status !== 'cancelled'
    ) {
      return
    }
    const queuedRunId = this.queuedRunIdByActiveRunId.get(event.session.runId)
    if (!queuedRunId) return
    this.releaseToBoundary(
      queuedRunId,
      'The active run ended before live steering delivery was confirmed; queued for boundary delivery.'
    )
  }

  hasPending(activeRunId: string): boolean {
    return this.queuedRunIdByActiveRunId.has(activeRunId)
  }

  hasPendingQueuedRun(queuedRunId: string): boolean {
    return this.attemptsByQueuedRunId.has(queuedRunId)
  }

  private markDelivered(queuedRunId: string): void {
    const attempt = this.take(queuedRunId)
    if (!attempt) return
    this.deps.registry.markDelivered(
      attempt.chatId,
      [attempt.entry.id],
      new Date(this.deps.now?.() ?? Date.now()).toISOString()
    )
    this.deps.completeQueuedRun(
      attempt.queuedRunId,
      `Delivered live through ${attempt.strategy}; no boundary replay is required.`
    )
  }

  private releaseToBoundary(queuedRunId: string, reason: string): void {
    const attempt = this.take(queuedRunId)
    if (!attempt) return
    try {
      this.deps.runManager.get(attempt.activeRunId)?.liveSteerTransport?.cancel()
    } catch {
      // Queue fallback is authoritative even if provider-side cleanup fails.
    }
    this.deps.fallbackQueuedRun({
      runId: attempt.queuedRunId,
      ownerToken: attempt.ownerToken,
      reason
    })
  }

  private take(queuedRunId: string): PendingLiveSteeringAttempt | null {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!attempt) return null
    this.attemptsByQueuedRunId.delete(queuedRunId)
    if (this.queuedRunIdByActiveRunId.get(attempt.activeRunId) === queuedRunId) {
      this.queuedRunIdByActiveRunId.delete(attempt.activeRunId)
    }
    if (attempt.timeout) clearTimeout(attempt.timeout)
    return attempt
  }
}
