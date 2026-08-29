import { createHash, randomUUID } from 'node:crypto'
import type { RunSessionChangeEvent, RunSessionStatus } from '../RunManager'
import type { ProviderId, RunQueueJob, RunQueueJobStatus } from '../store/types'
import type {
  ExecutionEffect,
  ExecutionGraphRevision,
  ExecutionOwnerRef,
  ExecutionPermissionCeilingRef,
  ExecutionStepDefinition,
  ExecutionStepResult,
  ExecutionTenantRef,
  StepActivation,
  StepAttempt
} from '../executionGraph/ExecutionGraphModel'
import {
  executionGraphRevisionRef,
  stableExecutionGraphStringify
} from '../executionGraph/ExecutionGraphCompiler'
import {
  executionTopologyFrontier,
  isExecutionRunTerminal,
  isStepActivationTerminal,
  isStepAttemptTerminal,
  prepareUserFrontierAppend,
  type StepAppendedEvent,
  type ExecutionRunEventInput,
  type ExecutionRunProjection
} from '../executionGraph/ExecutionGraphRun'
import type {
  AppendExecutionEventOptions,
  ExecutionCreatedEventInput,
  ExecutionGraphRepository,
  ExecutionGraphRunTemplate
} from '../executionGraph/ExecutionGraphRepository'
import {
  resolveExecutionGraphTerminalBarrier,
  type ExecutionGraphAttemptResultBinding,
  type ExecutionGraphAttemptTerminalReceipt,
  type ExecutionGraphTerminalBarrierResolution
} from '../executionGraph/ExecutionGraphAttemptResult'

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
  /** Canonical renderer nonce used only for durable mutation idempotency. */
  readonly clientRequestId: string
  /** Main-computed digest of the canonical renderer submission. */
  readonly clientSubmissionDigest: string
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

export interface ResolveExecutionStackAppendReceiptInput {
  readonly clientRequestId: string
  readonly clientSubmissionDigest: string
  readonly workspaceId: string
  readonly rootChatId: string
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
  /** Exact structured predecessor results bound through this step's data edges. */
  readonly inputs?: Readonly<Record<string, ExecutionStepResult>>
  /** Main-minted authority root inherited from the execution creation event. */
  readonly permissionCeilingAuthorityDigest: string
}

export interface StartExecutionGraphInput {
  readonly executionId: string
  readonly title: string
  readonly workspaceId: string
  readonly rootChatId: string
  readonly tenant: ExecutionTenantRef
  readonly revision: ExecutionGraphRevision
  readonly permissionCeilingRef: ExecutionPermissionCeilingRef
  readonly anchorRunRef?: string
  /** The thread/seat answerable for this execution. Unowned graphs never
   * dispatch — see the owner gate in `drainOne`. */
  readonly owner?: ExecutionOwnerRef
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

export type ExecutionGraphRunSessionDisposition = 'accepted' | 'rejected' | 'unclaimed'

export interface ExecutionGraphRecoveryDiagnostic {
  readonly executionId: string
  readonly message: string
}

export interface ExecutionGraphCoordinatorRepository {
  createExecution: ExecutionGraphRepository['createExecution']
  appendExecutionEvents: ExecutionGraphRepository['appendExecutionEvents']
  readExecutionEvents: ExecutionGraphRepository['readExecutionEvents']
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
  resolveAnchorRunStatus: (
    runId: string,
    expected?: { readonly workspaceId: string; readonly rootChatId?: string }
  ) => ExecutionGraphAnchorRunStatus
  /**
   * Stop the exact provider transport. `true` means cleanup was confirmed;
   * `false` means no exact transport could be stopped. A matching terminal
   * RunManager event emitted synchronously while this call runs is also
   * authoritative confirmation.
   */
  cancelActiveRun: (runId: string) => Promise<boolean> | boolean
  /** Notify the main-owned dispatcher after a queued attempt is durable. */
  onAttemptQueued?: (runId: string) => void
  onChanged?: (notice: ExecutionGraphChangedNotice) => void
  now?: () => string
  createId?: () => string
}

const TERMINAL_QUEUE_STATUSES = new Set<RunQueueJobStatus>(['completed', 'failed', 'cancelled'])
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type StackAppendAuthorityContext = Pick<
  ExecutionRunProjection,
  | 'executionId'
  | 'workspaceId'
  | 'rootChatId'
  | 'tenant'
  | 'state'
  | 'topology'
  | 'permissionCeilingRef'
  | 'anchorRunRef'
>

/**
 * RunQueue's generic startup recovery cannot know whether a provider crossed
 * its side-effect boundary. It rewrites interrupted jobs to a convenient queue
 * state (usually `failed`, or `queued` for a stale steer promotion), but that
 * state is not provider-result evidence for the execution ledger.
 */
function startupRecoveryUncertainty(job: RunQueueJob): string | undefined {
  const hasSteerPromotionEvidence =
    job.status === 'steer_promoting' ||
    job.recoveryReason === 'stale_steer_promoting_recovered' ||
    Boolean(
      job.promotionOwnerToken ||
      job.promotionToken ||
      job.promotedAt ||
      job.queueMessageId ||
      job.promotionAttempt !== undefined
    )
  const wasRewrittenDuringStartup = Boolean(
    job.recoveryReason ||
    job.interruptedAt ||
    job.recoveredAt ||
    job.orphanProcess ||
    hasSteerPromotionEvidence
  )
  if (!wasRewrittenDuringStartup) return undefined

  if (job.orphanProcess?.alive) {
    return 'Startup recovery found a provider process that may still be running outside TaskWraith.'
  }
  if (hasSteerPromotionEvidence) {
    return 'Startup recovery found an interrupted steer promotion whose dispatch boundary is uncertain.'
  }
  return 'Startup recovery rewrote the claimed queue job without authoritative provider outcome evidence.'
}

/**
 * Admission profile for the first structured-data graph runtime. It remains
 * deliberately narrower than the generic compiler: solo agents, all-joins,
 * and terminal outputs only; one attempt; no unenforced time/token/cost limits.
 */
function assertBoundExecutionGraphSupported(revision: ExecutionGraphRevision): void {
  if (revision.steps.length === 0) throw new Error('Bound execution graph requires steps.')
  if (
    revision.limits.maxWallClockMs !== undefined ||
    revision.limits.maxTokens !== undefined ||
    revision.limits.maxCostUsd !== undefined
  ) {
    throw new Error('Bound execution graph cannot start with unenforced budgets.')
  }
  for (const step of revision.steps) {
    if (step.retry.maxAttempts !== 1 || step.retry.backoffMs !== undefined) {
      throw new Error('Bound execution graph currently admits one attempt per step.')
    }
    if (step.timeoutMs !== undefined) {
      throw new Error('Bound execution graph cannot start with an unenforced step timeout.')
    }
    if (step.kind === 'join') {
      if (step.join.mode !== 'all') {
        throw new Error('Bound execution graph currently admits only all-joins.')
      }
      continue
    }
    if (step.kind !== 'solo_agent' && step.kind !== 'output') {
      throw new Error(`Bound execution graph cannot execute ${step.kind} steps.`)
    }
    if (step.kind === 'output' && (step.inputs?.length !== 1 || step.inputs[0]?.required !== true)) {
      throw new Error('Bound execution graph output steps require one required data input.')
    }
    if (step.kind === 'solo_agent' && !step.agent.runTemplateRef?.trim()) {
      throw new Error('Bound execution graph solo-agent steps require a run template.')
    }
  }
}

function canonicalPart(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80)
  return normalized || randomUUID()
}

function canonicalClientRequestId(value: string): string {
  const normalized = String(value || '').trim()
  if (!CLIENT_REQUEST_ID_PATTERN.test(normalized)) {
    throw new Error(
      'Stack append client request id must be a canonical id (1-128 ASCII letters, numbers, period, underscore, or hyphen).'
    )
  }
  return normalized
}

function appendClientRequestDigest(
  projection: StackAppendAuthorityContext,
  input: AppendExecutionStackStepInput
): string {
  const normalizedModel = input.model?.trim()
  return createHash('sha256')
    .update(
      stableExecutionGraphStringify({
        schemaVersion: 1,
        target: {
          executionId: projection.executionId,
          workspaceId: input.workspaceId,
          rootChatId: input.rootChatId,
          anchorRunRef: projection.anchorRunRef ?? null
        },
        requestedExecutionTitle: input.title?.trim() || 'Task Stack',
        step: {
          title: input.stepTitle.trim(),
          objective: input.objective.trim(),
          provider: input.provider,
          model: normalizedModel || null,
          effect: input.effect,
          runTemplateRef: input.runTemplateRef.trim(),
          permissionCeilingRef: {
            schemaVersion: input.permissionCeilingRef.schemaVersion,
            referenceId: input.permissionCeilingRef.referenceId,
            authorityDigest: input.permissionCeilingRef.authorityDigest,
            workspaceId: input.permissionCeilingRef.workspaceId ?? null
          }
        }
      })
    )
    .digest('hex')
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
  private readonly cancellationOperations = new Map<string, Promise<void>>()
  private readonly cancellationContexts = new Map<
    string,
    {
      readonly terminalOutcomes: Map<
        string,
        {
          readonly ok: true
          readonly status: 'completed' | 'failed' | 'cancelled'
          readonly result?: ExecutionStepResult
          readonly error?: string
        }
      >
      readonly invalidRunIds: Set<string>
    }
  >()

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

  /**
   * Start a precompiled graph whose revision is already durably registered in
   * the repository. Product adapters (UltraTask, Workflow, Audit) own graph
   * construction; the coordinator owns only exact activation/runtime state.
   */
  startExecutionGraph(input: StartExecutionGraphInput): ExecutionRunProjection {
    assertBoundExecutionGraphSupported(input.revision)
    for (const step of input.revision.steps) {
      if (
        step.permissionRequestRef &&
        (step.permissionRequestRef.ceilingReferenceId !== input.permissionCeilingRef.referenceId ||
          !step.permissionRequestRef.authorityDigest?.trim())
      ) {
        throw new Error(
          `Execution graph step "${step.id}" has an invalid permission request binding.`
        )
      }
    }
    const baseRevision = executionGraphRevisionRef(input.revision)
    const timestamp = this.now()
    const activations = input.revision.steps.map((step) => ({
      executionId: input.executionId,
      kind: 'activation_created' as const,
      activationId: this.id('activation'),
      stepId: step.id,
      timestamp
    }))
    const state = input.anchorRunRef ? 'waiting' : 'running'
    const projection = this.repository.createExecution(
      {
        executionId: input.executionId,
        kind: 'execution_created',
        title: input.title,
        workspaceId: input.workspaceId,
        rootChatId: input.rootChatId,
        tenant: input.tenant,
        baseRevision,
        permissionCeilingRef: input.permissionCeilingRef,
        ...(input.anchorRunRef ? { anchorRunRef: input.anchorRunRef } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        timestamp
      },
      [
        ...activations,
        {
          executionId: input.executionId,
          kind: 'execution_state_changed',
          state,
          reason: input.anchorRunRef
            ? 'Waiting for the execution anchor run to finish.'
            : 'Compiled execution graph is ready.',
          timestamp
        }
      ]
    )
    this.changed(
      projection,
      'execution-created',
      input.revision.steps.map((step) => step.id)
    )
    if (!input.anchorRunRef) this.drain(input.executionId)
    return this.requireExecution(input.executionId)
  }

  /**
   * Fail-closed main-boundary check for the lease and provider-start seams.
   * Call this immediately before either boundary for graph-owned queue rows.
   */
  assertQueueJobDispatchable(runId: string): RunQueueJob {
    const job = this.deps.getQueueJob(runId)
    const binding = job?.executionGraph
    if (!job || job.runId !== runId || !binding) {
      throw new Error(`Queue run "${runId}" is not an exact execution-graph job.`)
    }
    const projection = this.repository.getExecution(binding.executionId)
    const attempt = projection?.attempts[binding.attemptId]
    const activation = attempt ? projection?.activations[attempt.activationId] : undefined
    if (
      !projection ||
      projection.integrity !== 'valid' ||
      projection.baseRevisionMissing ||
      isExecutionRunTerminal(projection.state) ||
      projection.state === 'waiting' ||
      projection.state === 'requires_action' ||
      !attempt ||
      !activation ||
      (attempt.state !== 'claimed' && attempt.state !== 'queued') ||
      (activation.state !== 'claimed' && activation.state !== 'queued') ||
      (job.status !== 'queued' && job.status !== 'starting') ||
      this.cancellationContexts.has(projection.executionId) ||
      !this.queueJobOwnsAttempt(projection, attempt, job)
    ) {
      throw new Error(
        `Queue run "${runId}" is not dispatchable under its execution-graph authority.`
      )
    }
    return job
  }

  /**
   * Reconcile a main-owned failure that occurred before RunManager could emit
   * authoritative provider evidence. The exact queue row is terminalized
   * first, then the graph is attention-gated rather than inventing a provider
   * success/failure result.
   */
  recordPreSessionDispatchFailure(runId: string, reason: string): ExecutionRunProjection {
    const detail = reason.trim()
    if (!detail) throw new Error('Pre-session dispatch failure requires a reason.')
    const job = this.deps.getQueueJob(runId)
    const binding = job?.executionGraph
    if (!job || job.runId !== runId || !binding) {
      throw new Error(`Queue run "${runId}" is not an exact execution-graph job.`)
    }
    let projection = this.requireExecution(binding.executionId)
    const attempt = projection.attempts[binding.attemptId]
    if (
      isExecutionRunTerminal(projection.state) ||
      !attempt ||
      isStepAttemptTerminal(attempt.state) ||
      !this.queueJobOwnsAttempt(projection, attempt, job) ||
      (job.status !== 'queued' &&
        job.status !== 'paused' &&
        job.status !== 'starting' &&
        job.status !== 'failed')
    ) {
      throw new Error(`Queue run "${runId}" cannot record a verified pre-session dispatch failure.`)
    }

    let contained: RunQueueJob | null = null
    let containmentError: unknown
    try {
      contained = this.deps.transitionQueueJob(runId, 'failed', {
        statusReason: 'Execution graph dispatch failed before provider session creation.',
        lastError: detail
      })
    } catch (error) {
      containmentError = error
    }
    projection = this.requireExecution(binding.executionId)
    const currentAttempt = projection.attempts[binding.attemptId]
    const containmentConfirmed = Boolean(
      contained &&
      contained.status === 'failed' &&
      currentAttempt &&
      this.queueJobOwnsAttempt(projection, currentAttempt, contained)
    )
    const attentionReason = containmentConfirmed
      ? `Provider dispatch did not create a RunManager session: ${detail}`
      : `Provider dispatch failed and queue containment could not be confirmed: ${
          containmentError instanceof Error
            ? containmentError.message
            : containmentError
              ? String(containmentError)
              : detail
        }`
    if (currentAttempt && !isStepAttemptTerminal(currentAttempt.state)) {
      this.requireAction(projection, currentAttempt, attentionReason)
    }
    if (!containmentConfirmed) {
      throw new Error(attentionReason)
    }
    return this.requireExecution(binding.executionId)
  }

  /**
   * Attention-gate the exact graph attempt when an unsupported continuation
   * path (for example a host-process rerun) is encountered before the provider
   * can produce an authoritative terminal result.
   */
  requireActionForProviderRun(
    runId: string,
    reason: string
  ): ExecutionRunProjection | undefined {
    const claims = this.listExecutions({ includeTerminal: false }).flatMap((projection) =>
      Object.values(projection.attempts)
        .filter(
          (attempt) =>
            attempt.providerRunRef === runId && !isStepAttemptTerminal(attempt.state)
        )
        .map((attempt) => ({ projection, attempt }))
    )
    if (claims.length > 1) {
      throw new Error(`Provider run "${runId}" is claimed by multiple execution attempts.`)
    }
    const claim = claims[0]
    if (!claim) return undefined
    const job = this.deps.getQueueJob(runId)
    if (!job || !this.queueJobOwnsAttempt(claim.projection, claim.attempt, job)) {
      throw new Error(`Provider run "${runId}" lacks its exact graph queue authority.`)
    }
    const detail = reason.trim()
    if (!detail) throw new Error('Execution graph attention requires a reason.')
    this.requireAction(claim.projection, claim.attempt, detail)
    return this.requireExecution(claim.projection.executionId)
  }

  appendStackStep(input: AppendExecutionStackStepInput): ExecutionRunProjection {
    const clientRequestId = canonicalClientRequestId(input.clientRequestId)
    if (!SHA256_PATTERN.test(input.clientSubmissionDigest)) {
      throw new Error('Stack append submission digest is invalid.')
    }
    const existingReceipt = this.findClientRequestReceipt(clientRequestId)
    if (existingReceipt) {
      const projection = this.requireExecution(existingReceipt.event.executionId)
      if (
        existingReceipt.event.clientRequestReceipt?.clientSubmissionDigest !==
        input.clientSubmissionDigest
      ) {
        throw new Error(
          `Stack append client request id "${clientRequestId}" was already used with a different submitted payload.`
        )
      }
      if (input.executionId && input.executionId !== projection.executionId) {
        throw new Error(
          `Stack append client request id "${clientRequestId}" was already used for a different execution.`
        )
      }
      this.assertAppendAuthority(projection, input)
      const retryDigest = appendClientRequestDigest(projection, input)
      if (retryDigest !== existingReceipt.event.clientRequestReceipt!.clientRequestDigest) {
        throw new Error(
          `Stack append client request id "${clientRequestId}" was already used with a different payload or target.`
        )
      }
      return projection
    }

    let projection = input.executionId
      ? this.requireExecution(input.executionId)
      : this.findOpenStack(input.workspaceId, input.rootChatId)
    let creationInput: ExecutionCreatedEventInput | undefined
    const appendContext: StackAppendAuthorityContext = projection
      ? projection
      : {
          executionId: this.id('stack'),
          workspaceId: input.workspaceId,
          rootChatId: input.rootChatId,
          tenant: { kind: 'stack', tenantId: input.rootChatId },
          state: 'pending',
          topology: { steps: [], edges: [] },
          permissionCeilingRef: input.permissionCeilingRef,
          ...(input.anchorRunRef ? { anchorRunRef: input.anchorRunRef } : {})
        }
    if (!projection) {
      creationInput = {
        executionId: appendContext.executionId,
        kind: 'execution_created',
        title: input.title?.trim() || 'Task Stack',
        workspaceId: input.workspaceId,
        tenant: { kind: 'stack', tenantId: input.rootChatId },
        rootChatId: input.rootChatId,
        ...(input.anchorRunRef ? { anchorRunRef: input.anchorRunRef } : {}),
        permissionCeilingRef: input.permissionCeilingRef,
        timestamp: this.now()
      }
    }

    this.assertAppendAuthority(appendContext, input)
    if (isExecutionRunTerminal(appendContext.state)) {
      throw new Error(
        `Execution "${appendContext.executionId}" is already ${appendContext.state}.`
      )
    }
    const frontier = executionTopologyFrontier(appendContext.topology)
    if (frontier.length > 1) {
      throw new Error('V1 Stack append requires exactly one open frontier step.')
    }

    const stepId = this.id('step')
    const activationId = this.id('activation')
    const normalizedModel = input.model?.trim()
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
        ceilingReferenceId: appendContext.permissionCeilingRef!.referenceId,
        authorityDigest: input.permissionCeilingRef.authorityDigest
      },
      agent: {
        provider: input.provider,
        ...(normalizedModel ? { model: normalizedModel } : {}),
        runTemplateRef: input.runTemplateRef.trim(),
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
        executionId: appendContext.executionId,
        topology: appendContext.topology,
        runState: appendContext.state,
        permissionCeilingRef: appendContext.permissionCeilingRef
      },
      { appendedBy: 'user', step, incomingEdges }
    )
    if (!prepared.ok) {
      throw new Error(
        `Stack append was rejected: ${prepared.issues.map((issue) => issue.code).join(', ')}.`
      )
    }

    const events: ExecutionRunEventInput[] = [
      {
        ...prepared.input,
        clientRequestReceipt: {
          clientRequestId,
          clientRequestDigest: appendClientRequestDigest(appendContext, input),
          clientSubmissionDigest: input.clientSubmissionDigest
        },
        timestamp: this.now()
      },
      {
        executionId: appendContext.executionId,
        kind: 'activation_created',
        activationId,
        stepId,
        timestamp: this.now()
      }
    ]
    if (appendContext.state === 'pending') {
      events.push({
        executionId: appendContext.executionId,
        kind: 'execution_state_changed',
        state: appendContext.anchorRunRef ? 'waiting' : 'running',
        reason: appendContext.anchorRunRef
          ? 'Waiting for the Stack anchor run to finish.'
          : 'Stack is ready to execute.',
        timestamp: this.now()
      })
    }
    if (creationInput) {
      projection = this.repository.createExecution(creationInput, events)
      this.changed(projection, 'execution-created')
    } else {
      this.append(projection!, events)
      projection = this.requireExecution(appendContext.executionId)
    }
    this.changed(projection, 'step-appended', [stepId])
    this.drain(projection.executionId)
    return this.requireExecution(projection.executionId)
  }

  /**
   * Resolve an already-committed renderer mutation before consulting live
   * anchor, attachment, or permission state. The submission digest is minted
   * by the main handler, while durable ownership is still checked against the
   * resulting execution.
   */
  resolveStackAppendReceipt(
    input: ResolveExecutionStackAppendReceiptInput
  ): ExecutionRunProjection | undefined {
    const clientRequestId = canonicalClientRequestId(input.clientRequestId)
    if (!SHA256_PATTERN.test(input.clientSubmissionDigest)) {
      throw new Error('Stack append submission digest is invalid.')
    }
    const existingReceipt = this.findClientRequestReceipt(clientRequestId)
    if (!existingReceipt) return undefined
    if (
      existingReceipt.event.clientRequestReceipt?.clientSubmissionDigest !==
      input.clientSubmissionDigest
    ) {
      throw new Error(
        `Stack append client request id "${clientRequestId}" was already used with a different submitted payload.`
      )
    }
    const projection = this.requireExecution(existingReceipt.event.executionId)
    if (
      projection.workspaceId !== input.workspaceId ||
      projection.rootChatId !== input.rootChatId
    ) {
      throw new Error(
        `Stack append client request id "${clientRequestId}" was already used for a different execution target.`
      )
    }
    return projection
  }

  drain(executionId?: string): void {
    const ids = executionId
      ? [executionId]
      : this.listExecutions({ includeTerminal: false }).map((projection) => projection.executionId)
    for (const id of ids) this.drainOne(id)
  }

  onRunSessionChange(
    event: RunSessionChangeEvent,
    terminalReceipt?: ExecutionGraphAttemptTerminalReceipt
  ): ExecutionGraphRunSessionDisposition {
    if (event.type === 'removed') return 'unclaimed'
    const runId = event.session.runId
    const projections = this.listExecutions({ includeTerminal: false })
    let disposition: ExecutionGraphRunSessionDisposition = 'unclaimed'
    for (const projection of projections) {
      if (projection.anchorRunRef === runId && terminalSession(event.session.status)) {
        if (!projection.workspaceId) {
          this.requireAnchorAction(projection, 'Anchor execution has no durable workspace identity.')
          disposition = 'rejected'
          continue
        }
        let status: ExecutionGraphAnchorRunStatus
        try {
          status = this.deps.resolveAnchorRunStatus(runId, {
            workspaceId: projection.workspaceId,
            ...(projection.rootChatId ? { rootChatId: projection.rootChatId } : {})
          })
        } catch (error) {
          this.requireAnchorAction(
            projection,
            `Anchor terminal event could not be verified: ${error instanceof Error ? error.message : String(error)}`
          )
          disposition = 'rejected'
          continue
        }
        if (
          event.session.appChatId !== projection.rootChatId ||
          status !== event.session.status
        ) {
          this.requireAnchorAction(
            projection,
            'Anchor terminal event did not match the exact durable chat, workspace, and queue lifecycle.'
          )
          disposition = 'rejected'
          continue
        }
        this.settleAnchor(projection, event.session.status)
        if (disposition !== 'rejected') disposition = 'accepted'
        continue
      }
      const attempt = Object.values(projection.attempts).find(
        (candidate) => candidate.providerRunRef === runId
      )
      if (!attempt || isStepAttemptTerminal(attempt.state)) continue
      if (!this.runSessionOwnsAttempt(projection, attempt, event)) {
        this.cancellationContexts.get(projection.executionId)?.invalidRunIds.add(runId)
        disposition = 'rejected'
        continue
      }
      if (disposition !== 'rejected') disposition = 'accepted'
      if (event.session.status === 'starting' || event.session.status === 'running') {
        this.markAttemptRunning(projection, attempt)
      } else if (terminalSession(event.session.status)) {
        const terminal = resolveExecutionGraphTerminalBarrier({
          expectedBinding: this.attemptResultBinding(projection, attempt),
          providerStatus: event.session.status,
          receipt: terminalReceipt
        })
        if (!terminal.ok) {
          this.requireAction(
            projection,
            attempt,
            `Provider terminal result could not cross the durable result barrier: ${terminal.reason}`
          )
          continue
        }
        const cancellation = this.cancellationContexts.get(projection.executionId)
        if (cancellation) {
          cancellation.terminalOutcomes.set(runId, terminal)
        } else {
          this.settleAttempt(projection, attempt, terminal.status, terminal.result)
        }
      }
    }
    return disposition
  }

  cancelExecution(executionId: string, reason = 'Cancelled by user.'): Promise<void> {
    const existing = this.cancellationOperations.get(executionId)
    if (existing) return existing
    const operation = this.cancelExecutionOnce(executionId, reason).finally(() => {
      this.cancellationOperations.delete(executionId)
      this.cancellationContexts.delete(executionId)
    })
    this.cancellationOperations.set(executionId, operation)
    return operation
  }

  private async cancelExecutionOnce(executionId: string, reason: string): Promise<void> {
    let projection = this.requireExecution(executionId)
    if (isExecutionRunTerminal(projection.state)) return
    const startedInRequiresAction = projection.state === 'requires_action'
    const context = {
      terminalOutcomes: new Map<
        string,
        Extract<ExecutionGraphTerminalBarrierResolution, { readonly ok: true }>
      >(),
      invalidRunIds: new Set<string>()
    }
    this.cancellationContexts.set(executionId, context)
    const queueRuns: Array<{
      runId: string
      attemptId: string
    }> = []
    let cleanupFailed = false

    // First revoke every exact queue lease. Queued/paused work is terminally
    // contained because no provider boundary was crossed; starting/active
    // work moves to `cancelling` before any transport cleanup begins.
    for (const activation of Object.values(projection.activations)) {
      if (isStepActivationTerminal(activation.state)) continue
      const attempt = latestAttemptForActivation(projection, activation)
      if (attempt && !isStepAttemptTerminal(attempt.state)) {
        const runId = attempt.providerRunRef
        const job = runId ? this.deps.getQueueJob(runId) : null
        if (!runId || !job || !this.queueJobOwnsAttempt(projection, attempt, job)) {
          this.requireAction(
            this.requireExecution(executionId),
            this.requireExecution(executionId).attempts[attempt.id],
            'Cancellation cleanup could not prove the exact graph-owned queue job.'
          )
          cleanupFailed = true
          continue
        }
        if (TERMINAL_QUEUE_STATUSES.has(job.status)) {
          this.requireAction(
            this.requireExecution(executionId),
            this.requireExecution(executionId).attempts[attempt.id],
            'Cancellation found a terminal queue row without authoritative RunManager cleanup evidence.'
          )
          cleanupFailed = true
          continue
        }
        const beforeProviderStart = job.status === 'queued' || job.status === 'paused'
        const containmentState: RunQueueJobStatus = beforeProviderStart ? 'cancelled' : 'cancelling'
        let blocked: RunQueueJob | null = null
        try {
          blocked = this.deps.transitionQueueJob(runId, containmentState, {
            statusReason: beforeProviderStart
              ? 'Execution graph cancelled this exact queue row before provider start.'
              : 'Execution graph cancellation is blocking this exact queue lease.'
          })
        } catch (error) {
          this.recordCancellationCleanupFailure(
            executionId,
            attempt.id,
            runId,
            `Queue lease could not be blocked: ${error instanceof Error ? error.message : String(error)}`
          )
          cleanupFailed = true
          continue
        }
        projection = this.requireExecution(executionId)
        const currentAttempt = projection.attempts[attempt.id]
        if (
          !blocked ||
          blocked.status !== containmentState ||
          !currentAttempt ||
          !this.queueJobOwnsAttempt(projection, currentAttempt, blocked)
        ) {
          this.recordCancellationCleanupFailure(
            executionId,
            attempt.id,
            runId,
            'Queue lease did not enter the exact graph-owned cancelling state.'
          )
          cleanupFailed = true
          continue
        }
        if (!beforeProviderStart) queueRuns.push({ runId, attemptId: attempt.id })
      }
    }

    // Clean up each blocked run independently. RunManager may synchronously
    // re-enter this coordinator; terminal events are captured in the context
    // above and folded only after this cancellation call regains control.
    for (const queueRun of queueRuns) {
      let transportConfirmed = false
      let transportError: unknown
      try {
        transportConfirmed = await this.deps.cancelActiveRun(queueRun.runId)
      } catch (error) {
        transportError = error
      }

      const authoritativeOutcome = context.terminalOutcomes.get(queueRun.runId)
      if (
        authoritativeOutcome?.status === 'completed' ||
        authoritativeOutcome?.status === 'failed'
      ) {
        const current = this.requireExecution(executionId)
        const currentAttempt = current.attempts[queueRun.attemptId]
        if (currentAttempt && !isStepAttemptTerminal(currentAttempt.state)) {
          this.settleAttempt(
            current,
            currentAttempt,
            authoritativeOutcome.status,
            authoritativeOutcome.result
          )
        }
        continue
      }
      if (authoritativeOutcome?.status === 'cancelled') transportConfirmed = true

      if (!transportConfirmed || transportError || context.invalidRunIds.has(queueRun.runId)) {
        this.recordCancellationCleanupFailure(
          executionId,
          queueRun.attemptId,
          queueRun.runId,
          transportError
            ? `Provider transport cancellation failed: ${transportError instanceof Error ? transportError.message : String(transportError)}`
            : context.invalidRunIds.has(queueRun.runId)
              ? 'Provider cancellation emitted a RunManager event with mismatched graph identity.'
              : 'Provider transport cancellation could not confirm exact cleanup.'
        )
        cleanupFailed = true
        continue
      }

      let cancelledJob: RunQueueJob | null = null
      try {
        cancelledJob = this.deps.transitionQueueJob(queueRun.runId, 'cancelled', {
          statusReason: reason
        })
      } catch (error) {
        this.recordCancellationCleanupFailure(
          executionId,
          queueRun.attemptId,
          queueRun.runId,
          `Cancelled queue state could not be persisted: ${error instanceof Error ? error.message : String(error)}`
        )
        cleanupFailed = true
        continue
      }
      projection = this.requireExecution(executionId)
      const currentAttempt = projection.attempts[queueRun.attemptId]
      if (
        !cancelledJob ||
        cancelledJob.status !== 'cancelled' ||
        !currentAttempt ||
        !this.queueJobOwnsAttempt(projection, currentAttempt, cancelledJob)
      ) {
        this.recordCancellationCleanupFailure(
          executionId,
          queueRun.attemptId,
          queueRun.runId,
          'Exact queue cleanup could not be durably confirmed.'
        )
        cleanupFailed = true
      }
    }

    projection = this.requireExecution(executionId)
    if (
      cleanupFailed ||
      (projection.state === 'requires_action' &&
        (!startedInRequiresAction || !this.requiresActionCancellationIsContained(projection)))
    ) {
      this.cancellationContexts.delete(executionId)
      return
    }
    if (isExecutionRunTerminal(projection.state)) {
      this.cancellationContexts.delete(executionId)
      return
    }

    const events: ExecutionRunEventInput[] = []
    for (const activation of Object.values(projection.activations)) {
      if (isStepActivationTerminal(activation.state)) continue
      const attempt = latestAttemptForActivation(projection, activation)
      if (attempt && !isStepAttemptTerminal(attempt.state)) {
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
    this.cancellationContexts.delete(executionId)
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

  recover(): readonly ExecutionGraphRecoveryDiagnostic[] {
    const allExecutions = this.listExecutions({ includeTerminal: true })
    const diagnostics: ExecutionGraphRecoveryDiagnostic[] = []
    for (const projection of allExecutions) {
      try {
        this.reconcileTerminalAttemptQueueRows(projection)
        // The graph ledger is authoritative. If it is already terminal, no
        // stale queued/paused transport row may remain leaseable after restart.
        if (isExecutionRunTerminal(projection.state)) {
          this.containTerminalExecutionQueueRows(projection)
          continue
        }
        this.recoverExecution(projection)
      } catch (error) {
        diagnostics.push(
          Object.freeze({
            executionId: projection.executionId,
            message: String(error instanceof Error ? error.message : error).slice(0, 2_048)
          })
        )
      }
    }
    return Object.freeze(diagnostics)
  }

  private recoverExecution(projection: ExecutionRunProjection): void {
    if (projection.integrity !== 'valid' || projection.baseRevisionMissing) return

    if (this.isWaitingForAnchor(projection)) {
      this.recoverAnchor(projection)
      return
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
      return
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
      return
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
      if (!this.queueJobOwnsAttempt(projection, attempt, job)) {
        this.requireAction(
          projection,
          attempt,
          'The claimed queue job no longer carries this execution attempt authority.'
        )
        changed = true
        break
      }
      const recoveryUncertainty = startupRecoveryUncertainty(job)
      if (recoveryUncertainty) {
        this.requireAction(projection, attempt, recoveryUncertainty)
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
      if (job.status === 'queued' && attempt.state === 'queued') {
        this.deps.onAttemptQueued?.(job.runId)
        changed = true
        break
      }
      if (TERMINAL_QUEUE_STATUSES.has(job.status)) {
        this.requireAction(
          projection,
          attempt,
          `Queue status "${job.status}" is not authoritative provider terminal evidence after restart.`
        )
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
          if (step.kind === 'deterministic_check') {
            this.requireActivationAction(
              projection,
              ready,
              'Deterministic check executor is not bound for this execution graph.'
            )
            return
          }
          if (step.kind === 'join') {
            this.completeDeterministicStep(projection, ready)
            continue
          }
          if (step.kind === 'output') {
            const boundInputs = this.resolveStepInputResults(projection, step)
            if (!boundInputs.ok) {
              this.requireActivationAction(projection, ready, boundInputs.reason)
              return
            }
            const sourceResult = Object.values(boundInputs.inputs)[0]
            this.completeDeterministicStep(
              projection,
              ready,
              sourceResult
                ? {
                    schemaVersion: 1,
                    ...(sourceResult.output !== undefined ? { output: sourceResult.output } : {}),
                    ...(sourceResult.summary ? { summary: sourceResult.summary } : {}),
                    artifactRefs: [],
                    trust: sourceResult.trust,
                    ...(sourceResult.evidenceRefs
                      ? { evidenceRefs: sourceResult.evidenceRefs }
                      : {}),
                    ...(sourceResult.providerRunRef
                      ? { providerRunRef: sourceResult.providerRunRef }
                      : {}),
                    ...(sourceResult.threadRef ? { threadRef: sourceResult.threadRef } : {})
                  }
                : undefined
            )
            continue
          }
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
    const boundInputs = this.resolveStepInputResults(projection, step)
    if (!boundInputs.ok) {
      this.requireActivationAction(projection, activation, boundInputs.reason)
      return
    }
    const templateRef = step.agent.runTemplateRef
    const template = templateRef ? this.repository.getRunTemplate(templateRef) : undefined
    if (!template) {
      this.requireActivationAction(projection, activation, 'Run template is unavailable.')
      return
    }
    const attemptId = this.id('attempt')
    const runId = this.id('graph-run')
    const permissionAuthorityDigest = this.permissionAuthorityDigestForStep(projection, step)
    if (!permissionAuthorityDigest) {
      this.requireActivationAction(
        projection,
        activation,
        'Graph step permission request is unavailable or exceeds the execution ceiling.'
      )
      return
    }

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
        runTemplate: template,
        ...(Object.keys(boundInputs.inputs).length > 0 ? { inputs: boundInputs.inputs } : {}),
        permissionCeilingAuthorityDigest: permissionAuthorityDigest
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
      job.provider !== step.agent.provider ||
      !this.queueJobOwnsAttempt(projection, attempt, job)
    ) {
      if (job.runId === runId && job.status === 'paused') {
        this.deps.transitionQueueJob(runId, 'failed', {
          lastError: 'Execution graph queue authority binding was not preserved.'
        })
      }
      this.requireAction(
        projection,
        attempt,
        'Queue materialization did not preserve graph identity, authority, or paused readiness.'
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

  private resolveStepInputResults(
    projection: ExecutionRunProjection,
    step: ExecutionStepDefinition
  ): { ok: true; inputs: Record<string, ExecutionStepResult> } | { ok: false; reason: string } {
    const inputs: Record<string, ExecutionStepResult> = {}
    for (const port of step.inputs || []) {
      const edges = projection.topology.edges.filter(
        (edge): edge is Extract<typeof edge, { kind: 'data' }> =>
          edge.kind === 'data' && edge.to.stepId === step.id && edge.to.port === port.name
      )
      if (edges.length === 0) {
        if (port.required) {
          return {
            ok: false,
            reason: `Required graph input "${port.name}" has no data binding.`
          }
        }
        continue
      }
      if (edges.length !== 1) {
        return {
          ok: false,
          reason: `Graph input "${port.name}" has ${edges.length} data bindings; exactly one is required.`
        }
      }
      const edge = edges[0]!
      const sourceActivation = latestActivationForStep(projection, edge.from.stepId)
      const sourceAttempt = sourceActivation
        ? latestAttemptForActivation(projection, sourceActivation)
        : undefined
      if (
        sourceActivation?.state !== 'succeeded' ||
        sourceAttempt?.state !== 'succeeded' ||
        !sourceAttempt.result
      ) {
        return {
          ok: false,
          reason:
            `Graph input "${port.name}" is missing the terminal structured result from ` +
            `step "${edge.from.stepId}".`
        }
      }
      inputs[port.name] = sourceAttempt.result
    }
    return { ok: true, inputs }
  }

  private permissionAuthorityDigestForStep(
    projection: ExecutionRunProjection,
    step: ExecutionStepDefinition
  ): string | null {
    const ceiling = projection.permissionCeilingRef
    if (!ceiling) return null
    const request = step.permissionRequestRef
    if (!request) return ceiling.authorityDigest
    if (
      request.ceilingReferenceId !== ceiling.referenceId ||
      !request.authorityDigest?.trim()
    ) {
      return null
    }
    return request.authorityDigest
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
    if (attempt.providerRunRef) this.deps.onAttemptQueued?.(attempt.providerRunRef)
  }

  private queueJobOwnsAttempt(
    projection: ExecutionRunProjection,
    attempt: StepAttempt,
    job: RunQueueJob
  ): boolean {
    const activation = projection.activations[attempt.activationId]
    const step = projection.topology.steps.find((candidate) => candidate.id === attempt.stepId)
    const binding = job.executionGraph
    const template = binding?.runTemplateRef
      ? this.repository.getRunTemplate(binding.runTemplateRef)
      : undefined
    const templateContent = template?.content as Record<string, unknown> | undefined
    return Boolean(
      activation &&
      step?.kind === 'solo_agent' &&
      step.agent.runTemplateRef &&
      projection.permissionCeilingRef &&
      attempt.providerRunRef &&
      job.runId === attempt.providerRunRef &&
      job.scope === 'workspace' &&
      job.workspaceId === projection.workspaceId &&
      typeof job.workspacePath === 'string' &&
      templateContent &&
      templateContent.workspaceId === projection.workspaceId &&
      templateContent.workspacePath === job.workspacePath &&
      templateContent.chatId === projection.rootChatId &&
      templateContent.provider === job.provider &&
      job.chatId === projection.rootChatId &&
      job.provider === step.agent.provider &&
      binding?.schemaVersion === 1 &&
      binding.executionId === projection.executionId &&
      binding.activationId === activation.id &&
      binding.attemptId === attempt.id &&
      binding.runTemplateRef === step.agent.runTemplateRef &&
      binding.permissionCeilingAuthorityDigest ===
        this.permissionAuthorityDigestForStep(projection, step)
    )
  }

  private requiresActionCancellationIsContained(
    projection: ExecutionRunProjection
  ): boolean {
    for (const activation of Object.values(projection.activations)) {
      if (isStepActivationTerminal(activation.state)) continue
      const attempt = latestAttemptForActivation(projection, activation)
      if (!attempt) {
        if (
          activation.state === 'dormant' ||
          activation.state === 'ready' ||
          activation.state === 'requires_action'
        ) {
          continue
        }
        return false
      }
      const runId = attempt.providerRunRef
      const job = runId ? this.deps.getQueueJob(runId) : null
      if (
        !runId ||
        !job ||
        !TERMINAL_QUEUE_STATUSES.has(job.status) ||
        !this.queueJobOwnsAttempt(projection, attempt, job)
      ) {
        return false
      }
    }
    return true
  }

  private attemptResultBinding(
    projection: ExecutionRunProjection,
    attempt: StepAttempt
  ): ExecutionGraphAttemptResultBinding {
    const runId = attempt.providerRunRef
    const job = runId ? this.deps.getQueueJob(runId) : null
    if (
      !runId ||
      !job ||
      !projection.workspaceId ||
      !projection.rootChatId ||
      !this.queueJobOwnsAttempt(projection, attempt, job)
    ) {
      throw new Error('Execution attempt cannot bind a result without exact queue authority.')
    }
    return {
      schemaVersion: 1,
      executionId: projection.executionId,
      activationId: attempt.activationId,
      attemptId: attempt.id,
      providerRunRef: runId,
      workspaceId: projection.workspaceId,
      rootChatId: projection.rootChatId,
      provider: job.provider
    }
  }

  private runSessionOwnsAttempt(
    projection: ExecutionRunProjection,
    attempt: StepAttempt,
    event: Exclude<RunSessionChangeEvent, { type: 'removed' }>
  ): boolean {
    const runId = event.session.runId
    const job = this.deps.getQueueJob(runId)
    const exactQueueBinding = Boolean(job && this.queueJobOwnsAttempt(projection, attempt, job))
    const exactSessionIdentity = Boolean(
      job &&
      event.session.provider === job.provider &&
      event.session.appChatId &&
      event.session.appChatId === job.chatId &&
      event.session.workspacePath &&
      event.session.workspacePath === job.workspacePath
    )
    const exactQueueLifecycle = Boolean(
      job &&
      (event.session.status === 'starting'
        ? job.status === 'starting'
        : event.session.status === 'running'
          ? job.status === 'starting' || job.status === 'active'
          : job.status === 'starting' ||
            job.status === 'active' ||
            job.status === 'cancelling')
    )
    if (exactQueueBinding && exactSessionIdentity && exactQueueLifecycle) return true

    const reasons: string[] = []
    if (!job) reasons.push('the exact queue row is missing')
    else {
      if (!exactQueueBinding) reasons.push('the queue graph binding does not own this attempt')
      if (event.session.provider !== job.provider) reasons.push('provider identity differs')
      if (!event.session.appChatId || event.session.appChatId !== job.chatId) {
        reasons.push('chat identity differs or is absent')
      }
      if (!event.session.workspacePath || event.session.workspacePath !== job.workspacePath) {
        reasons.push('workspace identity differs or is absent')
      }
      if (!exactQueueLifecycle) reasons.push('queue lifecycle does not admit this session event')
    }
    this.requireAction(
      projection,
      attempt,
      `RunManager event rejected for graph attempt: ${reasons.join('; ')}.`
    )
    return false
  }

  private recordCancellationCleanupFailure(
    executionId: string,
    attemptId: string,
    runId: string,
    detail: string
  ): void {
    let projection = this.requireExecution(executionId)
    const attempt = projection.attempts[attemptId]
    const job = this.deps.getQueueJob(runId)
    if (attempt && job && this.queueJobOwnsAttempt(projection, attempt, job)) {
      try {
        this.deps.transitionQueueJob(runId, 'cancelling', {
          statusReason: 'Execution graph cancellation requires operator cleanup.',
          lastError: detail
        })
      } catch {
        // The graph ledger below remains the durable attention signal even if
        // the queue store cannot accept a same-state evidence update.
      }
    }
    projection = this.requireExecution(executionId)
    const currentAttempt = projection.attempts[attemptId]
    if (
      currentAttempt &&
      !isStepAttemptTerminal(currentAttempt.state) &&
      !isExecutionRunTerminal(projection.state)
    ) {
      this.requireAction(
        projection,
        currentAttempt,
        `Cancellation cleanup failed for queue run "${runId}": ${detail}`
      )
    }
  }

  private containTerminalExecutionQueueRows(projection: ExecutionRunProjection): void {
    if (projection.integrity !== 'valid' || projection.baseRevisionMissing) return
    for (const attempt of Object.values(projection.attempts)) {
      const runId = attempt.providerRunRef
      if (!runId) continue
      const job = this.deps.getQueueJob(runId)
      if (
        !job ||
        (job.status !== 'queued' && job.status !== 'paused') ||
        !this.queueJobOwnsAttempt(projection, attempt, job)
      ) {
        continue
      }
      try {
        this.deps.transitionQueueJob(runId, 'cancelled', {
          statusReason: `Contained stale queue row for terminal execution ${projection.executionId}.`
        })
      } catch {
        // Recovery remains fail-closed at the graph layer. The next recovery
        // pass retries containment if the queue store was temporarily unable
        // to persist the terminal status.
      }
    }
  }

  private reconcileTerminalAttemptQueueRows(projection: ExecutionRunProjection): void {
    if (projection.integrity !== 'valid' || projection.baseRevisionMissing) return
    for (const attempt of Object.values(projection.attempts)) {
      if (!isStepAttemptTerminal(attempt.state) || !attempt.providerRunRef) continue
      const job = this.deps.getQueueJob(attempt.providerRunRef)
      if (
        !job ||
        TERMINAL_QUEUE_STATUSES.has(job.status) ||
        !this.queueJobOwnsAttempt(projection, attempt, job)
      ) {
        continue
      }
      const status: RunQueueJobStatus =
        attempt.state === 'succeeded'
          ? 'completed'
          : attempt.state === 'cancelled'
            ? 'cancelled'
            : 'failed'
      try {
        this.deps.transitionQueueJob(job.runId, status, {
          statusReason: `Reconciled from authoritative execution attempt ${attempt.id}.`,
          ...(status === 'failed'
            ? { lastError: attempt.error || 'Execution attempt requires review.' }
            : {})
        })
      } catch {
        // A later recovery pass retries. The graph ledger remains authoritative
        // and the stale nonterminal row is never treated as provider evidence.
      }
    }
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
    status: 'completed' | 'failed' | 'cancelled',
    result?: ExecutionStepResult
  ): void {
    if (!isStepAttemptTerminal(attempt.state) && attempt.state !== 'running') {
      this.markAttemptRunning(projection, attempt)
      projection = this.requireExecution(projection.executionId)
      attempt = projection.attempts[attempt.id]
    }
    if (isStepAttemptTerminal(attempt.state)) return
    const activation = projection.activations[attempt.activationId]
    if (status === 'completed') {
      if (!result) {
        throw new Error('A completed provider attempt cannot settle without a structured result.')
      }
      this.append(projection, [
        {
          executionId: projection.executionId,
          kind: 'attempt_state_changed',
          attemptId: attempt.id,
          state: 'succeeded',
          providerRunRef: attempt.providerRunRef,
          result,
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
      if (!this.cancellationContexts.has(projection.executionId)) {
        this.drain(projection.executionId)
      }
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
    if (!projection.workspaceId) {
      this.requireAnchorAction(projection, 'Anchor execution has no durable workspace identity.')
      return
    }
    let status: ExecutionGraphAnchorRunStatus
    try {
      status = this.deps.resolveAnchorRunStatus(anchorRunRef, {
        workspaceId: projection.workspaceId,
        ...(projection.rootChatId ? { rootChatId: projection.rootChatId } : {})
      })
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
    activation: StepActivation,
    suppliedResult?: ExecutionStepResult
  ): void {
    const attemptId = this.id('attempt')
    const result: ExecutionStepResult = suppliedResult || {
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
    projection: StackAppendAuthorityContext,
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

  private findClientRequestReceipt(clientRequestId: string):
    | {
        readonly event: StepAppendedEvent
      }
    | undefined {
    const matches: StepAppendedEvent[] = []
    for (const projection of this.repository.listExecutions()) {
      for (const event of this.repository.readExecutionEvents(projection.executionId)) {
        if (
          event.kind === 'step_appended' &&
          event.clientRequestReceipt?.clientRequestId === clientRequestId
        ) {
          matches.push(event)
        }
      }
    }
    if (matches.length > 1) {
      throw new Error(
        `Stack append client request id "${clientRequestId}" appears more than once in the execution ledger.`
      )
    }
    return matches[0] ? { event: matches[0] } : undefined
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
