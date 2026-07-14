import { isDeepStrictEqual } from 'node:util'
import type {
  ScheduledTask,
  ScheduledTaskLifecycleUpdate,
  ScheduledTaskStatus,
  WorkflowDefinition
} from './store/types'
import { workflowRunTemplateAuthority } from './WorkflowAuthorityDigest'

export type RendererScheduledTaskLifecyclePatch = ScheduledTaskLifecycleUpdate

const RENDERER_LIFECYCLE_FIELDS = new Set<keyof RendererScheduledTaskLifecyclePatch>([
  'status',
  'runId',
  'firedAt',
  'completedAt',
  'lastError'
])

const TERMINAL_STATUSES = new Set<ScheduledTaskStatus>(['completed', 'failed', 'cancelled'])

function requireStatus(value: unknown): ScheduledTaskStatus {
  if (
    value === 'pending' ||
    value === 'due' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value
  }
  throw new Error('Scheduled task lifecycle status is invalid.')
}

function requireNonEmptyLifecycleString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  const normalized = value.trim()
  if (normalized.length > 512) throw new Error(`${label} is invalid.`)
  return normalized
}

function assertOnlyLifecycleFields(input: Readonly<Record<string, unknown>>): void {
  const unsupported = Object.keys(input).filter(
    (field) => !RENDERER_LIFECYCLE_FIELDS.has(field as keyof RendererScheduledTaskLifecyclePatch)
  )
  if (unsupported.length > 0) {
    throw new Error('Scheduled task configuration and workflow linkage are main-owned.')
  }
}

/**
 * Renderer IPC may report the lifecycle of an already-main-owned occurrence;
 * it may never edit the occurrence's authority/configuration envelope.
 */
export function sanitizeRendererScheduledTaskLifecyclePatch(
  existing: ScheduledTask,
  input: Readonly<Record<string, unknown>>,
  nowMs: number = Date.now()
): RendererScheduledTaskLifecyclePatch {
  assertOnlyLifecycleFields(input)
  const status = requireStatus(input.status)

  if (status === 'pending' || status === 'due') {
    throw new Error('Scheduled task readiness is main-owned.')
  }

  if (status === 'running') {
    if (existing.status !== 'due') {
      throw new Error('Only a due scheduled task can transition to running.')
    }
    const runAtMs =
      typeof existing.runAt === 'string' ? Date.parse(existing.runAt) : Number.NaN
    if (!Number.isFinite(runAtMs) || runAtMs > nowMs) {
      throw new Error('Scheduled task run time has not arrived.')
    }
    if ('completedAt' in input || 'lastError' in input) {
      throw new Error('A running transition cannot include terminal fields.')
    }
    return {
      status,
      runId: requireNonEmptyLifecycleString(input.runId, 'Scheduled task run id'),
      // Renderer timestamps are display input, not schedule/audit authority.
      firedAt: new Date(nowMs).toISOString()
    }
  }

  if ('runId' in input || 'firedAt' in input) {
    throw new Error('A terminal transition cannot replace run identity.')
  }

  const sameTerminalStatus = existing.status === status && TERMINAL_STATUSES.has(status)
  const allowed =
    sameTerminalStatus ||
    (status === 'completed' && existing.status === 'running') ||
    (status === 'failed' &&
      (existing.status === 'pending' ||
        existing.status === 'due' ||
        existing.status === 'running')) ||
    (status === 'cancelled' &&
      (existing.status === 'pending' ||
        existing.status === 'due' ||
        existing.status === 'running'))
  if (!allowed) {
    throw new Error(`Scheduled task cannot transition from ${existing.status} to ${status}.`)
  }

  // Duplicate terminal notifications are idempotent. They must not rewrite
  // durable completion/error evidence after MAIN accepted the first result.
  if (sameTerminalStatus) return { status }

  if (status === 'completed' && input.lastError !== undefined) {
    throw new Error('A completed scheduled task cannot include an error.')
  }
  if (
    input.lastError !== undefined &&
    (typeof input.lastError !== 'string' || input.lastError.length > 16_384)
  ) {
    throw new Error('Scheduled task error is invalid.')
  }

  return {
    status,
    completedAt: new Date(nowMs).toISOString(),
    ...('lastError' in input ? { lastError: input.lastError as string | undefined } : {})
  }
}

/** Fail closed unless this exact task is the workflow's current materialized occurrence. */
export function isCanonicalWorkflowScheduledTask(
  task: ScheduledTask,
  workflow: WorkflowDefinition,
  canonicalPath: (value: string) => string
): boolean {
  try {
    if (
      task.workflowId !== workflow.id ||
      workflow.workspaceId !== workflow.template.workspaceId ||
      workflow.workspaceId !== task.workspaceId ||
      canonicalPath(workflow.workspacePath) !== canonicalPath(workflow.template.workspacePath) ||
      canonicalPath(workflow.workspacePath) !== canonicalPath(task.workspacePath) ||
      !task.workflowExecutionId ||
      !task.workflowOccurrenceAt ||
      workflow.activeExecutionId !== task.workflowExecutionId
    ) {
      return false
    }
    const execution = workflow.history.find((entry) => entry.id === task.workflowExecutionId)
    if (
      !execution ||
      execution.workflowId !== workflow.id ||
      execution.scheduledTaskId !== task.id ||
      execution.plannedFor !== task.workflowOccurrenceAt
    ) {
      return false
    }
    const hasLiveLifecyclePair =
      (task.status === 'due' && execution.status === 'queued') ||
      (task.status === 'running' && execution.status === 'running')
    if (!hasLiveLifecyclePair) return false
    return isDeepStrictEqual(
      workflowRunTemplateAuthority(task, canonicalPath),
      workflowRunTemplateAuthority(workflow.template, canonicalPath)
    )
  } catch {
    return false
  }
}
