import { randomUUID } from 'node:crypto'
import type { RunSessionChangeEvent, RunSessionStatus } from '../RunManager'
import type { ProviderId, RunQueueJob, RunQueueJobStatus } from '../store/types'
import type {
  ExecutionEffect,
  ExecutionPermissionCeilingRef,
  ExecutionStepDefinition,
  ExecutionStepResult,
  StepActivation,
  StepAttempt
} from '../executionGraph/ExecutionGraphModel'
import {
  executionTopologyFrontier,
  isExecutionRunTerminal,
  isStepActivationTerminal,
  isStepAttemptTerminal,
  prepareUserFrontierAppend,
  type ExecutionRunEventInput,
  type ExecutionRunProjection
} from '../executionGraph/ExecutionGraphRun'
import type {
  AppendExecutionEventOptions,
  ExecutionGraphRepository,
  ExecutionGraphRunTemplate
} from '../executionGraph/ExecutionGraphRepository'

export interface ExecutionGraphChangedNotice {
  readonly schemaVersion: 1
  readonly executionId: string
  readonly workspaceId: string
  readonly rootChatId?: string
  readonly sequence: number
  readonly kind:
    | 'execution-created'
    | 'step-appended'
    | 'execution-progressed'
    | 'execution-terminal'
  readonly changedStepIds?: readonly string[]
}

export interface AppendExecutionStackStepInput {
  readonly executionId?: string
  readonly workspaceId: string
  readonly rootChatId: string
  readonly title?: string
  /** Main must validate that this live run belongs to rootChatId before calling. */
  readonly anchorRunRef?: string
  readonly stepTitle: string
  readonly objective: string
  readonly provider: ProviderId
  readonly model?: string
  readonly effect: ExecutionEffect
  readonly runTemplateRef: string
  readonly permissionCeilingRef: ExecutionPermissionCeilingRef
}

export interface MaterializeExecutionQueueJobInput {
  readonly runId: string
  readonly executionId: string
  readonly activationId: string
  readonly attemptId: string
  readonly workspaceId: string
  readonly rootChatId: string
  readonly provider: ProviderId
  readonly runTemplate: ExecutionGraphRunTemplate
}

/**
 * Main-owned, exact truth for an anchor run identity after RunQueue and
 * RunManager have been reconciled. Callers must resolve by runId, never by
 * provider/chat heuristics. `nonterminal` includes queued, paused, starting,
 * active, and cancelling runs whose eventual terminal event is still expected.
 */
export type ExecutionGraphAnchorRunStatus =
  | 'nonterminal'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'missing'
  | 'ambiguous'

export interface ExecutionGraphCoordinatorRepository {
  createExecution: ExecutionGraphRepository['createExecution']
  appendExecutionEvents: ExecutionGraphRepository['appendExecutionEvents']
  getExecution: ExecutionGraphRepository['getExecution']
  listExecutions: ExecutionGraphRepository['listExecutions']
  getRunTemplate: ExecutionGraphRepository['getRunTemplate']
}

export interface ExecutionGraphCoordinatorDeps {
  repository: ExecutionGraphCoordinatorRepository
  materializePausedQueueJob: (input: MaterializeExecutionQueueJobInput) => RunQueueJob
  getQueueJob: (runId: string) => RunQueueJob | null
  transitionQueueJob: (
    runId: string,
    status: RunQueueJobStatus,
    partial?: Pick<Partial<RunQueueJob>, 'statusReason' | 'lastError'>
  ) => RunQueueJob | null
  resolveAnchorRunStatus: (runId: string) => ExecutionGraphAnchorRunStatus
  cancelActiveRun: (runId: string) => Promise<void> | void
  onChanged?: (notice: ExecutionGraphChangedNotice) => void
  now?: () => string
  createId?: () => string
}

const TERMINAL_QUEUE_STATUSES = new Set<RunQueueJobStatus>(['completed', 'failed', 'cancelled'])

function canonicalPart(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80)
  return normalized || randomUUID()
}

function latestActivationForStep(
  projection: ExecutionRunProjection,
  stepId: string
): StepActivation | undefined {
  return Object.values(projection.activations)
    .filter((activation) => activation.stepId === stepId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))[0]
}

function latestAttemptForActivation(
  projection: ExecutionRunProjection,
  activation: StepActivation
): StepAttempt | undefined {
  return activation.attemptIds
    .map((attemptId) => projection.attempts[attemptId])
    .filter((attempt): attempt is StepAttempt => Boolean(attempt))
    .sort((a, b) => b.ordinal - a.ordinal || b.id.localeCompare(a.id))[0]
}

function terminalSession(status: RunSessionStatus): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function executionResult(runId: string, rootChatId: string | undefined): ExecutionStepResult {
  return {
    schemaVersion: 1,
    artifactRefs: [],
    trust: 'untrusted_agent_output',
    providerRunRef: runId,
    ...(rootChatId ? { threadRef: rootChatId } : {})
  }
}

/**
 * Main-owned V1 scheduler for implicit linear Stacks.
 *
 * The execution ledger owns readiness. RunQueue is only the concrete provider
 * attempt transport: a job is materialized paused, durably claimed in the
 * graph ledger, and only then released to `queued`.
 */
export class ExecutionGraphCoordinator {
  private readonly repository: ExecutionGraphCoordinatorRepository
  private readonly now: () => string
  private readonly createId: () => string
  private readonly draining = new Set<string>()

  constructor(private readonly deps: ExecutionGraphCoordinatorDeps) {
    this.repository = deps.repository
    this.now = deps.now ?? (() => new Date().toISOString())
    this.createId = deps.createId ?? randomUUID
  }

  listExecutions(
    filter: {
      workspaceId?: string
      rootChatId?: string
      includeTerminal?: boolean
    } = {}
  ): readonly ExecutionRunProjection[] {
    return this.repository
      .listExecutions()
      .filter((projection) =>
        filter.workspaceId ? projection.workspaceId === filter.workspaceId : true
      )
      .filter((projection) =>
        filter.rootChatId ? projection.rootChatId === filter.rootChatId : true
      )
      .filter((projection) =>
        filter.includeTerminal === false ? !isExecutionRunTerminal(projection.state) : true
      )
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
  }

  getExecution(executionId: string): ExecutionRunProjection | undefined {
    return this.repository.getExecution(executionId)
  }

  appendStackStep(input: AppendExecutionStackStepInput): ExecutionRunProjection {
    let projection = input.executionId
      ? this.requireExecution(input.executionId)
      : this.findOpenStack(input.workspaceId, input.rootChatId)

    if (!projection) {
      const executionId = this.id('stack')
      projection = this.repository.createExecution({
        executionId,
        kind: 'execution_created',
        title: input.title?.trim() || 'Task Stack',
        workspaceId: input.workspaceId,
        tenant: { kind: 'stack', tenantId: input.rootChatId },
        rootChatId: input.rootChatId,
        ...(input.anchorRunRef ? { anchorRunRef: input.anchorRunRef } : {}),
        permissionCeilingRef: input.permissionCeilingRef,
        timestamp: this.now()
      })
      this.changed(projection, 'execution-created')
    }

    this.assertAppendAuthority(projection, input)
    if (isExecutionRunTerminal(projection.state)) {
      throw new Error(`Execution "${projection.executionId}" is already ${projection.state}.`)
    }
    const frontier = executionTopologyFrontier(projection.topology)
    if (frontier.length > 1) {
      throw new Error('V1 Stack append requires exactly one open frontier step.')
    }

    const stepId = this.id('step')
    const activationId = this.id('activation')
    const step: ExecutionStepDefinition = {
      id: stepId,
      kind: 'solo_agent',
      title: input.stepTitle.trim(),
      objective: input.objective.trim(),
      effect: input.effect,
      retry: { maxAttempts: 1 },
      permissionRequestRef: {
        schemaVersion: 1,
        referenceId: input.permissionCeilingRef.referenceId,
        ceilingReferenceId: projection.permissionCeilingRef!.referenceId,
        authorityDigest: input.permissionCeilingRef.authorityDigest
      },
      agent: {
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        runTemplateRef: input.runTemplateRef,
        session: { mode: 'bound', sessionRef: input.rootChatId }
      }
    }
    const incomingEdges = frontier.length
      ? [
          {
            id: this.id('edge'),
            kind: 'control' as const,
            fromStepId: frontier[0],
            toStepId: stepId,
            outcome: 'success' as const
          }
        ]
      : []
    const prepared = prepareUserFrontierAppend(
      {
        executionId: projection.executionId,
        topology: projection.topology,
        runState: projection.state,
        permissionCeilingRef: projection.permissionCeilingRef
      },
      { appendedBy: 'user', step, incomingEdges }
    )
    if (!prepared.ok) {
      throw new Error(
        `Stack append was rejected: ${prepared.issues.map((issue) => issue.code).join(', ')}.`
      )
    }

    const events: ExecutionRunEventInput[] = [
      { ...prepared.input, timestamp: this.now() },
      {
        executionId: projection.executionId,
        kind: 'activation_created',
        activationId,
        stepId,
        timestamp: this.now()
      }
    ]
    if (projection.state === 'pending') {
      events.push({
        executionId: projection.executionId,
        kind: 'execution_state_changed',
        state: projection.anchorRunRef ? 'waiting' : 'running',
        reason: projection.anchorRunRef
          ? 'Waiting for the Stack anchor run to finish.'
          : 'Stack is ready to execute.',
        timestamp: this.now()
      })
    }
    this.append(projection, events)
    projection = this.requireExecution(projection.executionId)
    this.changed(projection, 'step-appended', [stepId])
    this.drain(projection.executionId)
    return this.requireExecution(projection.executionId)
  }

  drain(executionId?: string): void {
    const ids = executionId
      ? [executionId]
      : this.listExecutions({ includeTerminal: false }).map((projection) => projection.executionId)
    for (const id of ids) this.drainOne(id)
  }

  onRunSessionChange(event: RunSessionChangeEvent): void {
    if (event.type === 'removed') return
    const runId = event.session.runId
    const projections = this.listExecutions({ includeTerminal: false })
    for (const projection of projections) {
      if (projection.anchorRunRef === runId && terminalSession(event.session.status)) {
        this.settleAnchor(projection, event.session.status)
        continue
      }
      const attempt = Object.values(projection.attempts).find(
        (candidate) => candidate.providerRunRef === runId
      )
      if (!attempt || isStepAttemptTerminal(attempt.state)) continue
      if (event.session.status === 'starting' || event.session.status === 'running') {
        this.markAttemptRunning(projection, attempt)
      } else if (terminalSession(event.session.status)) {
        this.settleAttempt(projection, attempt, event.session.status)
      }
    }
  }

  async cancelExecution(executionId: string, reason = 'Cancelled by user.'): Promise<void> {
    let projection = this.requireExecution(executionId)
    if (isExecutionRunTerminal(projection.state)) return
    const events: ExecutionRunEventInput[] = []
    const queueRuns: Array<{ runId: string; cancelActive: boolean }> = []
    for (const activation of Object.values(projection.activations)) {
      if (isStepActivationTerminal(activation.state)) continue
      const attempt = latestAttemptForActivation(projection, activation)
      if (attempt && !isStepAttemptTerminal(attempt.state)) {
        if (attempt.providerRunRef) {
          const job = this.deps.getQueueJob(attempt.providerRunRef)
          if (job && !TERMINAL_QUEUE_STATUSES.has(job.status)) {
            queueRuns.push({
              runId: attempt.providerRunRef,
              cancelActive:
                job.status === 'starting' || job.status === 'active' || job.status === 'cancelling'
            })
          }
        }
        events.push({
          executionId,
          kind: 'attempt_state_changed',
          attemptId: attempt.id,
          state: 'cancelled',
          error: reason,
          timestamp: this.now()
        })
      }
      events.push({
        executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'cancelled',
        reason,
        timestamp: this.now()
      })
    }
    events.push({
      executionId,
      kind: 'execution_state_changed',
      state: 'cancelled',
      reason,
      timestamp: this.now()
    })
    this.append(projection, events)
    projection = this.requireExecution(executionId)
    this.changed(projection, 'execution-terminal')
    // Persist the graph cancellation before touching provider transports. A
    // provider cancellation may synchronously finish RunManager and re-enter
    // onRunSessionChange; the terminal ledger makes that callback a safe no-op.
    for (const queueRun of queueRuns) {
      if (queueRun.cancelActive) {
        await this.deps.cancelActiveRun(queueRun.runId)
      }
      this.deps.transitionQueueJob(queueRun.runId, 'cancelled', {
        statusReason: reason
      })
    }
  }

  async cancelDormantStep(
    executionId: string,
    activationId: string
  ): Promise<ExecutionRunProjection> {
    const projection = this.requireExecution(executionId)
    const activation = projection.activations[activationId]
    if (!activation || activation.state !== 'dormant') {
      throw new Error('Only a dormant Stack step can be cancelled directly.')
    }
    if (
      projection.tenant?.kind !== 'stack' ||
      !executionTopologyFrontier(projection.topology).includes(activation.stepId)
    ) {
      throw new Error('Only the append-only Stack frontier can cancel the remaining Stack.')
    }
    await this.cancelExecution(executionId, 'Remaining Stack cancelled by user.')
    return this.requireExecution(executionId)
  }

  recover(): void {
    for (const projection of this.listExecutions({ includeTerminal: false })) {
      if (projection.integrity !== 'valid' || projection.baseRevisionMissing) continue

      if (this.isWaitingForAnchor(projection)) {
        this.recoverAnchor(projection)
        continue
      }

      const incompleteAttempt = Object.values(projection.attempts).find(
        (attempt) => !isStepAttemptTerminal(attempt.state) && !attempt.providerRunRef
      )
      if (incompleteAttempt) {
        this.requireAction(
          projection,
          incompleteAttempt,
          'The durable claim is incomplete and has no exact provider run identity.'
        )
        continue
      }

      const incompleteActivation = Object.values(projection.activations).find((activation) => {
        if (
          activation.state !== 'claimed' &&
          activation.state !== 'queued' &&
          activation.state !== 'running'
        ) {
          return false
        }
        const attempt = latestAttemptForActivation(projection, activation)
        return !attempt || isStepAttemptTerminal(attempt.state) || !attempt.providerRunRef
      })
      if (incompleteActivation) {
        this.requireActivationAction(
          projection,
          incompleteActivation,
          'The activation claim is incomplete and cannot be correlated to a usable attempt.'
        )
        continue
      }

      let changed = false
      for (const attempt of Object.values(projection.attempts)) {
        if (isStepAttemptTerminal(attempt.state)) continue
        const providerRunRef = attempt.providerRunRef
        if (!providerRunRef) {
          this.requireAction(
            projection,
            attempt,
            'The durable claim is incomplete and has no exact provider run identity.'
          )
          changed = true
          break
        }
        const job = this.deps.getQueueJob(providerRunRef)
        if (!job) {
          this.requireAction(projection, attempt, 'The claimed queue job is missing after restart.')
          changed = true
          break
        }
        if (job.status === 'paused' && attempt.state === 'claimed') {
          const queued = this.deps.transitionQueueJob(job.runId, 'queued', {
            statusReason: 'Recovered graph claim; dependency is still satisfied.'
          })
          if (queued?.status === 'queued') {
            this.appendAttemptQueued(this.requireExecution(projection.executionId), attempt)
            changed = true
          }
          break
        }
        if (job.status === 'queued' && attempt.state === 'claimed') {
          this.appendAttemptQueued(projection, attempt)
          changed = true
          break
        }
        if (job.status === 'completed') {
          this.settleAttempt(projection, attempt, 'completed')
          changed = true
          break
        }
        if (job.status === 'failed' || job.status === 'cancelled') {
          this.settleAttempt(projection, attempt, job.status)
          changed = true
          break
        }
        if (job.status !== 'queued') {
          this.requireAction(
            projection,
            attempt,
            'Provider dispatch may have crossed the side-effect boundary before restart.'
          )
          changed = true
          break
        }
      }
      if (!changed) this.drainOne(projection.executionId)
    }
  }

  private drainOne(executionId: string): void {
    if (this.draining.has(executionId)) return
    this.draining.add(executionId)
    try {
      for (;;) {
        let projection = this.requireExecution(executionId)
        if (
          isExecutionRunTerminal(projection.state) ||
          projection.state === 'waiting' ||
          projection.state === 'requires_action'
        ) {
          return
        }

        const dormant = Object.values(projection.activations).find(
          (activation) => activation.state === 'dormant'
        )
        if (dormant) {
          const predecessorIds = projection.topology.edges
            .filter(
              (edge): edge is Extract<typeof edge, { kind: 'control' }> =>
                edge.kind === 'control' && edge.toStepId === dormant.stepId
            )
            .map((edge) => edge.fromStepId)
          const predecessors = predecessorIds
            .map((stepId) => latestActivationForStep(projection, stepId))
            .filter((activation): activation is StepActivation => Boolean(activation))
          if (
            predecessors.some(
              (activation) =>
                isStepActivationTerminal(activation.state) && activation.state !== 'succeeded'
            )
          ) {
            this.failBlockedActivation(projection, dormant)
            continue
          }
          if (
            predecessors.length === predecessorIds.length &&
            predecessors.every((activation) => activation.state === 'succeeded')
          ) {
            this.append(projection, [
              {
                executionId,
                kind: 'activation_state_changed',
                activationId: dormant.id,
                state: 'ready',
                reason: predecessorIds.length
                  ? 'All predecessor steps succeeded.'
                  : 'Stack root is ready.',
                timestamp: this.now()
              }
            ])
            projection = this.requireExecution(executionId)
            this.changed(projection, 'execution-progressed', [dormant.stepId])
            continue
          }
        }

        const ready = Object.values(projection.activations).find(
          (activation) => activation.state === 'ready'
        )
        if (ready) {
          const step = projection.topology.steps.find((candidate) => candidate.id === ready.stepId)
          if (!step) {
            this.requireActivationAction(projection, ready, 'Step definition is missing.')
            return
          }
          if (step.kind === 'solo_agent') {
            this.claimSoloStep(projection, ready, step)
            return
          }
          if (step.kind === 'human_gate') {
            this.append(projection, [
              {
                executionId,
                kind: 'activation_state_changed',
                activationId: ready.id,
                state: step.gate.mode === 'approval' ? 'waiting_approval' : 'waiting_input',
                reason: step.gate.prompt,
                timestamp: this.now()
              },
              {
                executionId,
                kind: 'execution_state_changed',
                state: 'waiting',
                reason: 'A durable human gate is waiting.',
                timestamp: this.now()
              }
            ])
            this.changed(this.requireExecution(executionId), 'execution-progressed', [ready.stepId])
            return
          }
          if (step.kind === 'ensemble_round') {
            this.requireActivationAction(
              projection,
              ready,
              'Ensemble round executor is not bound for this V1 Stack.'
            )
            return
          }
          if (step.kind === 'deterministic_check' || step.kind === 'join') {
            this.requireActivationAction(
              projection,
              ready,
              `${step.kind === 'join' ? 'Join' : 'Deterministic check'} executor is not bound for this V1 Stack.`
            )
            return
          }
          this.completeDeterministicStep(projection, ready)
          continue
        }

        const activations = Object.values(projection.activations)
        if (
          activations.length > 0 &&
          activations.every((activation) => activation.state === 'succeeded')
        ) {
          this.append(projection, [
            {
              executionId,
              kind: 'execution_state_changed',
              state: 'succeeded',
              reason: 'Every execution step succeeded.',
              timestamp: this.now()
            }
          ])
          this.changed(this.requireExecution(executionId), 'execution-terminal')
        }
        return
      }
    } finally {
      this.draining.delete(executionId)
    }
  }

  private claimSoloStep(
    projection: ExecutionRunProjection,
    activation: StepActivation,
    step: Extract<ExecutionStepDefinition, { kind: 'solo_agent' }>
  ): void {
    const templateRef = step.agent.runTemplateRef
    const template = templateRef ? this.repository.getRunTemplate(templateRef) : undefined
    if (!template) {
      this.requireActivationAction(projection, activation, 'Run template is unavailable.')
      return
    }
    const attemptId = this.id('attempt')
    const runId = this.id('graph-run')

    // Persist the exact graph <-> queue run correlation before touching the
    // queue store. A crash can leave a claimed attempt without a job, which is
    // safely attention-gated on recovery; it can no longer leave an invisible
    // orphan paused job with no durable graph owner.
    this.append(projection, [
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'claimed',
        reason: 'Graph coordinator claimed the ready step.',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'attempt_created',
        attemptId,
        activationId: activation.id,
        stepId: activation.stepId,
        ordinal: activation.attemptIds.length + 1,
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId,
        state: 'claimed',
        providerRunRef: runId,
        timestamp: this.now()
      }
    ])
    projection = this.requireExecution(projection.executionId)
    const attempt = projection.attempts[attemptId]
    let job: RunQueueJob
    try {
      job = this.deps.materializePausedQueueJob({
        runId,
        executionId: projection.executionId,
        activationId: activation.id,
        attemptId,
        workspaceId: projection.workspaceId!,
        rootChatId: projection.rootChatId!,
        provider: step.agent.provider as ProviderId,
        runTemplate: template
      })
    } catch (error) {
      this.requireAction(
        projection,
        attempt,
        `Queue materialization failed: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    if (
      job.runId !== runId ||
      job.status !== 'paused' ||
      job.chatId !== projection.rootChatId ||
      job.workspaceId !== projection.workspaceId ||
      job.provider !== step.agent.provider
    ) {
      this.requireAction(
        projection,
        attempt,
        'Queue materialization did not preserve graph identity or paused readiness.'
      )
      return
    }
    const queued = this.deps.transitionQueueJob(runId, 'queued', {
      statusReason: 'Execution-graph dependencies are satisfied.'
    })
    if (!queued || queued.status !== 'queued') {
      this.requireAction(projection, attempt, 'Claimed queue job could not be released.')
      return
    }
    this.appendAttemptQueued(projection, attempt)
  }

  private appendAttemptQueued(projection: ExecutionRunProjection, attempt: StepAttempt): void {
    const activation = projection.activations[attempt.activationId]
    this.append(projection, [
      {
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId: attempt.id,
        state: 'queued',
        providerRunRef: attempt.providerRunRef,
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'queued',
        reason: 'Published to the ordinary TaskWraith run queue.',
        timestamp: this.now()
      }
    ])
    this.changed(this.requireExecution(projection.executionId), 'execution-progressed', [
      attempt.stepId
    ])
  }

  private markAttemptRunning(projection: ExecutionRunProjection, attempt: StepAttempt): void {
    const activation = projection.activations[attempt.activationId]
    const events: ExecutionRunEventInput[] = []
    if (attempt.state !== 'running') {
      events.push({
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId: attempt.id,
        state: 'running',
        providerRunRef: attempt.providerRunRef,
        timestamp: this.now()
      })
    }
    if (activation.state !== 'running') {
      events.push({
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'running',
        reason: 'Provider run is active.',
        timestamp: this.now()
      })
    }
    if (!events.length) return
    this.append(projection, events)
    this.changed(this.requireExecution(projection.executionId), 'execution-progressed', [
      attempt.stepId
    ])
  }

  private settleAttempt(
    projection: ExecutionRunProjection,
    attempt: StepAttempt,
    status: 'completed' | 'failed' | 'cancelled'
  ): void {
    if (!isStepAttemptTerminal(attempt.state) && attempt.state !== 'running') {
      this.markAttemptRunning(projection, attempt)
      projection = this.requireExecution(projection.executionId)
      attempt = projection.attempts[attempt.id]
    }
    if (isStepAttemptTerminal(attempt.state)) return
    const activation = projection.activations[attempt.activationId]
    if (status === 'completed') {
      this.append(projection, [
        {
          executionId: projection.executionId,
          kind: 'attempt_state_changed',
          attemptId: attempt.id,
          state: 'succeeded',
          providerRunRef: attempt.providerRunRef,
          result: executionResult(attempt.providerRunRef!, projection.rootChatId),
          timestamp: this.now()
        },
        {
          executionId: projection.executionId,
          kind: 'activation_state_changed',
          activationId: activation.id,
          state: 'succeeded',
          reason: 'Provider run completed.',
          timestamp: this.now()
        }
      ])
      this.changed(this.requireExecution(projection.executionId), 'execution-progressed', [
        attempt.stepId
      ])
      this.drain(projection.executionId)
      return
    }
    const failedState = status === 'failed' ? 'failed' : 'cancelled'
    const events: ExecutionRunEventInput[] = [
      {
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId: attempt.id,
        state: failedState,
        providerRunRef: attempt.providerRunRef,
        error: status === 'failed' ? 'Provider run failed.' : 'Provider run was cancelled.',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: failedState,
        reason: status === 'failed' ? 'Provider run failed.' : 'Provider run was cancelled.',
        timestamp: this.now()
      }
    ]
    for (const downstream of Object.values(projection.activations)) {
      if (downstream.id === activation.id || isStepActivationTerminal(downstream.state)) continue
      if (downstream.state === 'dormant' || downstream.state === 'ready') {
        events.push({
          executionId: projection.executionId,
          kind: 'activation_state_changed',
          activationId: downstream.id,
          state: status === 'failed' ? 'skipped' : 'cancelled',
          reason: 'A predecessor did not succeed.',
          timestamp: this.now()
        })
      }
    }
    events.push({
      executionId: projection.executionId,
      kind: 'execution_state_changed',
      state: failedState,
      reason: status === 'failed' ? 'A Stack step failed.' : 'A Stack step was cancelled.',
      timestamp: this.now()
    })
    this.append(projection, events)
    this.changed(this.requireExecution(projection.executionId), 'execution-terminal')
  }

  private settleAnchor(
    projection: ExecutionRunProjection,
    status: 'completed' | 'failed' | 'cancelled'
  ): void {
    if (!this.isWaitingForAnchor(projection)) return
    if (status === 'completed') {
      this.append(projection, [
        {
          executionId: projection.executionId,
          kind: 'execution_state_changed',
          state: 'running',
          reason: 'The Stack anchor run completed.',
          timestamp: this.now()
        }
      ])
      this.changed(this.requireExecution(projection.executionId), 'execution-progressed')
      this.drain(projection.executionId)
      return
    }
    const events: ExecutionRunEventInput[] = []
    for (const activation of Object.values(projection.activations)) {
      if (isStepActivationTerminal(activation.state)) continue
      events.push({
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: status === 'failed' ? 'skipped' : 'cancelled',
        reason: 'The Stack anchor did not succeed.',
        timestamp: this.now()
      })
    }
    events.push({
      executionId: projection.executionId,
      kind: 'execution_state_changed',
      state: status,
      reason: 'The Stack anchor did not succeed.',
      timestamp: this.now()
    })
    this.append(projection, events)
    this.changed(this.requireExecution(projection.executionId), 'execution-terminal')
  }

  private recoverAnchor(projection: ExecutionRunProjection): void {
    const anchorRunRef = projection.anchorRunRef!
    let status: ExecutionGraphAnchorRunStatus
    try {
      status = this.deps.resolveAnchorRunStatus(anchorRunRef)
    } catch (error) {
      this.requireAnchorAction(
        projection,
        `Anchor status could not be reconciled after restart: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }

    if (status === 'nonterminal') return
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.settleAnchor(projection, status)
      return
    }
    this.requireAnchorAction(
      projection,
      status === 'missing'
        ? 'The Stack anchor run is missing after restart and cannot be inferred safely.'
        : 'The Stack anchor run has ambiguous queue/provider state after restart.'
    )
  }

  private isWaitingForAnchor(projection: ExecutionRunProjection): boolean {
    const activations = Object.values(projection.activations)
    return Boolean(
      projection.anchorRunRef &&
      projection.state === 'waiting' &&
      activations.length > 0 &&
      activations.every((activation) => activation.state === 'dormant') &&
      Object.keys(projection.attempts).length === 0
    )
  }

  private requireAnchorAction(projection: ExecutionRunProjection, reason: string): void {
    this.append(projection, [
      {
        executionId: projection.executionId,
        kind: 'execution_state_changed',
        state: 'requires_action',
        reason,
        timestamp: this.now()
      }
    ])
    this.changed(this.requireExecution(projection.executionId), 'execution-progressed')
  }

  private completeDeterministicStep(
    projection: ExecutionRunProjection,
    activation: StepActivation
  ): void {
    const attemptId = this.id('attempt')
    const result: ExecutionStepResult = {
      schemaVersion: 1,
      artifactRefs: [],
      trust: 'deterministic'
    }
    this.append(projection, [
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'claimed',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'attempt_created',
        attemptId,
        activationId: activation.id,
        stepId: activation.stepId,
        ordinal: 1,
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId,
        state: 'claimed',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId,
        state: 'running',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'running',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId,
        state: 'succeeded',
        result,
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'succeeded',
        timestamp: this.now()
      }
    ])
    this.changed(this.requireExecution(projection.executionId), 'execution-progressed', [
      activation.stepId
    ])
  }

  private failBlockedActivation(
    projection: ExecutionRunProjection,
    activation: StepActivation
  ): void {
    this.append(projection, [
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'skipped',
        reason: 'A predecessor did not succeed.',
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'execution_state_changed',
        state: 'failed',
        reason: 'The success-only Stack dependency cannot be satisfied.',
        timestamp: this.now()
      }
    ])
    this.changed(this.requireExecution(projection.executionId), 'execution-terminal', [
      activation.stepId
    ])
  }

  private requireAction(
    projection: ExecutionRunProjection,
    attempt: StepAttempt,
    reason: string
  ): void {
    const activation = projection.activations[attempt.activationId]
    const events: ExecutionRunEventInput[] = []
    if (
      attempt.state === 'created' ||
      attempt.state === 'claimed' ||
      attempt.state === 'queued' ||
      attempt.state === 'running'
    ) {
      events.push({
        executionId: projection.executionId,
        kind: 'attempt_state_changed',
        attemptId: attempt.id,
        state: 'interrupted',
        providerRunRef: attempt.providerRunRef,
        error: reason,
        timestamp: this.now()
      })
    }
    if (activation.state !== 'requires_action') {
      events.push({
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'requires_action',
        reason,
        timestamp: this.now()
      })
    }
    if (projection.state !== 'requires_action') {
      events.push({
        executionId: projection.executionId,
        kind: 'execution_state_changed',
        state: 'requires_action',
        reason,
        timestamp: this.now()
      })
    }
    this.append(projection, events)
    this.changed(this.requireExecution(projection.executionId), 'execution-progressed', [
      attempt.stepId
    ])
  }

  private requireActivationAction(
    projection: ExecutionRunProjection,
    activation: StepActivation,
    reason: string
  ): void {
    this.append(projection, [
      {
        executionId: projection.executionId,
        kind: 'activation_state_changed',
        activationId: activation.id,
        state: 'requires_action',
        reason,
        timestamp: this.now()
      },
      {
        executionId: projection.executionId,
        kind: 'execution_state_changed',
        state: 'requires_action',
        reason,
        timestamp: this.now()
      }
    ])
    this.changed(this.requireExecution(projection.executionId), 'execution-progressed', [
      activation.stepId
    ])
  }

  private assertAppendAuthority(
    projection: ExecutionRunProjection,
    input: AppendExecutionStackStepInput
  ): void {
    if (
      projection.workspaceId !== input.workspaceId ||
      projection.rootChatId !== input.rootChatId ||
      projection.tenant?.kind !== 'stack'
    ) {
      throw new Error('Stack execution does not belong to this workspace and chat.')
    }
    const ceiling = projection.permissionCeilingRef
    if (
      !ceiling ||
      ceiling.referenceId !== input.permissionCeilingRef.referenceId ||
      ceiling.authorityDigest !== input.permissionCeilingRef.authorityDigest ||
      ceiling.workspaceId !== input.permissionCeilingRef.workspaceId
    ) {
      throw new Error('A Stack append cannot widen or replace its permission ceiling.')
    }
  }

  private append(
    projection: ExecutionRunProjection,
    events: readonly ExecutionRunEventInput[]
  ): void {
    if (!events.length) return
    const options: AppendExecutionEventOptions = {
      expectedLastSequence: projection.lastSequence
    }
    this.repository.appendExecutionEvents(events, options)
  }

  private changed(
    projection: ExecutionRunProjection,
    kind: ExecutionGraphChangedNotice['kind'],
    changedStepIds?: readonly string[]
  ): void {
    this.deps.onChanged?.({
      schemaVersion: 1,
      executionId: projection.executionId,
      workspaceId: projection.workspaceId ?? '',
      ...(projection.rootChatId ? { rootChatId: projection.rootChatId } : {}),
      sequence: projection.lastSequence,
      kind,
      ...(changedStepIds?.length ? { changedStepIds } : {})
    })
  }

  private findOpenStack(
    workspaceId: string,
    rootChatId: string
  ): ExecutionRunProjection | undefined {
    return this.listExecutions({ workspaceId, rootChatId, includeTerminal: false }).find(
      (projection) => projection.tenant?.kind === 'stack'
    )
  }

  private requireExecution(executionId: string): ExecutionRunProjection {
    const projection = this.repository.getExecution(executionId)
    if (!projection) throw new Error(`Execution "${executionId}" was not found.`)
    return projection
  }

  private id(prefix: string): string {
    return `${prefix}-${canonicalPart(this.createId())}`
  }
}
