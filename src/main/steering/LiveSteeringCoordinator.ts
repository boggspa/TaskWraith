import type { RunManager, RunSessionChangeEvent } from '../RunManager'
import type { MidRunSteeringEntry, MidRunSteeringRegistry } from '../run/MidRunSteering'
import type { ProviderId } from '../store/types'
import {
  midTurnSteeringCapabilityForProvider,
  routeSteerDelivery,
  type SteeringAttemptResult,
  type SteeringOrchestratorDeps
} from './SteeringOrchestrator'

export interface LiveSteeringCoordinatorDeps {
  runManager: RunManager
  registry: MidRunSteeringRegistry
  steering: Omit<SteeringOrchestratorDeps, 'runManager' | 'registry'>
  /**
   * Persist the crash-recovery fence before the first provider-side write.
   * Returning false (or throwing) means no live transport may be touched.
   */
  markAdmissionPending: (input: {
    runId: string
    ownerToken: string
    activeRunId: string
    strategy: string
  }) => boolean
  /** Release an admission-fenced row only after concrete provider refusal. */
  releaseDefinitelyRejectedQueuedRun: (input: {
    runId: string
    ownerToken: string
    reason: string
  }) => boolean
  completeQueuedRun: (runId: string, reason: string) => boolean
  failQueuedRun: (runId: string, reason: string) => boolean
  fallbackQueuedRun: (input: { runId: string; ownerToken: string; reason: string }) => boolean
  now?: () => number
}

export interface StartLiveSteeringInput {
  chatId: string
  activeRunId: string
  queuedRunId: string
  ownerToken: string
  provider: ProviderId
  entry: MidRunSteeringEntry
  imagePaths?: readonly string[]
  forceBoundaryAfterToolResult?: boolean
  boundaryReason?: string
}

interface PendingLiveSteeringAttempt extends StartLiveSteeringInput {
  strategy: string
  result?: SteeringAttemptResult
  terminalResult?: SteeringAttemptResult
  providerOutcome?: 'delivered' | 'rejected' | 'ambiguous' | 'boundary'
  providerOutcomeReason?: string
  admissionFenced: boolean
  admissionLaunched: boolean
  awaitingCodexTransport: boolean
  codexStartupTimer?: NodeJS.Timeout
}

/**
 * Owns the durable queue half of a live steering attempt.
 *
 * A prepared solo-steer row remains `steer_promoting` while a provider
 * transport is trying to consume it. Concrete delivery evidence terminalizes
 * that queue job as completed. Only an explicit refusal may release a fenced
 * row back to `queued`; cancellation or active-run terminalization without a
 * concrete outcome fails attention-visible instead of risking a duplicate.
 */
export class LiveSteeringCoordinator {
  private readonly attemptsByQueuedRunId = new Map<string, PendingLiveSteeringAttempt>()
  private readonly queuedRunIdsByActiveRunId = new Map<string, Set<string>>()

  constructor(private readonly deps: LiveSteeringCoordinatorDeps) {}

  start(input: StartLiveSteeringInput): SteeringAttemptResult {
    const existingResult = this.reconcilePendingQueuedRun(input.queuedRunId)
    if (existingResult) return existingResult

    const earlierBoundaryPending =
      this.deps.runManager.getInterruptState(input.activeRunId).killAfterToolResult === true
    const forceBoundaryAfterToolResult =
      input.forceBoundaryAfterToolResult === true || earlierBoundaryPending
    const boundaryReason = earlierBoundaryPending
      ? 'An earlier structured steer is waiting at the next tool boundary; this message will follow it in queue order.'
      : input.boundaryReason

    const plannedStrategy = forceBoundaryAfterToolResult
      ? 'cooperative-cancel-resume'
      : midTurnSteeringCapabilityForProvider(input.provider).strategy
    const attempt: PendingLiveSteeringAttempt = {
      ...input,
      strategy: plannedStrategy,
      admissionFenced: false,
      admissionLaunched: false,
      awaitingCodexTransport: false
    }
    this.attemptsByQueuedRunId.set(input.queuedRunId, attempt)
    const activeAttempts = this.queuedRunIdsByActiveRunId.get(input.activeRunId) || new Set()
    activeAttempts.add(input.queuedRunId)
    this.queuedRunIdsByActiveRunId.set(input.activeRunId, activeAttempts)

    return this.routeAttempt(attempt, forceBoundaryAfterToolResult, boundaryReason)
  }

  /** Retry only the durable settlement of an already-owned attempt. */
  reconcilePendingQueuedRun(queuedRunId: string): SteeringAttemptResult | null {
    const existing = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!existing) return null
    if (existing.providerOutcome === 'delivered') this.markDelivered(existing.queuedRunId)
    else if (existing.providerOutcome === 'rejected') {
      this.releaseDefinitelyRejected(
        existing.queuedRunId,
        existing.providerOutcomeReason || 'Provider explicitly rejected live steering.'
      )
    } else if (existing.providerOutcome === 'ambiguous') {
      this.markAmbiguous(
        existing.queuedRunId,
        existing.providerOutcomeReason || 'Provider admission remained ambiguous.'
      )
    } else if (existing.providerOutcome === 'boundary') {
      this.releaseToBoundary(
        existing.queuedRunId,
        existing.providerOutcomeReason || 'Live steering requires boundary delivery.'
      )
    }
    return (
      this.resultForAttempt(existing) || {
        status: 'broker-pending',
        strategy: existing.strategy,
        entryId: existing.entry.id,
        reason: 'The same durable steering attempt is already being admitted.'
      }
    )
  }

  /**
   * Retry Codex attempts that arrived before the exact app-server turn
   * transport was bound. Registration calls this in the same main-process
   * turn after installing that transport; the durable admission fence is
   * minted immediately before the retry can write to the provider.
   */
  retryPendingForActiveRun(activeRunId: string): SteeringAttemptResult[] {
    const results: SteeringAttemptResult[] = []
    const queuedRunIds = [...(this.queuedRunIdsByActiveRunId.get(activeRunId) || [])]
    for (const queuedRunId of queuedRunIds) {
      const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
      if (!attempt?.awaitingCodexTransport || attempt.providerOutcome) continue
      results.push(
        this.routeAttempt(
          attempt,
          attempt.forceBoundaryAfterToolResult === true,
          attempt.boundaryReason
        )
      )
    }
    return results
  }

  cancel(activeRunId: string): { cancelled: boolean; hadPending: boolean } {
    const queuedRunIds = [...(this.queuedRunIdsByActiveRunId.get(activeRunId) || [])]
    const boundaryArmed =
      this.deps.runManager.getInterruptState(activeRunId).killAfterToolResult === true
    if (queuedRunIds.length === 0) {
      if (boundaryArmed) this.disarmBoundary(activeRunId)
      return { cancelled: boundaryArmed, hadPending: boundaryArmed }
    }
    const attempts = queuedRunIds
      .map((queuedRunId) => this.attemptsByQueuedRunId.get(queuedRunId))
      .filter((attempt): attempt is PendingLiveSteeringAttempt => Boolean(attempt))
    // Pi has already accepted an irrevocable stdin frame. Releasing its row
    // while that frame can still drain would duplicate the user's message.
    if (attempts.some((attempt) => attempt.strategy === 'pi-live-frame')) {
      if (boundaryArmed) this.disarmBoundary(activeRunId)
      return { cancelled: boundaryArmed, hadPending: true }
    }

    // Cancel while ownership is still held. ACP and broker transports use
    // this call to synchronously mark a reserved/written follow-up ambiguous;
    // taking first would discard that evidence and replay a possibly admitted
    // message from the boundary queue.
    const transportCancellationRequired = attempts.some((attempt) => attempt.admissionLaunched)
    const transportCancelled = !transportCancellationRequired || this.cancelTransport(activeRunId)
    for (const originalAttempt of attempts) {
      const attempt = this.attemptsByQueuedRunId.get(originalAttempt.queuedRunId)
      if (!attempt) continue
      if (attempt.providerOutcome === 'delivered') {
        this.markDelivered(attempt.queuedRunId)
        continue
      }
      if (attempt.providerOutcome === 'rejected') {
        this.releaseDefinitelyRejected(
          attempt.queuedRunId,
          attempt.providerOutcomeReason || 'Provider explicitly rejected live steering.'
        )
        continue
      }
      if (attempt.providerOutcome === 'ambiguous') {
        this.markAmbiguous(
          attempt.queuedRunId,
          attempt.providerOutcomeReason || 'Provider admission remained ambiguous during cancel.'
        )
        continue
      }
      if (attempt.strategy === 'codex-turn-steer' && attempt.admissionLaunched) {
        // Native turn/steer remains bounded by its exact RPC timeout after the
        // transport stops accepting new sends. Its callback, not cancellation,
        // decides delivered/rejected/ambiguous.
        continue
      }
      if (attempt.admissionLaunched) {
        const detail = !transportCancelled
          ? 'The live steering transport was unavailable or threw while cancelling.'
          : 'The live steering transport cancelled without proving that provider admission had not happened.'
        this.markAmbiguous(attempt.queuedRunId, `${detail} The steering message was not replayed.`)
        continue
      }
      this.releaseToBoundary(
        attempt.queuedRunId,
        'Live steering was cancelled before provider admission; queued for natural-boundary delivery.'
      )
    }
    if (boundaryArmed) this.disarmBoundary(activeRunId)
    return { cancelled: true, hadPending: true }
  }

  handleRunSessionChange(event: RunSessionChangeEvent): void {
    try {
      if (
        event.type !== 'removed' &&
        event.session.status !== 'completed' &&
        event.session.status !== 'failed' &&
        event.session.status !== 'cancelled'
      ) {
        this.retryPendingForActiveRun(event.session.runId)
        return
      }
      const queuedRunIds = [...(this.queuedRunIdsByActiveRunId.get(event.session.runId) || [])]
      for (const queuedRunId of queuedRunIds) {
        const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
        if (!attempt) continue
        if (attempt.providerOutcome === 'delivered') {
          this.markDelivered(queuedRunId)
          continue
        }
        if (attempt.providerOutcome === 'rejected') {
          this.releaseDefinitelyRejected(
            queuedRunId,
            attempt.providerOutcomeReason || 'Provider explicitly rejected live steering.'
          )
          continue
        }
        if (attempt.providerOutcome === 'ambiguous') {
          this.markAmbiguous(
            queuedRunId,
            attempt.providerOutcomeReason || 'Provider admission remained ambiguous at run end.'
          )
          continue
        }
        if (attempt.strategy === 'codex-turn-steer' && attempt.admissionLaunched) {
          // turn terminal and turn/steer RPC settlement are independent
          // streams. The exact request remains alive and owns a bounded
          // timeout, so let its callback settle this durable row.
          continue
        }
        if (attempt.admissionLaunched) {
          this.markAmbiguous(
            queuedRunId,
            'The active run ended without concrete live-steering delivery or rejection evidence.'
          )
          continue
        }
        this.releaseToBoundary(
          queuedRunId,
          'The active run ended before provider admission was attempted; queued for boundary delivery.'
        )
      }
    } catch {
      // RunManager listeners are lifecycle infrastructure. A queue/store
      // exception must remain contained here and must never abort finish().
    }
  }

  hasPending(activeRunId: string): boolean {
    return Boolean(this.queuedRunIdsByActiveRunId.get(activeRunId)?.size)
  }

  hasPendingQueuedRun(queuedRunId: string): boolean {
    return this.attemptsByQueuedRunId.has(queuedRunId)
  }

  pendingResult(queuedRunId: string): SteeringAttemptResult | null {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    return attempt ? this.resultForAttempt(attempt) : null
  }

  private markDelivered(queuedRunId: string): void {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!attempt) return
    // Concrete delivery wins over an earlier in-memory ambiguity as long as
    // that ambiguity could not itself be committed durably.
    attempt.providerOutcome = 'delivered'
    attempt.providerOutcomeReason = undefined
    const completed = this.invokeDurableMutation(() =>
      this.deps.completeQueuedRun(
        attempt.queuedRunId,
        `Delivered live through ${attempt.strategy}; no boundary replay is required.`
      )
    )
    if (completed) {
      this.markRegistryDelivered(attempt)
      attempt.terminalResult = {
        status: 'injected',
        strategy: attempt.strategy,
        entryId: attempt.entry.id
      }
      this.take(attempt.queuedRunId, attempt)
      return
    }

    const failureReason =
      'Live steering was delivered, but its durable completion receipt could not be committed.'
    attempt.terminalResult = {
      status: 'failed',
      strategy: attempt.strategy,
      entryId: attempt.entry.id,
      reason: failureReason
    }
    const failed = this.invokeDurableMutation(() =>
      this.deps.failQueuedRun(attempt.queuedRunId, failureReason)
    )
    if (failed) {
      this.settleRegistryWithoutDelivery(attempt)
      this.take(attempt.queuedRunId, attempt)
    }
  }

  private markAmbiguous(queuedRunId: string, reason: string): void {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!attempt) return
    if (attempt.providerOutcome === 'delivered') {
      this.markDelivered(queuedRunId)
      return
    }
    if (attempt.providerOutcome === 'rejected') {
      this.releaseDefinitelyRejected(queuedRunId, attempt.providerOutcomeReason || reason)
      return
    }
    attempt.providerOutcome = 'ambiguous'
    attempt.providerOutcomeReason = reason
    const failureReason = `Live steering admission was ambiguous and was not replayed: ${reason}`
    attempt.terminalResult = {
      status: 'failed',
      strategy: attempt.strategy,
      entryId: attempt.entry.id,
      reason: failureReason
    }
    const failed = this.invokeDurableMutation(() =>
      this.deps.failQueuedRun(attempt.queuedRunId, failureReason)
    )
    if (failed) {
      this.settleRegistryWithoutDelivery(attempt)
      this.take(attempt.queuedRunId, attempt)
    }
  }

  private releaseDefinitelyRejected(queuedRunId: string, reason: string): void {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!attempt) return
    if (attempt.providerOutcome === 'delivered') {
      this.markDelivered(queuedRunId)
      return
    }
    // A later explicit rejection is stronger than an ambiguity that could not
    // itself be committed durably. If the ambiguous failure had committed,
    // this attempt would already have been removed and this callback ignored.
    attempt.providerOutcome = 'rejected'
    attempt.providerOutcomeReason = reason

    // Rejection proves this live transport did not carry the row, but it does
    // not permit a later steer to overtake it. Keep the exact active run's
    // boundary barrier armed until the queued request can run in FIFO order.
    try {
      this.deps.runManager.armKillAfterToolResult(attempt.activeRunId, attempt.queuedRunId)
    } catch {
      // Durable release below remains authoritative; boundary acceleration is
      // best-effort when the active run has already terminalized.
    }

    const released = this.invokeDurableMutation(() =>
      this.deps.releaseDefinitelyRejectedQueuedRun({
        runId: attempt.queuedRunId,
        ownerToken: attempt.ownerToken,
        reason
      })
    )
    if (released) {
      attempt.terminalResult = {
        status: 'boundary',
        strategy: attempt.strategy,
        entryId: attempt.entry.id,
        reason
      }
      this.take(attempt.queuedRunId, attempt)
      return
    }

    this.disarmBoundary(attempt.activeRunId, attempt.queuedRunId)
    const failureReason = `An explicit provider rejection could not be released durably to boundary delivery: ${reason}`
    attempt.terminalResult = {
      status: 'failed',
      strategy: attempt.strategy,
      entryId: attempt.entry.id,
      reason: failureReason
    }
    const failed = this.invokeDurableMutation(() =>
      this.deps.failQueuedRun(attempt.queuedRunId, failureReason)
    )
    if (!failed) return
    this.settleRegistryWithoutDelivery(attempt)
    this.take(attempt.queuedRunId, attempt)
  }

  private releaseToBoundary(queuedRunId: string, reason: string): void {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!attempt) return
    if (attempt.providerOutcome === 'delivered') {
      this.markDelivered(queuedRunId)
      return
    }
    if (attempt.providerOutcome === 'rejected') {
      this.releaseDefinitelyRejected(queuedRunId, attempt.providerOutcomeReason || reason)
      return
    }
    if (attempt.providerOutcome === 'ambiguous' || attempt.admissionFenced) {
      this.markAmbiguous(
        queuedRunId,
        attempt.providerOutcomeReason ||
          `A fenced live-steering attempt had no explicit rejection evidence: ${reason}`
      )
      return
    }
    attempt.providerOutcome = 'boundary'
    attempt.providerOutcomeReason = reason

    const released = this.invokeDurableMutation(() =>
      this.deps.fallbackQueuedRun({
        runId: attempt.queuedRunId,
        ownerToken: attempt.ownerToken,
        reason
      })
    )
    if (released) {
      attempt.terminalResult = {
        status: 'boundary',
        strategy: attempt.strategy,
        entryId: attempt.entry.id,
        reason
      }
      this.take(attempt.queuedRunId, attempt)
      return
    }

    // Never interrupt the active provider unless the exact durable steer was
    // actually released to a runnable queue state. A failed ownership barrier
    // keeps the coordinator's ownership until either queue fallback or a
    // durable attention-visible failure can be committed.
    this.disarmBoundary(attempt.activeRunId, attempt.queuedRunId)
    const failureReason = `Live steering fallback could not be committed without risking duplicate delivery: ${reason}`
    attempt.terminalResult = {
      status: 'failed',
      strategy: attempt.strategy,
      entryId: attempt.entry.id,
      reason: failureReason
    }
    const failed = this.invokeDurableMutation(() =>
      this.deps.failQueuedRun(attempt.queuedRunId, failureReason)
    )
    if (!failed) return
    this.settleRegistryWithoutDelivery(attempt)
    this.take(attempt.queuedRunId, attempt)
  }

  private routeAttempt(
    attempt: PendingLiveSteeringAttempt,
    forceBoundaryAfterToolResult: boolean,
    boundaryReason: string | undefined
  ): SteeringAttemptResult {
    attempt.awaitingCodexTransport = false
    const currentSession = this.deps.runManager.get(attempt.activeRunId)
    if (
      attempt.provider === 'codex' &&
      (!currentSession ||
        (!forceBoundaryAfterToolResult &&
          currentSession.appChatId === attempt.chatId &&
          currentSession.provider === 'codex' &&
          !currentSession.liveSteerTransport))
    ) {
      attempt.awaitingCodexTransport = true
      attempt.result = {
        status: 'broker-pending',
        strategy: 'codex-turn-steer',
        entryId: attempt.entry.id,
        reason: 'Waiting for the exact bound Codex turn transport and run session before live admission.'
      }
      this.scheduleCodexStartupFallback(attempt)
      return attempt.result
    }
    if (attempt.codexStartupTimer) {
      clearTimeout(attempt.codexStartupTimer)
      attempt.codexStartupTimer = undefined
    }
    if (this.routeWillAttemptProviderAdmission(attempt, forceBoundaryAfterToolResult)) {
      const fenceCommitted = this.ensureAdmissionFence(attempt)
      if (!fenceCommitted) {
        const reason =
          'Live steering admission was not attempted because its durable crash-recovery fence could not be committed.'
        this.releaseToBoundary(attempt.queuedRunId, reason)
        return (
          this.resultForAttempt(attempt) || {
            status: 'failed',
            strategy: attempt.strategy,
            entryId: attempt.entry.id,
            reason
          }
        )
      }
    }
    let result: SteeringAttemptResult
    try {
      result = routeSteerDelivery(
        {
          runManager: this.deps.runManager,
          registry: this.deps.registry,
          ...this.deps.steering
        },
        {
          chatId: attempt.chatId,
          runId: attempt.activeRunId,
          entry: attempt.entry,
          provider: attempt.provider,
          boundaryQueueRunId: attempt.queuedRunId,
          forceBoundaryAfterToolResult,
          boundaryReason,
          deliveryHooks: {
            entryId: attempt.entry.id,
            messageId: attempt.entry.messageId,
            imagePaths: attempt.imagePaths,
            onDelivered: () => this.markDelivered(attempt.queuedRunId),
            onRejected: (rejectionReason) =>
              this.releaseDefinitelyRejected(attempt.queuedRunId, rejectionReason),
            onAmbiguous: (ambiguityReason) =>
              this.markAmbiguous(attempt.queuedRunId, ambiguityReason)
          }
        }
      )
    } catch (error) {
      const reason = `Live steering transport threw during admission: ${
        error instanceof Error ? error.message : String(error)
      }`
      if (!attempt.providerOutcome) {
        if (attempt.admissionFenced) this.markAmbiguous(attempt.queuedRunId, reason)
        else this.releaseToBoundary(attempt.queuedRunId, reason)
      }
      return (
        this.resultForAttempt(attempt) || {
          status: attempt.providerOutcome ? 'failed' : 'boundary',
          strategy: attempt.strategy,
          entryId: attempt.entry.id,
          reason
        }
      )
    }

    attempt.strategy = result.strategy
    attempt.result = result

    if (attempt.terminalResult) return this.resultForAttempt(attempt)!

    if (
      result.status === 'boundary' &&
      result.strategy === 'codex-turn-steer' &&
      !this.deps.runManager.get(attempt.activeRunId)?.liveSteerTransport
    ) {
      attempt.awaitingCodexTransport = true
      attempt.result = {
        status: 'broker-pending',
        strategy: 'codex-turn-steer',
        entryId: attempt.entry.id,
        reason: 'Waiting for the exact bound Codex turn transport before live admission.'
      }
      return attempt.result
    }

    if (result.status === 'injected' || result.status === 'broker-pending') {
      attempt.admissionLaunched = true
      return result
    }

    const refusalReason = result.reason || 'Live steering was not available.'
    if (attempt.admissionFenced) {
      this.releaseDefinitelyRejected(attempt.queuedRunId, refusalReason)
    } else {
      this.releaseToBoundary(attempt.queuedRunId, refusalReason)
    }
    return this.resultForAttempt(attempt) || result
  }

  private resultForAttempt(attempt: PendingLiveSteeringAttempt): SteeringAttemptResult | null {
    return attempt.terminalResult || attempt.result || null
  }

  private scheduleCodexStartupFallback(attempt: PendingLiveSteeringAttempt): void {
    if (attempt.codexStartupTimer) return
    attempt.codexStartupTimer = setTimeout(() => {
      attempt.codexStartupTimer = undefined
      const current = this.attemptsByQueuedRunId.get(attempt.queuedRunId)
      if (current !== attempt || !attempt.awaitingCodexTransport || attempt.admissionFenced) return
      this.releaseToBoundary(
        attempt.queuedRunId,
        'The exact Codex turn transport did not bind during startup; queued for boundary delivery.'
      )
    }, 10_000)
    attempt.codexStartupTimer.unref?.()
  }

  private routeWillAttemptProviderAdmission(
    attempt: PendingLiveSteeringAttempt,
    forceBoundaryAfterToolResult: boolean
  ): boolean {
    if (forceBoundaryAfterToolResult || !this.deps.steering.midTurnSteeringEnabled) return false
    if (!attempt.entry.text.trim()) return false
    if (attempt.entry.authorKind !== 'host' && attempt.entry.authorKind !== 'ensembleParticipant') {
      return false
    }
    const session = this.deps.runManager.get(attempt.activeRunId)
    if (
      !session ||
      session.appChatId !== attempt.chatId ||
      session.provider !== attempt.provider ||
      !this.deps.runManager.canAdmitTransport(attempt.activeRunId, true) ||
      (session.status !== 'starting' && session.status !== 'running')
    ) {
      return false
    }
    if (attempt.strategy === 'broker-injection') return true
    if (attempt.strategy === 'pi-live-frame') {
      return this.deps.steering.piLiveSteerEnabled && Boolean(session.liveSteerTransport)
    }
    if (attempt.strategy === 'acp-interrupt' || attempt.strategy === 'codex-turn-steer') {
      return Boolean(session.liveSteerTransport)
    }
    return false
  }

  private ensureAdmissionFence(attempt: PendingLiveSteeringAttempt): boolean {
    if (attempt.admissionFenced) return true
    const committed = this.invokeDurableMutation(() =>
      this.deps.markAdmissionPending({
        runId: attempt.queuedRunId,
        ownerToken: attempt.ownerToken,
        activeRunId: attempt.activeRunId,
        strategy: attempt.strategy
      })
    )
    if (committed) attempt.admissionFenced = true
    return committed
  }

  private invokeDurableMutation(action: () => boolean): boolean {
    try {
      return action() === true
    } catch {
      return false
    }
  }

  private markRegistryDelivered(attempt: PendingLiveSteeringAttempt): void {
    try {
      this.deps.registry.markDelivered(
        attempt.chatId,
        [attempt.entry.id],
        new Date(this.deps.now?.() ?? Date.now()).toISOString()
      )
    } catch {
      // The durable queue receipt is authoritative. Registry bookkeeping is
      // in-memory and must not reopen a completed provider admission.
    }
  }

  private settleRegistryWithoutDelivery(attempt: PendingLiveSteeringAttempt): void {
    try {
      this.deps.registry.settleWithoutDelivery(attempt.chatId, [attempt.entry.id])
    } catch {
      // Durable failed state still fences replay even if ephemeral cleanup
      // cannot be projected in this process.
    }
  }

  private cancelTransport(activeRunId: string): boolean {
    const transport = this.deps.runManager.get(activeRunId)?.liveSteerTransport
    if (!transport) return false
    try {
      transport.cancel()
      return true
    } catch {
      return false
    }
  }

  private disarmBoundary(activeRunId: string, queuedRunId?: string): void {
    try {
      this.deps.runManager.disarmKillAfterToolResult(activeRunId, queuedRunId)
    } catch {
      // Lifecycle listeners must remain exception-safe.
    }
  }

  private take(
    queuedRunId: string,
    expected?: PendingLiveSteeringAttempt
  ): PendingLiveSteeringAttempt | null {
    const attempt = this.attemptsByQueuedRunId.get(queuedRunId)
    if (!attempt || (expected && attempt !== expected)) return null
    this.attemptsByQueuedRunId.delete(queuedRunId)
    if (attempt.codexStartupTimer) clearTimeout(attempt.codexStartupTimer)
    const activeAttempts = this.queuedRunIdsByActiveRunId.get(attempt.activeRunId)
    activeAttempts?.delete(queuedRunId)
    if (activeAttempts?.size === 0) this.queuedRunIdsByActiveRunId.delete(attempt.activeRunId)
    return attempt
  }
}
