import type {
  EffectiveExecutionTopology,
  ExecutionArtifactRef,
  ExecutionDataEdge,
  ExecutionEdge,
  ExecutionRunState,
  ExecutionStepDefinition,
  StepActivation,
  StepActivationState,
  StepAttempt
} from '../../../main/executionGraph/ExecutionGraphModel'

export type ExecutionProjectionTone =
  | 'pending'
  | 'active'
  | 'waiting'
  | 'attention'
  | 'success'
  | 'failure'
  | 'muted'

export type ExecutionStackPosition = 'current' | 'next' | 'then'

export interface ExecutionGraphProjectionInput {
  runId: string
  runState: ExecutionRunState
  topology: EffectiveExecutionTopology
  activations?: readonly StepActivation[]
  attempts?: readonly StepAttempt[]
  runtimeAppendedStepIds?: readonly string[]
  title?: string
  updatedAt?: string
}

export interface ExecutionDependencyProjection {
  edgeId: string
  kind: ExecutionEdge['kind']
  fromStepId: string
  fromStepTitle: string
  label: string
}

export interface ExecutionStepProjection {
  step: ExecutionStepDefinition
  stepId: string
  stage: number
  order: number
  activationId: string | null
  activationState: StepActivationState
  statusLabel: string
  statusTone: ExecutionProjectionTone
  blocker: string | null
  dependencies: readonly ExecutionDependencyProjection[]
  successorStepIds: readonly string[]
  attempts: readonly StepAttempt[]
  latestAttempt: StepAttempt | null
  artifactRefs: readonly ExecutionArtifactRef[]
  isRuntimeAppended: boolean
  canCancel: boolean
  stackPosition: ExecutionStackPosition | null
}

export interface ExecutionStageProjection {
  index: number
  label: string
  steps: readonly ExecutionStepProjection[]
}

export interface ExecutionGraphProjection {
  runId: string
  title: string
  runState: ExecutionRunState
  runStatusLabel: string
  runStatusTone: ExecutionProjectionTone
  updatedAt?: string
  stages: readonly ExecutionStageProjection[]
  orderedSteps: readonly ExecutionStepProjection[]
  stackRows: readonly ExecutionStepProjection[]
  completedStepCount: number
  totalStepCount: number
  activeStepCount: number
  waitingStepCount: number
  hasRuntimeAppends: boolean
  issues: readonly string[]
  liveSummary: string
}

const ACTIVE_ACTIVATION_STATES = new Set<StepActivationState>([
  'claimed',
  'queued',
  'running',
  'waiting_input',
  'waiting_approval',
  'waiting_retry',
  'requires_action'
])

const WAITING_ACTIVATION_STATES = new Set<StepActivationState>([
  'waiting_input',
  'waiting_approval',
  'waiting_retry',
  'requires_action'
])

const TERMINAL_ACTIVATION_STATES = new Set<StepActivationState>([
  'succeeded',
  'failed',
  'cancelled',
  'skipped'
])

const SUCCESSFUL_ACTIVATION_STATES = new Set<StepActivationState>(['succeeded'])

/* States whose ledger reason describes an impediment or a terminal explanation.
 * Healthy transitions carry reasons too ("Provider run is active."); surfacing
 * one of those as a blocker tells the user a working graph is stuck on its own
 * intended state, so ready/claimed/queued/running/succeeded never contribute. */
const REASON_SURFACING_ACTIVATION_STATES = new Set<StepActivationState>([
  'dormant',
  'waiting_input',
  'waiting_approval',
  'waiting_retry',
  'requires_action',
  'failed',
  'cancelled',
  'skipped'
])

function compareStepIds(
  left: string,
  right: string,
  definitionOrder: ReadonlyMap<string, number>
): number {
  const leftOrder = definitionOrder.get(left) ?? Number.MAX_SAFE_INTEGER
  const rightOrder = definitionOrder.get(right) ?? Number.MAX_SAFE_INTEGER
  return leftOrder - rightOrder || left.localeCompare(right)
}

function latestActivationByStep(
  activations: readonly StepActivation[]
): ReadonlyMap<string, StepActivation> {
  const byStep = new Map<string, StepActivation>()
  for (const activation of activations) {
    const current = byStep.get(activation.stepId)
    if (
      !current ||
      activation.updatedAt > current.updatedAt ||
      (activation.updatedAt === current.updatedAt && activation.id > current.id)
    ) {
      byStep.set(activation.stepId, activation)
    }
  }
  return byStep
}

function attemptsByStep(attempts: readonly StepAttempt[]): ReadonlyMap<string, StepAttempt[]> {
  const byStep = new Map<string, StepAttempt[]>()
  for (const attempt of attempts) {
    const bucket = byStep.get(attempt.stepId) ?? []
    bucket.push(attempt)
    byStep.set(attempt.stepId, bucket)
  }
  for (const bucket of byStep.values()) {
    bucket.sort(
      (left, right) =>
        left.ordinal - right.ordinal ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    )
  }
  return byStep
}

interface ValidatedExecutionEdge {
  edge: ExecutionEdge
  fromStepId: string
  toStepId: string
}

type ExecutionEdgeValidation =
  | { valid: true; value: ValidatedExecutionEdge }
  | { valid: false; issue: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function edgeReference(value: unknown, index: number): string {
  return isRecord(value) && isNonEmptyString(value.id) ? value.id : `at position ${index + 1}`
}

function validateExecutionEdge(value: unknown, index: number): ExecutionEdgeValidation {
  const reference = edgeReference(value, index)
  if (!isRecord(value)) {
    return {
      valid: false,
      issue: `Edge ${reference} is malformed and was ignored.`
    }
  }

  if (value.kind !== 'control' && value.kind !== 'data') {
    const kind = isNonEmptyString(value.kind) ? `"${value.kind}"` : 'without a kind'
    return {
      valid: false,
      issue: `Edge ${reference} has unsupported kind ${kind} and was ignored.`
    }
  }

  if (!isNonEmptyString(value.id)) {
    return {
      valid: false,
      issue: `Edge ${reference} is malformed for kind "${value.kind}" and was ignored.`
    }
  }

  if (value.kind === 'control') {
    if (
      !isNonEmptyString(value.fromStepId) ||
      !isNonEmptyString(value.toStepId) ||
      value.outcome !== 'success'
    ) {
      return {
        valid: false,
        issue: `Edge ${reference} is malformed for kind "control" and was ignored.`
      }
    }
    return {
      valid: true,
      value: {
        edge: value as unknown as ExecutionEdge,
        fromStepId: value.fromStepId,
        toStepId: value.toStepId
      }
    }
  }

  if (
    !isRecord(value.from) ||
    !isNonEmptyString(value.from.stepId) ||
    !isNonEmptyString(value.from.port) ||
    !isRecord(value.to) ||
    !isNonEmptyString(value.to.stepId) ||
    !isNonEmptyString(value.to.port)
  ) {
    return {
      valid: false,
      issue: `Edge ${reference} is malformed for kind "data" and was ignored.`
    }
  }
  return {
    valid: true,
    value: {
      edge: value as unknown as ExecutionEdge,
      fromStepId: value.from.stepId,
      toStepId: value.to.stepId
    }
  }
}

function dataDependencyLabel(edge: ExecutionDataEdge, sourceTitle: string): string {
  return `Receives ${edge.to.port} from ${sourceTitle}.${edge.from.port}`
}

function dependencyProjection(
  validatedEdge: ValidatedExecutionEdge,
  stepById: ReadonlyMap<string, ExecutionStepDefinition>
): ExecutionDependencyProjection {
  const { edge, fromStepId } = validatedEdge
  const sourceTitle = stepById.get(fromStepId)?.title ?? fromStepId
  return {
    edgeId: edge.id,
    kind: edge.kind,
    fromStepId,
    fromStepTitle: sourceTitle,
    label:
      edge.kind === 'control'
        ? `After ${sourceTitle} succeeds`
        : dataDependencyLabel(edge, sourceTitle)
  }
}

interface TopologyOrder {
  orderedIds: string[]
  stageByStepId: Map<string, number>
  predecessorIdsByStepId: Map<string, Set<string>>
  successorIdsByStepId: Map<string, Set<string>>
  validEdges: ValidatedExecutionEdge[]
  issues: string[]
}

function topologicalOrder(topology: EffectiveExecutionTopology): TopologyOrder {
  const definitionOrder = new Map(topology.steps.map((step, index) => [step.id, index]))
  const stepIds = new Set(topology.steps.map((step) => step.id))
  const predecessorIdsByStepId = new Map<string, Set<string>>()
  const successorIdsByStepId = new Map<string, Set<string>>()
  const validEdges: ValidatedExecutionEdge[] = []
  const issues: string[] = []

  for (const step of topology.steps) {
    predecessorIdsByStepId.set(step.id, new Set())
    successorIdsByStepId.set(step.id, new Set())
  }

  for (const [index, edge] of topology.edges.entries()) {
    const validation = validateExecutionEdge(edge, index)
    if (!validation.valid) {
      issues.push(validation.issue)
      continue
    }
    const { fromStepId, toStepId } = validation.value
    if (!stepIds.has(fromStepId) || !stepIds.has(toStepId)) {
      issues.push(
        `Edge ${validation.value.edge.id} references a step outside the effective topology.`
      )
      continue
    }
    validEdges.push(validation.value)
    predecessorIdsByStepId.get(toStepId)?.add(fromStepId)
    successorIdsByStepId.get(fromStepId)?.add(toStepId)
  }

  const remainingPredecessors = new Map(
    [...predecessorIdsByStepId].map(([stepId, predecessors]) => [stepId, predecessors.size])
  )
  const ready = topology.steps
    .filter((step) => remainingPredecessors.get(step.id) === 0)
    .map((step) => step.id)
    .sort((left, right) => compareStepIds(left, right, definitionOrder))
  const orderedIds: string[] = []
  const stageByStepId = new Map<string, number>()

  while (ready.length > 0) {
    const stepId = ready.shift()
    if (!stepId) break
    orderedIds.push(stepId)

    const predecessors = predecessorIdsByStepId.get(stepId) ?? new Set<string>()
    let stage = 0
    for (const predecessorId of predecessors) {
      stage = Math.max(stage, (stageByStepId.get(predecessorId) ?? 0) + 1)
    }
    stageByStepId.set(stepId, stage)

    for (const successorId of successorIdsByStepId.get(stepId) ?? []) {
      const remaining = (remainingPredecessors.get(successorId) ?? 1) - 1
      remainingPredecessors.set(successorId, remaining)
      if (remaining === 0) {
        ready.push(successorId)
        ready.sort((left, right) => compareStepIds(left, right, definitionOrder))
      }
    }
  }

  if (orderedIds.length !== topology.steps.length) {
    issues.push(
      'The effective topology contains a dependency cycle; cyclic steps are display-only.'
    )
    const orderedSet = new Set(orderedIds)
    const unresolved = topology.steps
      .map((step) => step.id)
      .filter((stepId) => !orderedSet.has(stepId))
      .sort((left, right) => compareStepIds(left, right, definitionOrder))
    const fallbackStage = Math.max(-1, ...stageByStepId.values()) + 1
    for (const stepId of unresolved) {
      orderedIds.push(stepId)
      stageByStepId.set(stepId, fallbackStage)
    }
  }

  return {
    orderedIds,
    stageByStepId,
    predecessorIdsByStepId,
    successorIdsByStepId,
    validEdges,
    issues
  }
}

export function activationStatusLabel(state: StepActivationState): string {
  switch (state) {
    case 'dormant':
      return 'Planned'
    case 'ready':
      return 'Ready'
    case 'claimed':
      return 'Claimed'
    case 'queued':
      return 'Queued'
    case 'running':
      return 'Running'
    case 'waiting_input':
      return 'Needs input'
    case 'waiting_approval':
      return 'Needs approval'
    case 'waiting_retry':
      return 'Retry scheduled'
    case 'requires_action':
      return 'Needs action'
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'skipped':
      return 'Skipped'
  }
}

export function activationStatusTone(state: StepActivationState): ExecutionProjectionTone {
  if (state === 'succeeded') return 'success'
  if (state === 'failed') return 'failure'
  if (state === 'cancelled' || state === 'skipped') return 'muted'
  if (WAITING_ACTIVATION_STATES.has(state)) return 'attention'
  if (ACTIVE_ACTIVATION_STATES.has(state)) return 'active'
  if (state === 'ready') return 'pending'
  return 'muted'
}

export function executionRunStatusLabel(state: ExecutionRunState): string {
  switch (state) {
    case 'pending':
      return 'Pending'
    case 'running':
      return 'Running'
    case 'waiting':
      return 'Waiting'
    case 'requires_action':
      return 'Needs action'
    case 'succeeded':
      return 'Succeeded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
  }
}

function executionRunStatusTone(state: ExecutionRunState): ExecutionProjectionTone {
  if (state === 'succeeded') return 'success'
  if (state === 'failed') return 'failure'
  if (state === 'cancelled') return 'muted'
  if (state === 'waiting' || state === 'requires_action') return 'attention'
  if (state === 'running') return 'active'
  return 'pending'
}

function stepBlocker(
  activation: StepActivation | undefined,
  state: StepActivationState,
  dependencyIds: readonly string[],
  stepById: ReadonlyMap<string, ExecutionStepDefinition>,
  activationByStep: ReadonlyMap<string, StepActivation>,
  latestAttempt: StepAttempt | null
): string | null {
  if (activation?.reason?.trim() && REASON_SURFACING_ACTIVATION_STATES.has(state)) {
    return activation.reason.trim()
  }
  if (state === 'waiting_input') return 'Waiting for user input'
  if (state === 'waiting_approval') return 'Waiting for approval'
  if (state === 'waiting_retry') {
    return activation?.retryAt ? `Retry scheduled for ${activation.retryAt}` : 'Waiting to retry'
  }
  if (state === 'requires_action') return latestAttempt?.error || 'Action required'
  if (state === 'failed') return latestAttempt?.error || 'Step failed'
  if (state !== 'dormant') return null

  const failedDependency = dependencyIds.find((stepId) => {
    const dependencyState = activationByStep.get(stepId)?.state ?? 'dormant'
    return (
      dependencyState === 'failed' ||
      dependencyState === 'cancelled' ||
      dependencyState === 'skipped'
    )
  })
  if (failedDependency) {
    const dependency = activationByStep.get(failedDependency)
    return `Blocked by ${stepById.get(failedDependency)?.title ?? failedDependency} (${activationStatusLabel(
      dependency?.state ?? 'dormant'
    )})`
  }

  const pendingDependencies = dependencyIds.filter(
    (stepId) => !SUCCESSFUL_ACTIVATION_STATES.has(activationByStep.get(stepId)?.state ?? 'dormant')
  )
  if (pendingDependencies.length > 0) {
    const labels = pendingDependencies.map((stepId) => stepById.get(stepId)?.title ?? stepId)
    return `Waiting for ${labels.join(', ')}`
  }
  return dependencyIds.length === 0 ? 'Waiting for the scheduler' : null
}

function assignStackPositions(
  ordered: ExecutionStepProjection[],
  runState: ExecutionRunState
): void {
  const candidates = ordered.filter((step) => !TERMINAL_ACTIVATION_STATES.has(step.activationState))
  let current = candidates.filter((step) => ACTIVE_ACTIVATION_STATES.has(step.activationState))

  if (current.length === 0) {
    const ready = candidates.filter((step) => step.activationState === 'ready')
    if (ready.length > 0) {
      const currentStage = Math.min(...ready.map((step) => step.stage))
      current = ready.filter((step) => step.stage === currentStage)
    }
  }

  if (current.length === 0 && runState === 'failed') {
    const failed = ordered.filter((step) => step.activationState === 'failed')
    if (failed.length > 0) current = [failed[failed.length - 1]]
  }

  const currentIds = new Set(current.map((step) => step.stepId))
  const remaining = candidates.filter((step) => !currentIds.has(step.stepId))
  const nextStage = remaining.length > 0 ? Math.min(...remaining.map((step) => step.stage)) : null

  for (const step of ordered) {
    if (currentIds.has(step.stepId)) {
      step.stackPosition = 'current'
    } else if (nextStage !== null && remaining.includes(step) && step.stage === nextStage) {
      step.stackPosition = 'next'
    } else if (remaining.includes(step)) {
      step.stackPosition = 'then'
    }
  }
}

function liveSummary(
  title: string,
  runState: ExecutionRunState,
  orderedSteps: readonly ExecutionStepProjection[],
  completedStepCount: number
): string {
  const current = orderedSteps.filter((step) => step.stackPosition === 'current')
  const blocker = current.find((step) => step.blocker)?.blocker
  const currentLabel =
    current.length > 0 ? current.map((step) => step.step.title).join(', ') : 'no active step'
  const blockerLabel = blocker ? ` ${blocker}.` : ''
  return `${title}: ${executionRunStatusLabel(runState)}. ${completedStepCount} of ${orderedSteps.length} steps complete. Current: ${currentLabel}.${blockerLabel}`
}

/**
 * Creates deterministic read models for both Stack and Execution Map. This is
 * deliberately a projection: coordinates, drag order, and component state can
 * never influence scheduler readiness.
 */
export function buildExecutionGraphProjection(
  input: ExecutionGraphProjectionInput
): ExecutionGraphProjection {
  const title = input.title?.trim() || 'Execution'
  const stepById = new Map(input.topology.steps.map((step) => [step.id, step]))
  const activationByStep = latestActivationByStep(input.activations ?? [])
  const stepAttempts = attemptsByStep(input.attempts ?? [])
  const runtimeAppendedStepIds = new Set(input.runtimeAppendedStepIds ?? [])
  const order = topologicalOrder(input.topology)
  const incomingEdges = new Map<string, ValidatedExecutionEdge[]>()
  for (const edge of order.validEdges) {
    const { toStepId } = edge
    const bucket = incomingEdges.get(toStepId) ?? []
    bucket.push(edge)
    incomingEdges.set(toStepId, bucket)
  }

  const orderedSteps: ExecutionStepProjection[] = order.orderedIds.flatMap((stepId, index) => {
    const step = stepById.get(stepId)
    if (!step) return []
    const activation = activationByStep.get(stepId)
    const activationState = activation?.state ?? 'dormant'
    const attempts = stepAttempts.get(stepId) ?? []
    const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null
    const dependencyIds = [...(order.predecessorIdsByStepId.get(stepId) ?? [])]
    const dependencies = (incomingEdges.get(stepId) ?? [])
      .map((edge) => dependencyProjection(edge, stepById))
      .sort(
        (left, right) =>
          order.orderedIds.indexOf(left.fromStepId) - order.orderedIds.indexOf(right.fromStepId) ||
          left.edgeId.localeCompare(right.edgeId)
      )
    return [
      {
        step,
        stepId,
        stage: order.stageByStepId.get(stepId) ?? 0,
        order: index,
        activationId: activation?.id ?? null,
        activationState,
        statusLabel: activationStatusLabel(activationState),
        statusTone: activationStatusTone(activationState),
        blocker: stepBlocker(
          activation,
          activationState,
          dependencyIds,
          stepById,
          activationByStep,
          latestAttempt
        ),
        dependencies,
        successorStepIds: [...(order.successorIdsByStepId.get(stepId) ?? [])].sort(
          (left, right) => order.orderedIds.indexOf(left) - order.orderedIds.indexOf(right)
        ),
        attempts,
        latestAttempt,
        artifactRefs: latestAttempt?.result?.artifactRefs ?? [],
        isRuntimeAppended: runtimeAppendedStepIds.has(stepId),
        canCancel:
          activationState === 'dormant' &&
          Boolean(activation) &&
          (order.successorIdsByStepId.get(stepId)?.size ?? 0) === 0,
        stackPosition: null
      }
    ]
  })

  assignStackPositions(orderedSteps, input.runState)
  const stackRows = orderedSteps.filter((step) => step.stackPosition !== null)
  const stageNumbers = [...new Set(orderedSteps.map((step) => step.stage))].sort(
    (left, right) => left - right
  )
  const stages = stageNumbers.map((stage) => ({
    index: stage,
    label: `Stage ${stage + 1}`,
    steps: orderedSteps.filter((step) => step.stage === stage)
  }))
  const completedStepCount = orderedSteps.filter(
    (step) => step.activationState === 'succeeded' || step.activationState === 'skipped'
  ).length
  const activeStepCount = orderedSteps.filter((step) =>
    ACTIVE_ACTIVATION_STATES.has(step.activationState)
  ).length
  const waitingStepCount = orderedSteps.filter((step) =>
    WAITING_ACTIVATION_STATES.has(step.activationState)
  ).length

  return {
    runId: input.runId,
    title,
    runState: input.runState,
    runStatusLabel: executionRunStatusLabel(input.runState),
    runStatusTone: executionRunStatusTone(input.runState),
    updatedAt: input.updatedAt,
    stages,
    orderedSteps,
    stackRows,
    completedStepCount,
    totalStepCount: orderedSteps.length,
    activeStepCount,
    waitingStepCount,
    hasRuntimeAppends: runtimeAppendedStepIds.size > 0,
    issues: order.issues,
    liveSummary: liveSummary(title, input.runState, orderedSteps, completedStepCount)
  }
}
