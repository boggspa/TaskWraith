import type { StepActivationState } from './ExecutionGraphModel'
import type { ExecutionRunProjection } from './ExecutionGraphRun'

/**
 * Remote execution state is intentionally an attention projection, not a
 * transport for the graph definition or its data plane. Keep these records
 * small enough for routine relay snapshots and safe to render on a paired
 * device without exposing prompts, objectives, artifacts, credentials, or
 * provider output.
 */
export const REMOTE_EXECUTION_RUN_LIST_DEFAULT = 50
export const REMOTE_EXECUTION_RUN_LIST_MAX = 100
export const REMOTE_EXECUTION_ID_MAX = 256
export const REMOTE_EXECUTION_TITLE_MAX = 160
export const REMOTE_EXECUTION_REASON_MAX = 320

export type RemoteExecutionAttention =
  | 'none'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'requires_action'
  | 'failed'

export interface RemoteExecutionRun {
  readonly schemaVersion: 1
  readonly executionId: string
  readonly tenantKind?: 'stack' | 'workflow' | 'audit' | 'ensemble'
  readonly tenantId?: string
  readonly workspaceId?: string
  readonly threadId?: string
  readonly title?: string
  readonly state: ExecutionRunProjection['state']
  readonly attention: RemoteExecutionAttention
  readonly activeStep?: {
    readonly id: string
    readonly title: string
    readonly state: StepActivationState
  }
  /** Number of distinct graph steps whose latest activation is terminal. */
  readonly completedStepCount: number
  readonly totalStepCount: number
  readonly createdAt?: string
  readonly updatedAt?: string
  /** A bounded display reason. Never sourced from attempt errors or results. */
  readonly reason?: string
}

export interface RemoteExecutionRunListOptions {
  readonly workspaceId?: string
  readonly limit?: number
}

const TERMINAL_ACTIVATION_STATES: ReadonlySet<StepActivationState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'skipped'
])

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:bearer\s+)[a-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk|rk|pk)-(?:proj-)?[a-z0-9_-]{12,}/gi,
  /\bgh[oprsu]_[a-z0-9]{12,}/gi,
  /\bAKIA[A-Z0-9]{16}\b/g
]

const ATTENTION_PRIORITY: Readonly<Record<RemoteExecutionAttention, number>> = {
  awaiting_approval: 5,
  awaiting_input: 4,
  requires_action: 3,
  failed: 2,
  none: 1
}

const ACTIVE_STATE_PRIORITY: Readonly<Partial<Record<StepActivationState, number>>> = {
  waiting_approval: 100,
  waiting_input: 90,
  requires_action: 80,
  running: 70,
  waiting_retry: 60,
  queued: 50,
  claimed: 40,
  ready: 30,
  failed: 20
}

function safeRemoteString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  let bounded = value.trim()
  if (!bounded) return undefined
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    bounded = bounded.replace(pattern, '[REDACTED]')
  }
  if (bounded.length > max) bounded = bounded.slice(0, max)
  return bounded || undefined
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function activationUpdatedAt(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function attentionFor(projection: ExecutionRunProjection): RemoteExecutionAttention {
  const states = Object.values(projection.activations).map((activation) => activation.state)
  if (states.includes('waiting_approval')) return 'awaiting_approval'
  if (states.includes('waiting_input')) return 'awaiting_input'
  if (
    projection.state === 'requires_action' ||
    projection.integrity === 'invalid' ||
    projection.baseRevisionMissing ||
    states.includes('requires_action')
  ) {
    return 'requires_action'
  }
  if (projection.state === 'failed' || states.includes('failed')) return 'failed'
  return 'none'
}

function activeActivation(projection: ExecutionRunProjection, attention: RemoteExecutionAttention) {
  if (projection.state === 'succeeded' || projection.state === 'cancelled') return undefined

  const activations = Object.values(projection.activations)
  const attentionCandidates = activations.filter((activation) => {
    if (attention === 'awaiting_approval') return activation.state === 'waiting_approval'
    if (attention === 'awaiting_input') return activation.state === 'waiting_input'
    if (attention === 'requires_action') return activation.state === 'requires_action'
    if (attention === 'failed') return activation.state === 'failed'
    return ACTIVE_STATE_PRIORITY[activation.state] !== undefined
  })
  const candidates =
    attentionCandidates.length > 0
      ? attentionCandidates
      : activations.filter((activation) => ACTIVE_STATE_PRIORITY[activation.state] !== undefined)

  return candidates.sort((a, b) => {
    const stateDifference =
      (ACTIVE_STATE_PRIORITY[b.state] ?? 0) - (ACTIVE_STATE_PRIORITY[a.state] ?? 0)
    if (stateDifference !== 0) return stateDifference
    const timeDifference = activationUpdatedAt(b.updatedAt) - activationUpdatedAt(a.updatedAt)
    return timeDifference !== 0 ? timeDifference : a.id.localeCompare(b.id)
  })[0]
}

function latestActivationByStep(projection: ExecutionRunProjection) {
  const latest = new Map<string, (typeof projection.activations)[string]>()
  for (const activation of Object.values(projection.activations)) {
    const previous = latest.get(activation.stepId)
    if (
      !previous ||
      activationUpdatedAt(activation.updatedAt) > activationUpdatedAt(previous.updatedAt)
    ) {
      latest.set(activation.stepId, activation)
    }
  }
  return latest
}

function reasonFor(
  projection: ExecutionRunProjection,
  attention: RemoteExecutionAttention,
  active: ReturnType<typeof activeActivation>
): string | undefined {
  const activationReason = safeRemoteString(active?.reason, REMOTE_EXECUTION_REASON_MAX)
  if (activationReason) return activationReason
  if (projection.baseRevisionMissing) return 'Pinned graph revision is unavailable.'
  if (projection.integrity === 'invalid') return 'Execution state could not be verified.'
  if (attention === 'awaiting_approval') return 'Approval required.'
  if (attention === 'awaiting_input') return 'Input required.'
  if (attention === 'requires_action') return 'Execution requires attention.'
  if (attention === 'failed') return 'Execution failed.'
  return projection.state === 'cancelled' ? 'Execution cancelled.' : undefined
}

/** Build the deliberately lossy record sent to remote attention surfaces. */
export function buildRemoteExecutionRun(projection: ExecutionRunProjection): RemoteExecutionRun {
  const attention = attentionFor(projection)
  const active = activeActivation(projection, attention)
  const activeDefinition = active
    ? projection.topology.steps.find((step) => step.id === active.stepId)
    : undefined
  const latestByStep = latestActivationByStep(projection)
  const completedStepCount = [...latestByStep.values()].filter((activation) =>
    TERMINAL_ACTIVATION_STATES.has(activation.state)
  ).length

  const executionId =
    safeRemoteString(projection.executionId, REMOTE_EXECUTION_ID_MAX) || 'unknown-execution'
  const tenantId = safeRemoteString(projection.tenant?.tenantId, REMOTE_EXECUTION_ID_MAX)
  const workspaceId = safeRemoteString(projection.workspaceId, REMOTE_EXECUTION_ID_MAX)
  const threadId = safeRemoteString(projection.rootChatId, REMOTE_EXECUTION_ID_MAX)
  const title = safeRemoteString(projection.title, REMOTE_EXECUTION_TITLE_MAX)
  const activeId = safeRemoteString(active?.stepId, REMOTE_EXECUTION_ID_MAX)
  const activeTitle = safeRemoteString(activeDefinition?.title, REMOTE_EXECUTION_TITLE_MAX)
  const reason = reasonFor(projection, attention, active)
  const createdAt = safeTimestamp(projection.createdAt)
  const updatedAt = safeTimestamp(projection.updatedAt)

  return {
    schemaVersion: 1,
    executionId,
    ...(projection.tenant ? { tenantKind: projection.tenant.kind } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(title ? { title } : {}),
    state: projection.state,
    attention,
    ...(active && activeId && activeTitle
      ? { activeStep: { id: activeId, title: activeTitle, state: active.state } }
      : {}),
    completedStepCount,
    totalStepCount: projection.topology.steps.length,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(reason ? { reason } : {})
  }
}

/**
 * Filter, project, sort, and cap execution records for a remote workspace
 * snapshot. Attention-requiring runs lead, followed by most recently updated.
 */
export function buildRemoteExecutionRunList(
  projections: readonly ExecutionRunProjection[],
  options: RemoteExecutionRunListOptions = {}
): readonly RemoteExecutionRun[] {
  const workspaceFilter =
    typeof options.workspaceId === 'string' && options.workspaceId.trim()
      ? options.workspaceId.trim()
      : undefined
  const requestedLimit = Number.isFinite(options.limit) ? Math.trunc(options.limit ?? 0) : 0
  const limit = Math.min(
    REMOTE_EXECUTION_RUN_LIST_MAX,
    Math.max(1, requestedLimit || REMOTE_EXECUTION_RUN_LIST_DEFAULT)
  )

  return projections
    .filter((projection) => !workspaceFilter || projection.workspaceId === workspaceFilter)
    .map(buildRemoteExecutionRun)
    .sort((a, b) => {
      const attentionDifference = ATTENTION_PRIORITY[b.attention] - ATTENTION_PRIORITY[a.attention]
      if (attentionDifference !== 0) return attentionDifference
      const timeDifference = Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')
      if (Number.isFinite(timeDifference) && timeDifference !== 0) return timeDifference
      return a.executionId.localeCompare(b.executionId)
    })
    .slice(0, limit)
}
