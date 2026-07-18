import type {
  ExecutionRunState,
  StepActivationState,
  StepAttemptState
} from './ExecutionGraphModel'
import {
  createExecutionRunEvent,
  isExecutionRunTerminal,
  type ExecutionRunEvent,
  type ExecutionRunEventInput,
  type ExecutionRunProjection
} from './ExecutionGraphRun'

export type ExecutionRecoveryDisposition = 'terminal' | 'resume' | 'waiting' | 'requires_action'

export interface ExecutionRecoveryPlan {
  readonly disposition: ExecutionRecoveryDisposition
  readonly events: readonly ExecutionRunEvent[]
  readonly interruptedAttemptIds: readonly string[]
  readonly requeuedActivationIds: readonly string[]
  readonly requiresActionActivationIds: readonly string[]
}

const IN_FLIGHT_ATTEMPT_STATES: ReadonlySet<StepAttemptState> = new Set([
  'created',
  'claimed',
  'queued',
  'running'
])

const DURABLE_WAIT_ATTEMPT_STATES: ReadonlySet<StepAttemptState> = new Set([
  'waiting_input',
  'waiting_approval'
])

const DURABLE_WAIT_ACTIVATION_STATES: ReadonlySet<StepActivationState> = new Set([
  'waiting_input',
  'waiting_approval',
  'waiting_retry'
])

function mayReturnToReady(state: StepActivationState): boolean {
  return ['ready', 'claimed', 'queued', 'running', 'waiting_retry'].includes(state)
}

function executionResumeStateInput(
  projection: ExecutionRunProjection,
  desired: ExecutionRunState,
  reason: string,
  timestamp: string
): ExecutionRunEventInput | null {
  if (projection.state === desired) return null
  return {
    executionId: projection.executionId,
    kind: 'execution_state_changed',
    state: desired,
    reason,
    timestamp
  }
}

/**
 * Produces the events a single-writer coordinator should append on startup.
 *
 * Scheduler state is recoverable; an in-flight provider/tool side effect is not
 * replayed. Pre-running attempts and running read-only attempts may be retried
 * within their bounded policy. A running mutation always pauses for explicit
 * reconciliation, preventing an exactly-once claim the kernel cannot uphold.
 */
export function recoverExecutionRunAfterRestart(
  projection: ExecutionRunProjection,
  options: { readonly recoveredAt?: string } = {}
): ExecutionRecoveryPlan {
  if (isExecutionRunTerminal(projection.state)) {
    return {
      disposition: 'terminal',
      events: [],
      interruptedAttemptIds: [],
      requeuedActivationIds: [],
      requiresActionActivationIds: []
    }
  }

  const recoveredAt = options.recoveredAt ?? new Date().toISOString()
  const eventInputs: ExecutionRunEventInput[] = []
  const interruptedAttemptIds: string[] = []
  const requeuedActivationIds: string[] = []
  const requiresActionActivationIds: string[] = []
  let hasUnresolvedAttempt = false

  if (projection.integrity === 'invalid' || projection.baseRevisionMissing) {
    const input = executionResumeStateInput(
      projection,
      'requires_action',
      'Execution history or pinned topology could not be reconstructed safely.',
      recoveredAt
    )
    if (input) eventInputs.push(input)
    return {
      disposition: 'requires_action',
      events: eventInputs.map((entry, index) =>
        createExecutionRunEvent(entry, projection.lastSequence + index + 1, recoveredAt)
      ),
      interruptedAttemptIds,
      requeuedActivationIds,
      requiresActionActivationIds
    }
  }

  const attempts = Object.values(projection.attempts).sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id)
  )
  for (const attempt of attempts) {
    if (!IN_FLIGHT_ATTEMPT_STATES.has(attempt.state)) continue
    interruptedAttemptIds.push(attempt.id)
    eventInputs.push({
      executionId: projection.executionId,
      kind: 'attempt_state_changed',
      attemptId: attempt.id,
      state: 'interrupted',
      error: 'Attempt was interrupted by app shutdown.',
      timestamp: recoveredAt
    })

    const activation = projection.activations[attempt.activationId]
    const step = projection.topology.steps.find((candidate) => candidate.id === attempt.stepId)
    if (!activation || !step || !mayReturnToReady(activation.state)) {
      hasUnresolvedAttempt = true
      if (activation && activation.state !== 'requires_action') {
        eventInputs.push({
          executionId: projection.executionId,
          kind: 'activation_state_changed',
          activationId: activation.id,
          state: 'requires_action',
          reason: 'Interrupted attempt could not be reconciled with its activation.',
          timestamp: recoveredAt
        })
        requiresActionActivationIds.push(activation.id)
      }
      continue
    }

    const attemptCount = activation.attemptIds.length
    const didNotReachEffectBoundary = attempt.state !== 'running'
    const retryIsSafe = didNotReachEffectBoundary || step.effect === 'read_only'
    const retryRemains = attemptCount < step.retry.maxAttempts
    if (retryIsSafe && retryRemains) {
      eventInputs.push({
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'ready',
        reason: 'Interrupted attempt is safe to retry within its bounded policy.',
        timestamp: recoveredAt
      })
      requeuedActivationIds.push(activation.id)
    } else {
      eventInputs.push({
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'requires_action',
        reason: retryIsSafe
          ? 'Interrupted attempt exhausted its retry policy.'
          : 'A mutating attempt crossed the execution boundary; reconcile before retrying.',
        timestamp: recoveredAt
      })
      requiresActionActivationIds.push(activation.id)
    }
  }

  const alreadyRequiresAction = Object.values(projection.activations).some(
    (activation) => activation.state === 'requires_action'
  )
  if (hasUnresolvedAttempt || requiresActionActivationIds.length > 0 || alreadyRequiresAction) {
    const input = executionResumeStateInput(
      projection,
      'requires_action',
      'One or more interrupted steps require reconciliation.',
      recoveredAt
    )
    if (input) eventInputs.push(input)
  } else {
    const hasDurableWait =
      attempts.some((attempt) => DURABLE_WAIT_ATTEMPT_STATES.has(attempt.state)) ||
      Object.values(projection.activations).some((activation) =>
        DURABLE_WAIT_ACTIVATION_STATES.has(activation.state)
      )
    if (!hasDurableWait && projection.state !== 'running') {
      const input = executionResumeStateInput(
        projection,
        'running',
        'Recovered scheduler state after app restart.',
        recoveredAt
      )
      if (input) eventInputs.push(input)
    }
  }

  const events = eventInputs.map((entry, index) =>
    createExecutionRunEvent(entry, projection.lastSequence + index + 1, recoveredAt)
  )
  const disposition: ExecutionRecoveryDisposition =
    hasUnresolvedAttempt || requiresActionActivationIds.length > 0 || alreadyRequiresAction
      ? 'requires_action'
      : attempts.some((attempt) => DURABLE_WAIT_ATTEMPT_STATES.has(attempt.state)) ||
          Object.values(projection.activations).some((activation) =>
            DURABLE_WAIT_ACTIVATION_STATES.has(activation.state)
          )
        ? 'waiting'
        : 'resume'

  return {
    disposition,
    events,
    interruptedAttemptIds,
    requeuedActivationIds,
    requiresActionActivationIds
  }
}
