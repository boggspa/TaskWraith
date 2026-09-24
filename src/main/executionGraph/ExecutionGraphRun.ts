import { createHash } from 'node:crypto'
import {
  deepFreezeExecutionGraph,
  executionGraphRevisionRef,
  stableExecutionGraphStringify,
  validateExecutionStep,
  validateExecutionTopology
} from './ExecutionGraphCompiler'
import {
  isBoundedExecutionGraphAttemptError,
  isBoundedExecutionGraphResultReference,
  validateExecutionGraphAttemptResult
} from './ExecutionGraphAttemptResult'
import {
  EXECUTION_RUN_EVENT_SCHEMA_VERSION,
  type EffectiveExecutionTopology,
  type ExecutionClientRequestReceipt,
  type ExecutionEdge,
  type ExecutionGraphRevision,
  type ExecutionGraphRevisionRef,
  type ExecutionPermissionCeilingRef,
  type ExecutionRunState,
  type ExecutionStepResult,
  type ExecutionOwnerRef,
  type ExecutionTenantRef,
  type StepActivation,
  type StepActivationState,
  type StepAttempt,
  type StepAttemptState,
  type UserFrontierAppend
} from './ExecutionGraphModel'

/** V1 ad-hoc Stacks stay deliberately small even when the generic graph kernel allows more. */
export const MAX_EXECUTION_STACK_STEPS = 64

export type ExecutionRunEventKind =
  | 'execution_created'
  | 'step_appended'
  | 'activation_created'
  | 'activation_state_changed'
  | 'attempt_created'
  | 'attempt_state_changed'
  | 'execution_state_changed'

interface ExecutionRunEventCommon {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly executionId: string
  readonly sequence: number
  readonly timestamp: string
}

export interface ExecutionCreatedEvent extends ExecutionRunEventCommon {
  readonly kind: 'execution_created'
  readonly title: string
  readonly workspaceId: string
  readonly tenant: ExecutionTenantRef
  readonly rootChatId?: string
  readonly anchorRunRef?: string
  /** Absent on pre-ownership ledgers, which stay valid and decode as unowned. */
  readonly owner?: ExecutionOwnerRef
  readonly baseRevision?: ExecutionGraphRevisionRef
  readonly permissionCeilingRef: ExecutionPermissionCeilingRef
}

export interface StepAppendedEvent extends ExecutionRunEventCommon {
  readonly kind: 'step_appended'
  readonly append: UserFrontierAppend
  readonly previousTopologyDigest: string
  readonly topologyDigest: string
  /** Absent on pre-idempotency ledgers, which remain valid and readable. */
  readonly clientRequestReceipt?: ExecutionClientRequestReceipt
}

export interface ActivationCreatedEvent extends ExecutionRunEventCommon {
  readonly kind: 'activation_created'
  readonly activationId: string
  readonly stepId: string
}

export interface ActivationStateChangedEvent extends ExecutionRunEventCommon {
  readonly kind: 'activation_state_changed'
  readonly activationId: string
  readonly state: StepActivationState
  readonly retryAt?: string
  readonly reason?: string
}

export interface AttemptCreatedEvent extends ExecutionRunEventCommon {
  readonly kind: 'attempt_created'
  readonly attemptId: string
  readonly activationId: string
  readonly stepId: string
  readonly ordinal: number
}

export interface AttemptStateChangedEvent extends ExecutionRunEventCommon {
  readonly kind: 'attempt_state_changed'
  readonly attemptId: string
  readonly state: StepAttemptState
  readonly providerRunRef?: string
  readonly result?: ExecutionStepResult
  readonly error?: string
}

export interface ExecutionStateChangedEvent extends ExecutionRunEventCommon {
  readonly kind: 'execution_state_changed'
  readonly state: ExecutionRunState
  readonly reason?: string
}

export type ExecutionRunEvent =
  | ExecutionCreatedEvent
  | StepAppendedEvent
  | ActivationCreatedEvent
  | ActivationStateChangedEvent
  | AttemptCreatedEvent
  | AttemptStateChangedEvent
  | ExecutionStateChangedEvent

type StripEventEnvelope<T extends ExecutionRunEvent> = Omit<
  T,
  'schemaVersion' | 'eventId' | 'sequence' | 'timestamp'
> & {
  readonly timestamp?: string
}

export type ExecutionRunEventInput =
  | StripEventEnvelope<ExecutionCreatedEvent>
  | StripEventEnvelope<StepAppendedEvent>
  | StripEventEnvelope<ActivationCreatedEvent>
  | StripEventEnvelope<ActivationStateChangedEvent>
  | StripEventEnvelope<AttemptCreatedEvent>
  | StripEventEnvelope<AttemptStateChangedEvent>
  | StripEventEnvelope<ExecutionStateChangedEvent>

export interface ExecutionRunFoldDiagnostic {
  readonly code: string
  readonly message: string
  readonly sequence?: number
}

export interface ExecutionRunProjection {
  readonly executionId: string
  readonly title?: string
  readonly workspaceId?: string
  readonly tenant?: ExecutionTenantRef
  readonly rootChatId?: string
  readonly anchorRunRef?: string
  readonly owner?: ExecutionOwnerRef
  readonly state: ExecutionRunState
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly baseRevision?: ExecutionGraphRevisionRef
  readonly permissionCeilingRef?: ExecutionPermissionCeilingRef
  readonly topology: EffectiveExecutionTopology
  readonly topologyDigest: string
  readonly activations: Readonly<Record<string, StepActivation>>
  readonly attempts: Readonly<Record<string, StepAttempt>>
  readonly eventCount: number
  readonly lastSequence: number
  readonly integrity: 'valid' | 'invalid'
  readonly baseRevisionMissing: boolean
  readonly diagnostics: readonly ExecutionRunFoldDiagnostic[]
}

export interface FrontierAppendIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export type PrepareFrontierAppendResult =
  | {
      readonly ok: true
      readonly input: StripEventEnvelope<StepAppendedEvent>
      readonly topology: EffectiveExecutionTopology
    }
  | {
      readonly ok: false
      readonly issues: readonly FrontierAppendIssue[]
    }

const EXECUTION_EVENT_KINDS: ReadonlySet<ExecutionRunEventKind> = new Set([
  'execution_created',
  'step_appended',
  'activation_created',
  'activation_state_changed',
  'attempt_created',
  'attempt_state_changed',
  'execution_state_changed'
])

const TERMINAL_EXECUTION_STATES: ReadonlySet<ExecutionRunState> = new Set([
  'succeeded',
  'failed',
  'cancelled'
])

const TERMINAL_ACTIVATION_STATES: ReadonlySet<StepActivationState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped'
])

const TERMINAL_ATTEMPT_STATES: ReadonlySet<StepAttemptState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
])

const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionRunState, readonly ExecutionRunState[]>> = {
  pending: ['running', 'waiting', 'requires_action', 'failed', 'cancelled'],
  running: ['waiting', 'requires_action', 'succeeded', 'failed', 'cancelled'],
  waiting: ['running', 'requires_action', 'failed', 'cancelled'],
  requires_action: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: []
}

const ACTIVATION_TRANSITIONS: Readonly<
  Record<StepActivationState, readonly StepActivationState[]>
> = {
  dormant: ['ready', 'skipped', 'cancelled'],
  ready: [
    'claimed',
    'waiting_input',
    'waiting_approval',
    'requires_action',
    'skipped',
    'cancelled'
  ],
  claimed: ['queued', 'running', 'ready', 'requires_action', 'cancelled'],
  queued: ['running', 'ready', 'requires_action', 'cancelled'],
  running: [
    'ready',
    'waiting_input',
    'waiting_approval',
    'waiting_retry',
    'requires_action',
    'succeeded',
    'failed',
    'cancelled'
  ],
  waiting_input: ['running', 'ready', 'requires_action', 'failed', 'cancelled'],
  waiting_approval: ['running', 'ready', 'requires_action', 'failed', 'cancelled'],
  waiting_retry: ['ready', 'requires_action', 'failed', 'cancelled'],
  requires_action: ['ready', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: []
}

const ATTEMPT_TRANSITIONS: Readonly<Record<StepAttemptState, readonly StepAttemptState[]>> = {
  created: ['claimed', 'cancelled', 'interrupted'],
  claimed: ['queued', 'running', 'cancelled', 'interrupted'],
  queued: ['running', 'cancelled', 'interrupted'],
  running: ['waiting_input', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  waiting_input: ['running', 'succeeded', 'failed', 'cancelled'],
  waiting_approval: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isValidTenant(value: unknown): boolean {
  return (
    isRecord(value) &&
    ['stack', 'workflow', 'audit', 'ensemble'].includes(String(value.kind)) &&
    (value.tenantId === undefined || isNonEmptyString(value.tenantId))
  )
}

function isValidPermissionCeiling(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.referenceId) &&
    isNonEmptyString(value.authorityDigest)
  )
}

function isValidAppendEdge(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return false
  if (value.kind === 'control') {
    return (
      isNonEmptyString(value.fromStepId) &&
      isNonEmptyString(value.toStepId) &&
      value.outcome === 'success'
    )
  }
  if (value.kind === 'data') {
    return (
      isRecord(value.from) &&
      isNonEmptyString(value.from.stepId) &&
      isNonEmptyString(value.from.port) &&
      isRecord(value.to) &&
      isNonEmptyString(value.to.stepId) &&
      isNonEmptyString(value.to.port)
    )
  }
  return false
}

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function isValidClientRequestReceipt(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.clientRequestId === 'string' &&
    CLIENT_REQUEST_ID_PATTERN.test(value.clientRequestId) &&
    typeof value.clientRequestDigest === 'string' &&
    SHA256_PATTERN.test(value.clientRequestDigest) &&
    typeof value.clientSubmissionDigest === 'string' &&
    SHA256_PATTERN.test(value.clientSubmissionDigest)
  )
}

function hasValidEventPayload(value: Record<string, unknown>): boolean {
  switch (value.kind) {
    case 'execution_created':
      return (
        isNonEmptyString(value.title) &&
        isNonEmptyString(value.workspaceId) &&
        isValidTenant(value.tenant) &&
        isValidPermissionCeiling(value.permissionCeilingRef)
      )
    case 'step_appended':
      return (
        isRecord(value.append) &&
        value.append.appendedBy === 'user' &&
        isRecord(value.append.step) &&
        Array.isArray(value.append.incomingEdges) &&
        value.append.incomingEdges.every(isValidAppendEdge) &&
        isNonEmptyString(value.previousTopologyDigest) &&
        isNonEmptyString(value.topologyDigest) &&
        (value.clientRequestReceipt === undefined ||
          isValidClientRequestReceipt(value.clientRequestReceipt))
      )
    case 'activation_created':
      return isNonEmptyString(value.activationId) && isNonEmptyString(value.stepId)
    case 'activation_state_changed':
      return (
        isNonEmptyString(value.activationId) &&
        isNonEmptyString(value.state) &&
        Object.prototype.hasOwnProperty.call(ACTIVATION_TRANSITIONS, value.state)
      )
    case 'attempt_created':
      return (
        isNonEmptyString(value.attemptId) &&
        isNonEmptyString(value.activationId) &&
        isNonEmptyString(value.stepId) &&
        isPositiveInteger(value.ordinal)
      )
    case 'attempt_state_changed':
      if (
        !isNonEmptyString(value.attemptId) ||
        !isNonEmptyString(value.state) ||
        !Object.prototype.hasOwnProperty.call(ATTEMPT_TRANSITIONS, value.state) ||
        (value.providerRunRef !== undefined &&
          !isBoundedExecutionGraphResultReference(value.providerRunRef)) ||
        (value.error !== undefined && !isBoundedExecutionGraphAttemptError(value.error)) ||
        (value.result !== undefined && value.state !== 'succeeded') ||
        (value.state === 'succeeded' && value.error !== undefined) ||
        (value.state === 'succeeded' && value.result === undefined)
      ) {
        return false
      }
      if (value.result !== undefined) {
        return validateExecutionGraphAttemptResult(value.result, {
          attemptId: value.attemptId,
          ...(typeof value.providerRunRef === 'string'
            ? { providerRunRef: value.providerRunRef }
            : {})
        }).ok
      }
      return true
    case 'execution_state_changed':
      return (
        isNonEmptyString(value.state) &&
        Object.prototype.hasOwnProperty.call(EXECUTION_TRANSITIONS, value.state)
      )
    default:
      return false
  }
}

function eventTimestamp(input: ExecutionRunEventInput, now?: string): string {
  return input.timestamp || now || new Date().toISOString()
}

export function createExecutionRunEvent(
  input: ExecutionRunEventInput,
  sequence: number,
  now?: string
): ExecutionRunEvent {
  const executionId = String(input.executionId || '').trim()
  if (!executionId) throw new Error('Execution-run event requires an executionId.')
  if (!EXECUTION_EVENT_KINDS.has(input.kind)) {
    throw new Error(`Unsupported execution-run event kind: ${String(input.kind)}.`)
  }
  if (input.kind === 'execution_created') {
    if (!isNonEmptyString(input.workspaceId)) {
      throw new Error('Execution creation requires a workspaceId.')
    }
    if (!isValidTenant(input.tenant)) {
      throw new Error('Execution creation requires a valid tenant.')
    }
    if (!isValidPermissionCeiling(input.permissionCeilingRef)) {
      throw new Error('Execution creation requires a valid permission ceiling ref.')
    }
  }
  const normalizedSequence = isPositiveInteger(sequence) ? sequence : 1
  const event = {
    ...input,
    executionId,
    schemaVersion: EXECUTION_RUN_EVENT_SCHEMA_VERSION,
    eventId: `${executionId}:${normalizedSequence}`,
    sequence: normalizedSequence,
    timestamp: eventTimestamp(input, now)
  } as ExecutionRunEvent
  return deepFreezeExecutionGraph(event) as ExecutionRunEvent
}

export function serializeExecutionRunEvent(event: ExecutionRunEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function parseExecutionRunEventLine(line: string): ExecutionRunEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== EXECUTION_RUN_EVENT_SCHEMA_VERSION ||
      !isNonEmptyString(parsed.executionId) ||
      !isPositiveInteger(parsed.sequence) ||
      !isNonEmptyString(parsed.timestamp) ||
      !isNonEmptyString(parsed.kind) ||
      !EXECUTION_EVENT_KINDS.has(parsed.kind as ExecutionRunEventKind) ||
      !hasValidEventPayload(parsed)
    ) {
      return null
    }
    return deepFreezeExecutionGraph(parsed) as unknown as ExecutionRunEvent
  } catch {
    return null
  }
}

export function nextExecutionRunSequence(events: readonly ExecutionRunEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1
}

export function safeExecutionRunFileName(executionId: string): string {
  const normalized = String(executionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${normalized || 'unknown-execution'}.jsonl`
}

export function executionTopologyDigest(topology: EffectiveExecutionTopology): string {
  return createHash('sha256')
    .update(
      stableExecutionGraphStringify({
        baseRevision: topology.baseRevision,
        steps: topology.steps,
        edges: topology.edges
      })
    )
    .digest('hex')
}

function edgeSourceStepId(edge: ExecutionEdge): string {
  return edge.kind === 'control' ? edge.fromStepId : edge.from.stepId
}

function edgeTargetStepId(edge: ExecutionEdge): string {
  return edge.kind === 'control' ? edge.toStepId : edge.to.stepId
}

export function executionTopologyFrontier(topology: EffectiveExecutionTopology): readonly string[] {
  const sourceIds = new Set(topology.edges.map(edgeSourceStepId))
  return topology.steps.filter((step) => !sourceIds.has(step.id)).map((step) => step.id)
}

export function validateUserFrontierAppend(
  context: {
    readonly topology: EffectiveExecutionTopology
    readonly runState: ExecutionRunState
    readonly permissionCeilingRef?: ExecutionPermissionCeilingRef
    readonly maxSteps?: number
  },
  append: UserFrontierAppend
): readonly FrontierAppendIssue[] {
  const issues: FrontierAppendIssue[] = []
  const effectiveMaxSteps = Math.min(
    context.maxSteps ?? MAX_EXECUTION_STACK_STEPS,
    MAX_EXECUTION_STACK_STEPS
  )
  if (append.appendedBy !== 'user') {
    issues.push({
      code: 'agent_append_not_supported',
      path: 'append.appendedBy',
      message: 'V1 frontier appends must be explicitly user-driven.'
    })
  }
  if (TERMINAL_EXECUTION_STATES.has(context.runState)) {
    issues.push({
      code: 'execution_terminal',
      path: 'runState',
      message: `Cannot append to a ${context.runState} execution.`
    })
  }
  for (const entry of validateExecutionStep(append.step, 'append.step')) {
    issues.push(entry)
  }

  const existingStepIds = new Set(context.topology.steps.map((step) => step.id))
  const existingEdgeIds = new Set(context.topology.edges.map((edge) => edge.id))
  if (existingStepIds.has(append.step.id)) {
    issues.push({
      code: 'step_already_exists',
      path: 'append.step.id',
      message: `Step "${append.step.id}" already exists.`
    })
  }
  if (context.topology.steps.length + 1 > effectiveMaxSteps) {
    issues.push({
      code: 'step_limit_exceeded',
      path: 'append.step',
      message: "The append would exceed this run's step limit."
    })
  }
  if (
    append.step.permissionRequestRef &&
    (!context.permissionCeilingRef ||
      append.step.permissionRequestRef.ceilingReferenceId !==
        context.permissionCeilingRef.referenceId)
  ) {
    issues.push({
      code: 'permission_ceiling_mismatch',
      path: 'append.step.permissionRequestRef.ceilingReferenceId',
      message: 'The appended step must remain bound to the execution permission ceiling.'
    })
  }

  const frontier = new Set(executionTopologyFrontier(context.topology))
  let incomingControlCount = 0
  append.incomingEdges.forEach((edge, index) => {
    const path = `append.incomingEdges[${index}]`
    if (existingEdgeIds.has(edge.id)) {
      issues.push({
        code: 'edge_already_exists',
        path: `${path}.id`,
        message: `Edge "${edge.id}" already exists.`
      })
    }
    const source = edgeSourceStepId(edge)
    const target = edgeTargetStepId(edge)
    if (target !== append.step.id) {
      issues.push({
        code: 'append_rewrites_existing_topology',
        path,
        message: 'Every appended edge must target the new step.'
      })
    }
    if (!existingStepIds.has(source)) {
      issues.push({
        code: 'append_source_not_found',
        path,
        message: `Append source step "${source}" does not exist.`
      })
    }
    if (edge.kind === 'control') {
      incomingControlCount += 1
      if (!frontier.has(source)) {
        issues.push({
          code: 'control_source_not_frontier',
          path,
          message: `Control source "${source}" is not on the open execution frontier.`
        })
      }
    }
  })
  if (context.topology.steps.length === 0 && append.incomingEdges.length > 0) {
    issues.push({
      code: 'first_step_has_dependencies',
      path: 'append.incomingEdges',
      message: 'The first Stack step cannot depend on a non-existent predecessor.'
    })
  }
  if (context.topology.steps.length > 0 && incomingControlCount === 0) {
    issues.push({
      code: 'missing_frontier_control',
      path: 'append.incomingEdges',
      message: 'A downstream append requires a success-control edge from the current frontier.'
    })
  }

  if (issues.length === 0) {
    const combinedSteps = [...context.topology.steps, append.step]
    const combinedEdges = [...context.topology.edges, ...append.incomingEdges]
    for (const entry of validateExecutionTopology(combinedSteps, combinedEdges, {
      maxSteps: effectiveMaxSteps
    })) {
      issues.push(entry)
    }
  }
  return issues
}

export function prepareUserFrontierAppend(
  context: {
    readonly executionId: string
    readonly topology: EffectiveExecutionTopology
    readonly runState: ExecutionRunState
    readonly permissionCeilingRef?: ExecutionPermissionCeilingRef
    readonly maxSteps?: number
  },
  append: UserFrontierAppend
): PrepareFrontierAppendResult {
  const issues = validateUserFrontierAppend(context, append)
  if (issues.length > 0) return { ok: false, issues }
  const topology: EffectiveExecutionTopology = deepFreezeExecutionGraph({
    ...(context.topology.baseRevision ? { baseRevision: context.topology.baseRevision } : {}),
    steps: [...context.topology.steps, append.step],
    edges: [...context.topology.edges, ...append.incomingEdges]
  })
  return {
    ok: true,
    topology,
    input: {
      executionId: context.executionId,
      kind: 'step_appended',
      append,
      previousTopologyDigest: executionTopologyDigest(context.topology),
      topologyDigest: executionTopologyDigest(topology)
    }
  }
}

function revisionMatchesRef(
  revision: ExecutionGraphRevision,
  ref: ExecutionGraphRevisionRef
): boolean {
  return (
    revision.graphId === ref.graphId &&
    revision.revision === ref.revision &&
    revision.revisionId === ref.revisionId &&
    revision.definitionDigest === ref.definitionDigest
  )
}

function transitionAllowed<T extends string>(
  current: T,
  next: T,
  transitions: Readonly<Record<T, readonly T[]>>
): boolean {
  return current === next || transitions[current].includes(next)
}

function completedAtForAttempt(state: StepAttemptState, timestamp: string): string | undefined {
  return TERMINAL_ATTEMPT_STATES.has(state) ? timestamp : undefined
}

/**
 * Reconstructs one execution from its append-only event log. Invalid or stale
 * events are retained as diagnostics and do not mutate the effective state.
 */
export function foldExecutionRun(
  executionId: string,
  events: readonly ExecutionRunEvent[],
  options: { readonly baseRevision?: ExecutionGraphRevision } = {}
): ExecutionRunProjection {
  const ordered = [...events]
    .filter((event) => event.executionId === executionId)
    .sort((a, b) => a.sequence - b.sequence)
  const diagnostics: ExecutionRunFoldDiagnostic[] = []
  const activations = new Map<string, StepActivation>()
  const attempts = new Map<string, StepAttempt>()
  const seenSequences = new Set<number>()
  let title: string | undefined
  let workspaceId: string | undefined
  let tenant: ExecutionTenantRef | undefined
  let rootChatId: string | undefined
  let anchorRunRef: string | undefined
  let owner: ExecutionOwnerRef | undefined
  let state: ExecutionRunState = 'pending'
  let createdAt: string | undefined
  let updatedAt: string | undefined
  let baseRevision: ExecutionGraphRevisionRef | undefined
  let permissionCeilingRef: ExecutionPermissionCeilingRef | undefined
  let created = false
  let baseRevisionMissing = false
  let topology: EffectiveExecutionTopology = { steps: [], edges: [] }
  let topologyDigest = executionTopologyDigest(topology)
  let appliedEventCount = 0
  let lastSequence = 0

  const diagnostic = (event: ExecutionRunEvent, code: string, message: string): void => {
    diagnostics.push({ code, message, sequence: event.sequence })
  }

  for (const event of ordered) {
    if (seenSequences.has(event.sequence)) {
      diagnostic(event, 'duplicate_sequence', `Duplicate event sequence ${event.sequence}.`)
      continue
    }
    seenSequences.add(event.sequence)
    lastSequence = Math.max(lastSequence, event.sequence)

    if (event.kind === 'execution_created') {
      if (created) {
        diagnostic(event, 'duplicate_execution_created', 'Execution was already created.')
        continue
      }
      created = true
      title = event.title
      workspaceId = event.workspaceId
      tenant = event.tenant
      rootChatId = event.rootChatId
      anchorRunRef = event.anchorRunRef
      owner = event.owner
      createdAt = event.timestamp
      updatedAt = event.timestamp
      baseRevision = event.baseRevision
      permissionCeilingRef = event.permissionCeilingRef
      if (event.baseRevision) {
        if (
          !options.baseRevision ||
          !revisionMatchesRef(options.baseRevision, event.baseRevision)
        ) {
          baseRevisionMissing = true
          diagnostic(
            event,
            'base_revision_missing',
            `Pinned base revision ${event.baseRevision.revisionId} was not supplied or did not match its digest.`
          )
        } else {
          topology = {
            baseRevision: executionGraphRevisionRef(options.baseRevision),
            steps: options.baseRevision.steps,
            edges: options.baseRevision.edges
          }
          topologyDigest = executionTopologyDigest(topology)
        }
      }
      appliedEventCount += 1
      continue
    }

    if (!created) {
      diagnostic(event, 'event_before_execution_created', 'Ignored event before execution_created.')
      continue
    }

    switch (event.kind) {
      case 'step_appended': {
        if (baseRevisionMissing) {
          diagnostic(
            event,
            'append_blocked_missing_base',
            'Cannot validate append without its pinned base.'
          )
          break
        }
        if (event.previousTopologyDigest !== topologyDigest) {
          diagnostic(
            event,
            'topology_digest_mismatch',
            'Append previousTopologyDigest does not match the folded topology.'
          )
          break
        }
        const prepared = prepareUserFrontierAppend(
          {
            executionId,
            topology,
            runState: state,
            permissionCeilingRef,
            maxSteps: options.baseRevision?.limits.maxSteps
          },
          event.append
        )
        if (!prepared.ok) {
          diagnostic(
            event,
            'invalid_frontier_append',
            prepared.issues.map((entry) => entry.code).join(', ')
          )
          break
        }
        if (prepared.input.topologyDigest !== event.topologyDigest) {
          diagnostic(
            event,
            'topology_digest_mismatch',
            'Append topologyDigest is not reproducible.'
          )
          break
        }
        topology = prepared.topology
        topologyDigest = event.topologyDigest
        updatedAt = event.timestamp
        appliedEventCount += 1
        break
      }
      case 'activation_created': {
        if (!topology.steps.some((step) => step.id === event.stepId)) {
          diagnostic(event, 'activation_step_missing', `Unknown step "${event.stepId}".`)
          break
        }
        if (activations.has(event.activationId)) {
          diagnostic(
            event,
            'duplicate_activation',
            `Activation "${event.activationId}" already exists.`
          )
          break
        }
        activations.set(event.activationId, {
          id: event.activationId,
          stepId: event.stepId,
          state: 'dormant',
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
          attemptIds: []
        })
        updatedAt = event.timestamp
        appliedEventCount += 1
        break
      }
      case 'activation_state_changed': {
        const activation = activations.get(event.activationId)
        if (!activation) {
          diagnostic(event, 'activation_missing', `Unknown activation "${event.activationId}".`)
          break
        }
        if (!transitionAllowed(activation.state, event.state, ACTIVATION_TRANSITIONS)) {
          diagnostic(
            event,
            'invalid_activation_transition',
            `Activation cannot transition ${activation.state} -> ${event.state}.`
          )
          break
        }
        activations.set(event.activationId, {
          ...activation,
          state: event.state,
          updatedAt: event.timestamp,
          ...(event.retryAt ? { retryAt: event.retryAt } : { retryAt: undefined }),
          ...(event.reason ? { reason: event.reason } : {})
        })
        updatedAt = event.timestamp
        appliedEventCount += 1
        break
      }
      case 'attempt_created': {
        const activation = activations.get(event.activationId)
        if (!activation) {
          diagnostic(
            event,
            'attempt_activation_missing',
            `Unknown activation "${event.activationId}".`
          )
          break
        }
        if (activation.stepId !== event.stepId) {
          diagnostic(event, 'attempt_step_mismatch', 'Attempt step does not match its activation.')
          break
        }
        if (attempts.has(event.attemptId)) {
          diagnostic(event, 'duplicate_attempt', `Attempt "${event.attemptId}" already exists.`)
          break
        }
        if (!isPositiveInteger(event.ordinal)) {
          diagnostic(event, 'invalid_attempt_ordinal', 'Attempt ordinal must be positive.')
          break
        }
        if (
          [...attempts.values()].some(
            (attempt) =>
              attempt.activationId === event.activationId && attempt.ordinal === event.ordinal
          )
        ) {
          diagnostic(event, 'duplicate_attempt_ordinal', 'Attempt ordinal is already used.')
          break
        }
        attempts.set(event.attemptId, {
          id: event.attemptId,
          activationId: event.activationId,
          stepId: event.stepId,
          ordinal: event.ordinal,
          state: 'created',
          createdAt: event.timestamp,
          updatedAt: event.timestamp
        })
        activations.set(event.activationId, {
          ...activation,
          updatedAt: event.timestamp,
          attemptIds: [...activation.attemptIds, event.attemptId]
        })
        updatedAt = event.timestamp
        appliedEventCount += 1
        break
      }
      case 'attempt_state_changed': {
        const attempt = attempts.get(event.attemptId)
        if (!attempt) {
          diagnostic(event, 'attempt_missing', `Unknown attempt "${event.attemptId}".`)
          break
        }
        if (!transitionAllowed(attempt.state, event.state, ATTEMPT_TRANSITIONS)) {
          diagnostic(
            event,
            'invalid_attempt_transition',
            `Attempt cannot transition ${attempt.state} -> ${event.state}.`
          )
          break
        }
        if (
          event.providerRunRef !== undefined &&
          !isBoundedExecutionGraphResultReference(event.providerRunRef)
        ) {
          diagnostic(
            event,
            'invalid_provider_run_ref',
            'Attempt provider run reference is invalid or oversized.'
          )
          break
        }
        if (event.error !== undefined && !isBoundedExecutionGraphAttemptError(event.error)) {
          diagnostic(event, 'invalid_attempt_error', 'Attempt error is invalid or oversized.')
          break
        }
        if (event.state === 'succeeded' && event.error !== undefined) {
          diagnostic(event, 'success_with_error', 'A succeeded attempt cannot commit an error.')
          break
        }
        if (event.result && event.state !== 'succeeded') {
          diagnostic(
            event,
            'result_on_non_success',
            'Only a succeeded attempt may commit a result.'
          )
          break
        }
        if (event.state === 'succeeded' && !event.result) {
          diagnostic(
            event,
            'succeeded_attempt_missing_result',
            'A succeeded attempt must commit a structured result.'
          )
          break
        }
        if (event.result) {
          const validation = validateExecutionGraphAttemptResult(event.result, {
            attemptId: event.attemptId,
            ...(event.providerRunRef || attempt.providerRunRef
              ? { providerRunRef: event.providerRunRef || attempt.providerRunRef }
              : {})
          })
          if (!validation.ok) {
            diagnostic(event, 'invalid_result_payload', validation.reason)
            break
          }
        }
        attempts.set(event.attemptId, {
          ...attempt,
          state: event.state,
          updatedAt: event.timestamp,
          ...(event.state === 'running' && !attempt.startedAt
            ? { startedAt: event.timestamp }
            : {}),
          ...(completedAtForAttempt(event.state, event.timestamp)
            ? { completedAt: event.timestamp }
            : {}),
          ...(event.providerRunRef ? { providerRunRef: event.providerRunRef } : {}),
          ...(event.result ? { result: event.result } : {}),
          ...(event.error ? { error: event.error } : {})
        })
        updatedAt = event.timestamp
        appliedEventCount += 1
        break
      }
      case 'execution_state_changed': {
        if (!transitionAllowed(state, event.state, EXECUTION_TRANSITIONS)) {
          diagnostic(
            event,
            'invalid_execution_transition',
            `Execution cannot transition ${state} -> ${event.state}.`
          )
          break
        }
        state = event.state
        updatedAt = event.timestamp
        appliedEventCount += 1
        break
      }
    }
  }

  if (!created) {
    diagnostics.push({
      code: 'execution_not_created',
      message: 'No valid execution_created event was found.'
    })
  }
  if (appliedEventCount !== ordered.length && diagnostics.length === 0) {
    diagnostics.push({ code: 'fold_incomplete', message: 'Not every event was applied.' })
  }

  const projection: ExecutionRunProjection = {
    executionId,
    ...(title ? { title } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(tenant ? { tenant } : {}),
    ...(rootChatId ? { rootChatId } : {}),
    ...(anchorRunRef ? { anchorRunRef } : {}),
    ...(owner ? { owner } : {}),
    state,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(baseRevision ? { baseRevision } : {}),
    ...(permissionCeilingRef ? { permissionCeilingRef } : {}),
    topology,
    topologyDigest,
    activations: Object.fromEntries(activations),
    attempts: Object.fromEntries(attempts),
    eventCount: ordered.length,
    lastSequence,
    integrity: diagnostics.length === 0 ? 'valid' : 'invalid',
    baseRevisionMissing,
    diagnostics
  }
  return deepFreezeExecutionGraph(projection) as ExecutionRunProjection
}

export function isExecutionRunTerminal(state: ExecutionRunState): boolean {
  return TERMINAL_EXECUTION_STATES.has(state)
}

export function isStepActivationTerminal(state: StepActivationState): boolean {
  return TERMINAL_ACTIVATION_STATES.has(state)
}

export function isStepAttemptTerminal(state: StepAttemptState): boolean {
  return TERMINAL_ATTEMPT_STATES.has(state)
}
