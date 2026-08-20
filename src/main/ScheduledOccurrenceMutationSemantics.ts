import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, parse as parsePath, resolve as resolvePath } from 'node:path'
import { buildRunQueueDispatchReceipt } from './RunQueueDispatchReceipt'
import { isDurableScheduledAttachmentRef } from './ScheduledAttachmentDurability'
import type {
  PersistedAttachmentRef,
  ScheduledOccurrenceSealV2,
  ScheduledTask,
  ScheduledTaskAttachmentRef,
  WorkflowDefinition,
  WorkflowExecutionRecord
} from './store/types'
import { createWorkflowRunEvent, type WorkflowRunEvent } from './WorkflowRunStore'
import {
  isTerminalWorkflowExecutionStatus,
  resolveNextWorkflowRunAt
} from './workflows/WorkflowScheduler'

export const WORKFLOW_HISTORY_LIMIT = 50

const LOWER_HEX_256 = /^[0-9a-f]{64}$/
const OCCURRENCE_ROOT_ID = /^twso-root-v1:[0-9a-f]{64}$/
const OCCURRENCE_SEAL_V2_KEYS = [
  'compositeWorkflowAuthorityDigest',
  'issuedAt',
  'ownerRunId',
  'permissionPostureSetHmac',
  'rootId',
  'rootOwner',
  'runtimeProfileSetHmac',
  'schemaVersion',
  'sealMac',
  'taskAuthorityDigest',
  'workspaceRealPath'
] as const satisfies readonly (keyof ScheduledOccurrenceSealV2)[]

export type ScheduledOccurrenceClaimSealPolicy = 'forbid' | 'require-v2'

export interface ScheduledOccurrenceMutationValidationPolicy {
  readonly claimSeal: ScheduledOccurrenceClaimSealPolicy
}

/** Legacy store-journal schema v1 predates occurrence seals and must reject them. */
export const LEGACY_STORE_MUTATION_VALIDATION_POLICY = Object.freeze({
  claimSeal: 'forbid' as const
})

/** Root-authenticated WAL schema v2 requires every claim to introduce one v2 seal. */
export const WAL_V2_MUTATION_VALIDATION_POLICY = Object.freeze({
  claimSeal: 'require-v2' as const
})

export type ScheduledOccurrenceMutationKind = 'materialize' | 'claim' | 'settle'
export type ScheduledOccurrenceTerminalStatus = Extract<
  ScheduledTask['status'],
  'completed' | 'failed' | 'cancelled'
>

export interface ScheduledOccurrenceIdentity {
  taskId: string
  workflowId: string
  executionId: string
  plannedFor: string
  runId?: string
}

export interface ScheduledOccurrenceLedgerPrefix {
  schemaVersion: 1
  fileExisted: boolean
  sha256: string
  byteLength: number
  eventCount: number
  tailSequence: number
}

export interface ScheduledOccurrenceMutationIntent {
  schemaVersion: 1
  id: string
  kind: ScheduledOccurrenceMutationKind
  createdAt: string
  identity: ScheduledOccurrenceIdentity
  taskBefore: ScheduledTask | null
  taskAfter: ScheduledTask
  workflowBefore: WorkflowDefinition
  workflowAfter: WorkflowDefinition
  ledgerBefore: ScheduledOccurrenceLedgerPrefix | null
  ledgerAfter: WorkflowRunEvent | null
}

export interface StandaloneScheduledOccurrenceMutationIntent {
  schemaVersion: 1
  id: string
  kind: ScheduledOccurrenceMutationKind
  createdAt: string
  identity: Omit<ScheduledOccurrenceIdentity, 'workflowId' | 'executionId'>
  taskBefore: ScheduledTask | null
  taskAfter: ScheduledTask
  workflowBefore: null
  workflowAfter: null
  ledgerBefore: null
  ledgerAfter: null
}

export type ValidatableScheduledOccurrenceMutationIntent =
  | ScheduledOccurrenceMutationIntent
  | StandaloneScheduledOccurrenceMutationIntent

export interface WorkflowTaskProjection {
  workflow: WorkflowDefinition
  priorStatus: WorkflowExecutionRecord['status']
  nextStatus: WorkflowExecutionRecord['status']
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return isDeepStrictEqual(cloneJsonValue(a), cloneJsonValue(b))
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function canonicalIsoTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null
  return parsed
}

function optionalCanonicalIsoTimestamp(value: unknown): boolean {
  return value === undefined || canonicalIsoTimestampMs(value) !== null
}

function occurrenceSealIssuedAt(value: unknown): unknown {
  return value && typeof value === 'object'
    ? (value as { issuedAt?: unknown }).issuedAt
    : undefined
}

function isExactOccurrenceSealV2Shape(value: unknown): value is ScheduledOccurrenceSealV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== OCCURRENCE_SEAL_V2_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !OCCURRENCE_SEAL_V2_KEYS.includes(key as (typeof OCCURRENCE_SEAL_V2_KEYS)[number])
    )
  ) {
    return false
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) return false
  }
  const seal = value as Partial<ScheduledOccurrenceSealV2>
  return (
    seal.schemaVersion === 2 &&
    typeof seal.rootId === 'string' &&
    OCCURRENCE_ROOT_ID.test(seal.rootId) &&
    canonicalIsoTimestampMs(seal.issuedAt) !== null &&
    isNonEmptyTrimmedString(seal.ownerRunId) &&
    (seal.rootOwner === 'solo' ||
      seal.rootOwner === 'loop-root' ||
      seal.rootOwner === 'ensemble-root') &&
    typeof seal.taskAuthorityDigest === 'string' &&
    LOWER_HEX_256.test(seal.taskAuthorityDigest) &&
    (seal.compositeWorkflowAuthorityDigest === null ||
      (typeof seal.compositeWorkflowAuthorityDigest === 'string' &&
        LOWER_HEX_256.test(seal.compositeWorkflowAuthorityDigest))) &&
    typeof seal.workspaceRealPath === 'string' &&
    seal.workspaceRealPath.length > 0 &&
    !seal.workspaceRealPath.includes('\0') &&
    isAbsolute(seal.workspaceRealPath) &&
    resolvePath(seal.workspaceRealPath) === seal.workspaceRealPath &&
    parsePath(seal.workspaceRealPath).root !== seal.workspaceRealPath &&
    typeof seal.runtimeProfileSetHmac === 'string' &&
    LOWER_HEX_256.test(seal.runtimeProfileSetHmac) &&
    typeof seal.permissionPostureSetHmac === 'string' &&
    LOWER_HEX_256.test(seal.permissionPostureSetHmac) &&
    typeof seal.sealMac === 'string' &&
    LOWER_HEX_256.test(seal.sealMac)
  )
}

function expectedOccurrenceRootOwner(
  intent: ValidatableScheduledOccurrenceMutationIntent
): ScheduledOccurrenceSealV2['rootOwner'] {
  if (intent.taskAfter.kind === 'ensemble') return 'ensemble-root'
  return intent.workflowAfter?.loop ? 'loop-root' : 'solo'
}

function sealMatchesOccurrenceStructure(
  seal: unknown,
  intent: ValidatableScheduledOccurrenceMutationIntent,
  issuedAt: string
): seal is ScheduledOccurrenceSealV2 {
  if (!isExactOccurrenceSealV2Shape(seal)) return false
  const workflowProjection = intent.workflowAfter !== null
  return (
    seal.ownerRunId === intent.identity.runId &&
    seal.issuedAt === issuedAt &&
    seal.rootOwner === expectedOccurrenceRootOwner(intent) &&
    (workflowProjection
      ? seal.compositeWorkflowAuthorityDigest !== null
      : seal.compositeWorkflowAuthorityDigest === null)
  )
}

function validateScheduledOccurrenceSealPolicy(
  intent: ValidatableScheduledOccurrenceMutationIntent,
  policy: ScheduledOccurrenceMutationValidationPolicy
): string | null {
  if (policy.claimSeal !== 'forbid' && policy.claimSeal !== 'require-v2') {
    return 'Scheduled occurrence mutation validation policy is invalid.'
  }
  const beforeSeal = intent.taskBefore?.occurrenceSeal
  const afterSeal = intent.taskAfter.occurrenceSeal
  if (policy.claimSeal === 'forbid') {
    return beforeSeal === undefined && afterSeal === undefined
      ? null
      : 'Legacy scheduled occurrence mutation authority cannot contain an occurrence seal.'
  }
  if (intent.kind === 'materialize') {
    return beforeSeal === undefined && afterSeal === undefined
      ? null
      : 'Scheduled occurrence materialization cannot contain an occurrence seal.'
  }
  if (intent.kind === 'claim') {
    if (
      beforeSeal !== undefined ||
      !isNonEmptyTrimmedString(intent.identity.runId) ||
      !sealMatchesOccurrenceStructure(afterSeal, intent, intent.createdAt)
    ) {
      return 'Scheduled occurrence claim must introduce one exact structurally bound v2 seal.'
    }
    return null
  }

  if (intent.identity.runId === undefined) {
    return beforeSeal === undefined && afterSeal === undefined
      ? null
      : 'Unowned scheduled occurrence settlement cannot contain an occurrence seal.'
  }
  if (beforeSeal === undefined || afterSeal === undefined) {
    return beforeSeal === afterSeal
      ? null
      : 'Scheduled occurrence settlement changes its claim seal.'
  }
  const claimIssuedAt = intent.taskBefore?.firedAt
  return typeof claimIssuedAt === 'string' &&
    sealMatchesOccurrenceStructure(beforeSeal, intent, claimIssuedAt) &&
    sealMatchesOccurrenceStructure(afterSeal, intent, claimIssuedAt) &&
    sameJsonValue(beforeSeal, afterSeal)
    ? null
    : 'Scheduled occurrence settlement does not preserve its exact structurally bound v2 seal.'
}

export function scheduledTaskStatusToWorkflowStatus(
  status: ScheduledTask['status']
): WorkflowExecutionRecord['status'] | null {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return null
}

function workflowStatusToRunEventKind(
  status: WorkflowExecutionRecord['status']
): WorkflowRunEvent['kind'] | null {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'skipped':
      return 'skipped'
    case 'queued':
      return 'materialized'
    default:
      return null
  }
}

export function isTerminalScheduledTaskStatus(
  status: ScheduledTask['status']
): status is ScheduledOccurrenceTerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function canonicalScheduledOccurrenceLedgerEvent(
  task: ScheduledTask,
  timestamp: string,
  sequence: number
): WorkflowRunEvent | null {
  if (!task.workflowId || !task.workflowExecutionId) return null
  const status = scheduledTaskStatusToWorkflowStatus(task.status)
  const kind = status ? workflowStatusToRunEventKind(status) : null
  if (!kind) return null
  return createWorkflowRunEvent(
    {
      workflowExecutionId: task.workflowExecutionId,
      workflowId: task.workflowId,
      kind,
      timestamp,
      scheduledTaskId: task.id,
      runId: task.runId,
      plannedFor: task.workflowOccurrenceAt || task.runAt,
      ...(task.lastError ? { error: task.lastError } : {})
    },
    sequence
  )
}

export function workflowExecutionMatchesIdentity(
  execution: WorkflowExecutionRecord,
  identity: ScheduledOccurrenceIdentity
): boolean {
  return (
    execution.id === identity.executionId &&
    execution.workflowId === identity.workflowId &&
    execution.scheduledTaskId === identity.taskId &&
    execution.plannedFor === identity.plannedFor
  )
}

export function taskMatchesOccurrenceIdentity(
  task: ScheduledTask,
  identity: ScheduledOccurrenceIdentity
): boolean {
  return (
    task.id === identity.taskId &&
    task.workflowId === identity.workflowId &&
    task.workflowExecutionId === identity.executionId &&
    task.workflowOccurrenceAt === identity.plannedFor
  )
}

function jsonObjectWithoutKeys<T extends object>(
  value: T,
  keys: ReadonlySet<string>
): Record<string, unknown> {
  const clone = cloneJsonValue(value) as Record<string, unknown>
  for (const key of keys) delete clone[key]
  return clone
}

function hasOnlyAllowedObjectDeltas<T extends object>(
  before: T,
  after: T,
  allowedKeys: ReadonlySet<string>
): boolean {
  return sameJsonValue(
    jsonObjectWithoutKeys(before, allowedKeys),
    jsonObjectWithoutKeys(after, allowedKeys)
  )
}

function materializedTaskMatchesWorkflowAuthority(
  task: ScheduledTask,
  workflow: WorkflowDefinition
): boolean {
  if (
    task.workspaceId !== workflow.workspaceId ||
    task.workspacePath !== workflow.workspacePath
  ) {
    return false
  }
  const template = workflow.template as Record<string, unknown>
  const taskRecord = task as unknown as Record<string, unknown>
  for (const [key, expected] of Object.entries(template)) {
    if (key === 'imageAttachments') continue
    if (key === 'displayPrompt') {
      if (!isDeepStrictEqual(task.displayPrompt, expected || workflow.template.prompt)) return false
      continue
    }
    if (!isDeepStrictEqual(taskRecord[key], expected)) return false
  }
  const lifecycleKeys = new Set([
    ...Object.keys(template),
    'displayPrompt',
    'workflowMode',
    'id',
    'runAt',
    'timezone',
    'status',
    'createdAt',
    'updatedAt',
    'workflowId',
    'workflowExecutionId',
    'workflowOccurrenceAt',
    'dispatchReceipt',
    'occurrenceSeal'
  ])
  return Object.keys(taskRecord).every((key) => lifecycleKeys.has(key))
}

function scheduledAttachmentsAreDurable(
  value: unknown
): value is Array<ScheduledTaskAttachmentRef & PersistedAttachmentRef> {
  return Array.isArray(value) && value.every(isDurableScheduledAttachmentRef)
}

function materializedAttachmentsMatchTemplate(
  task: ScheduledTask,
  workflow: WorkflowDefinition
): boolean {
  const source = workflow.template.imageAttachments
  const resolved = task.imageAttachments
  if (
    !scheduledAttachmentsAreDurable(source) ||
    !scheduledAttachmentsAreDurable(resolved) ||
    source.length !== resolved.length
  ) {
    return false
  }
  return resolved.every((attachment, index) => {
    const original = source[index]
    return (
      attachment.persistenceVersion === original.persistenceVersion &&
      attachment.id === original.id &&
      attachment.name === original.name &&
      attachment.sha256 === original.sha256 &&
      attachment.mimeType.toLowerCase() === original.mimeType.toLowerCase() &&
      attachment.byteLength === original.byteLength
    )
  })
}

export function buildScheduledTaskDispatchReceipt(task: ScheduledTask, generatedAt?: string) {
  const workflowMode = task.workflowMode === 'plan' ? 'plan' : 'normal'
  const input: Parameters<typeof buildRunQueueDispatchReceipt>[0] = {
    runId: task.runId || task.id,
    provider: task.provider,
    source: 'scheduled',
    scope: 'workspace',
    workspaceId: task.workspaceId,
    chatId: task.chatId,
    permissionPosture: task.permissionPosture,
    request: {
      scope: 'workspace',
      prompt: task.prompt,
      ...(task.displayPrompt ? { displayPrompt: task.displayPrompt } : {}),
      selectedModelType: task.selectedModelType,
      customModel: task.customModel,
      approvalMode: task.permissionPosture?.approvalMode || task.approvalMode,
      workflowMode,
      sessionTrust: task.sessionTrust,
      imageAttachments: task.imageAttachments || [],
      ...(task.externalPathGrants?.length ? { externalPathGrants: task.externalPathGrants } : {}),
      ...(task.geminiWorktree ? { geminiWorktree: task.geminiWorktree } : {}),
      ...(task.codexReasoningEffort !== undefined
        ? { codexReasoningEffort: task.codexReasoningEffort }
        : {}),
      ...(task.codexServiceTier !== undefined ? { codexServiceTier: task.codexServiceTier } : {}),
      ...(task.claudeReasoningEffort !== undefined
        ? { claudeReasoningEffort: task.claudeReasoningEffort }
        : {}),
      ...(task.claudeFastMode !== undefined ? { claudeFastMode: task.claudeFastMode } : {}),
      ...(task.kimiFastMode !== undefined ? { kimiFastMode: task.kimiFastMode } : {}),
      ...(task.kimiReasoningEffort !== undefined
        ? { kimiReasoningEffort: task.kimiReasoningEffort }
        : {}),
      ...(task.grokReasoningEffort !== undefined
        ? { grokReasoningEffort: task.grokReasoningEffort }
        : {}),
      ...(task.museReasoningEffort !== undefined
        ? { museReasoningEffort: task.museReasoningEffort }
        : {}),
      ...(task.ollamaReasoningEffort !== undefined
        ? { ollamaReasoningEffort: task.ollamaReasoningEffort }
        : {}),
      ...(task.cursorReasoningEffort !== undefined
        ? { cursorReasoningEffort: task.cursorReasoningEffort }
        : {}),
      ...(task.cursorFastMode !== undefined ? { cursorFastMode: task.cursorFastMode } : {}),
      ...(task.kimiThinkingEnabled !== undefined
        ? { kimiThinkingEnabled: task.kimiThinkingEnabled }
        : {}),
      scheduledTaskId: task.id,
      scheduledRunAt: task.runAt,
      ...(task.runtimeProfileId ? { runtimeProfileId: task.runtimeProfileId } : {}),
      ...(task.geminiAuthProfileId ? { geminiAuthProfileId: task.geminiAuthProfileId } : {}),
      ...(task.handoffSourceRunId ? { handoffSourceRunId: task.handoffSourceRunId } : {})
    }
  }
  return buildRunQueueDispatchReceipt(input, generatedAt)
}

export function scheduledTaskDispatchReceiptIsExact(task: ScheduledTask): boolean {
  return Boolean(
    task.dispatchReceipt &&
      sameJsonValue(
        task.dispatchReceipt,
        buildScheduledTaskDispatchReceipt(task, task.dispatchReceipt.generatedAt)
      )
  )
}

export function projectWorkflowFromScheduledTask(
  source: WorkflowDefinition,
  task: ScheduledTask,
  nowIso: string
): WorkflowTaskProjection | null {
  if (
    !task.workflowId ||
    !task.workflowExecutionId ||
    !task.workflowOccurrenceAt ||
    source.id !== task.workflowId
  ) {
    return null
  }
  const nextStatus = scheduledTaskStatusToWorkflowStatus(task.status)
  if (!nextStatus) return null
  const workflow = cloneJsonValue(source)
  const executionIndexes = workflow.history
    .map((execution, index) => (execution.id === task.workflowExecutionId ? index : -1))
    .filter((index) => index >= 0)
  if (executionIndexes.length !== 1) return null
  const executionIndex = executionIndexes[0]
  const previous = workflow.history[executionIndex]
  if (
    !workflowExecutionMatchesIdentity(previous, {
      taskId: task.id,
      workflowId: task.workflowId,
      executionId: task.workflowExecutionId,
      plannedFor: task.workflowOccurrenceAt,
      runId: task.runId
    })
  ) {
    return null
  }

  const priorStatus = previous.status
  const terminal = isTerminalWorkflowExecutionStatus(nextStatus)
  const wasTerminal = isTerminalWorkflowExecutionStatus(previous.status)
  const isActiveExecution = workflow.activeExecutionId === task.workflowExecutionId
  const terminalRunOwnerMatches = previous.runId
    ? task.runId === previous.runId
    : previous.runId === undefined && task.runId === undefined

  if (wasTerminal || nextStatus === previous.status) return null
  if (
    nextStatus === 'running' &&
    (previous.status !== 'queued' || !isActiveExecution || !task.runId)
  ) {
    return null
  }
  if (terminal && previous.status === 'running' && !terminalRunOwnerMatches) return null
  if (
    terminal &&
    previous.status !== 'running' &&
    !(
      previous.status === 'queued' &&
      (nextStatus === 'failed' || nextStatus === 'cancelled')
    )
  ) {
    return null
  }

  workflow.history[executionIndex] = {
    ...previous,
    runId: task.runId || previous.runId,
    status: nextStatus,
    updatedAt: nowIso,
    ...(nextStatus === 'running' && !previous.startedAt
      ? { startedAt: task.firedAt || nowIso }
      : {}),
    ...(terminal ? { completedAt: task.completedAt || nowIso } : {}),
    ...(task.lastError ? { error: task.lastError } : {})
  }
  workflow.history = workflow.history.slice(-WORKFLOW_HISTORY_LIMIT)
  workflow.updatedAt = nowIso
  if (isActiveExecution) {
    workflow.lastStatus = nextStatus
    workflow.lastError = task.lastError
  }
  if (terminal && isActiveExecution) {
    workflow.lastCompletedAt = task.completedAt || nowIso
    workflow.activeExecutionId = undefined
    workflow.failureStreak = nextStatus === 'failed' ? workflow.failureStreak + 1 : 0
    const maxFailures = workflow.limits.maxConsecutiveFailures || 3
    if (nextStatus === 'failed' && workflow.failureStreak >= maxFailures) {
      workflow.enabled = false
      workflow.nextRunAt = undefined
      workflow.lastError =
        task.lastError || `Workflow auto-disabled after ${workflow.failureStreak} failures.`
    } else if (workflow.enabled) {
      const completedAtMs = task.completedAt ? Date.parse(task.completedAt) : Number.NaN
      const nowMs = Number.isFinite(completedAtMs) ? completedAtMs : Date.now()
      const existingNextRunAtMs = workflow.nextRunAt
        ? Date.parse(workflow.nextRunAt)
        : Number.NaN
      workflow.nextRunAt =
        Number.isFinite(existingNextRunAtMs) && existingNextRunAtMs > nowMs
          ? workflow.nextRunAt
          : resolveNextWorkflowRunAt(workflow.trigger, nowMs, nowMs)
    } else {
      workflow.nextRunAt = undefined
    }
  }
  return { workflow, priorStatus, nextStatus }
}

function validateScheduledOccurrenceMutationTimestamps(
  intent: ScheduledOccurrenceMutationIntent,
  beforeExecution: WorkflowExecutionRecord | null,
  afterExecution: WorkflowExecutionRecord
): string | null {
  const { taskBefore, taskAfter, workflowBefore, workflowAfter, identity } = intent
  const requiredTimestamps: unknown[] = [
    intent.createdAt,
    identity.plannedFor,
    taskAfter.runAt,
    taskAfter.createdAt,
    taskAfter.updatedAt,
    taskAfter.workflowOccurrenceAt,
    workflowBefore.createdAt,
    workflowBefore.updatedAt,
    workflowAfter.createdAt,
    workflowAfter.updatedAt,
    afterExecution.plannedFor,
    afterExecution.createdAt,
    afterExecution.updatedAt
  ]
  const optionalTimestamps: unknown[] = [
    taskAfter.firedAt,
    taskAfter.runningSince,
    taskAfter.completedAt,
    taskAfter.dispatchReceipt?.generatedAt,
    occurrenceSealIssuedAt(taskAfter.occurrenceSeal),
    workflowBefore.nextRunAt,
    workflowBefore.lastRunAt,
    workflowBefore.lastCompletedAt,
    workflowAfter.nextRunAt,
    workflowAfter.lastRunAt,
    workflowAfter.lastCompletedAt,
    afterExecution.startedAt,
    afterExecution.completedAt,
    taskBefore?.runAt,
    taskBefore?.createdAt,
    taskBefore?.updatedAt,
    taskBefore?.workflowOccurrenceAt,
    taskBefore?.firedAt,
    taskBefore?.runningSince,
    taskBefore?.completedAt,
    taskBefore?.dispatchReceipt?.generatedAt,
    occurrenceSealIssuedAt(taskBefore?.occurrenceSeal),
    beforeExecution?.plannedFor,
    beforeExecution?.createdAt,
    beforeExecution?.updatedAt,
    beforeExecution?.startedAt,
    beforeExecution?.completedAt
  ]
  if (
    requiredTimestamps.some((value) => canonicalIsoTimestampMs(value) === null) ||
    optionalTimestamps.some((value) => !optionalCanonicalIsoTimestamp(value))
  ) {
    return 'Scheduled occurrence mutation contains a non-canonical lifecycle timestamp.'
  }

  const mutationAtMs = canonicalIsoTimestampMs(intent.createdAt) as number
  const plannedForMs = canonicalIsoTimestampMs(identity.plannedFor) as number
  const taskRunAtMs = canonicalIsoTimestampMs(taskAfter.runAt) as number
  const taskCreatedAtMs = canonicalIsoTimestampMs(taskAfter.createdAt) as number
  const taskUpdatedAtMs = canonicalIsoTimestampMs(taskAfter.updatedAt) as number
  const executionCreatedAtMs = canonicalIsoTimestampMs(afterExecution.createdAt) as number
  const executionUpdatedAtMs = canonicalIsoTimestampMs(afterExecution.updatedAt) as number
  if (
    identity.plannedFor !== taskAfter.workflowOccurrenceAt ||
    identity.plannedFor !== afterExecution.plannedFor ||
    plannedForMs > taskRunAtMs ||
    taskRunAtMs !== taskCreatedAtMs ||
    taskCreatedAtMs > taskUpdatedAtMs ||
    executionCreatedAtMs > executionUpdatedAtMs
  ) {
    return 'Scheduled occurrence mutation lifecycle timestamps are not logically ordered.'
  }

  if (intent.kind === 'materialize') {
    if (
      taskRunAtMs !== mutationAtMs ||
      taskUpdatedAtMs !== mutationAtMs ||
      taskAfter.dispatchReceipt?.generatedAt !== intent.createdAt ||
      executionCreatedAtMs !== mutationAtMs ||
      executionUpdatedAtMs !== mutationAtMs ||
      workflowAfter.updatedAt !== intent.createdAt ||
      workflowAfter.lastRunAt !== intent.createdAt
    ) {
      return 'Scheduled occurrence materialization timestamps are not an exact post-image.'
    }
    return null
  }

  if (!taskBefore || !beforeExecution) {
    return 'Scheduled occurrence mutation timestamps are missing their before-image.'
  }
  const beforeTaskUpdatedAtMs = canonicalIsoTimestampMs(taskBefore.updatedAt) as number
  const beforeExecutionUpdatedAtMs = canonicalIsoTimestampMs(beforeExecution.updatedAt) as number
  if (
    taskBefore.runAt !== taskAfter.runAt ||
    taskBefore.createdAt !== taskAfter.createdAt ||
    taskBefore.workflowOccurrenceAt !== taskAfter.workflowOccurrenceAt ||
    beforeExecution.createdAt !== afterExecution.createdAt ||
    beforeExecution.plannedFor !== afterExecution.plannedFor ||
    beforeTaskUpdatedAtMs > mutationAtMs ||
    beforeExecutionUpdatedAtMs > mutationAtMs ||
    taskUpdatedAtMs !== mutationAtMs ||
    executionUpdatedAtMs !== mutationAtMs ||
    workflowAfter.updatedAt !== intent.createdAt
  ) {
    return 'Scheduled occurrence mutation timestamps do not preserve their exact timeline.'
  }

  if (intent.kind === 'claim') {
    if (
      taskRunAtMs > mutationAtMs ||
      taskAfter.firedAt !== intent.createdAt ||
      taskAfter.runningSince !== intent.createdAt ||
      taskAfter.dispatchReceipt?.generatedAt !== intent.createdAt ||
      (taskAfter.occurrenceSeal !== undefined &&
        occurrenceSealIssuedAt(taskAfter.occurrenceSeal) !== intent.createdAt) ||
      afterExecution.startedAt !== intent.createdAt
    ) {
      return 'Scheduled occurrence claim timestamps are not an exact due-task transition.'
    }
    return null
  }

  const completedAtMs = canonicalIsoTimestampMs(taskAfter.completedAt) as number
  const executionCompletedAtMs = canonicalIsoTimestampMs(afterExecution.completedAt) as number
  const startedAt = beforeExecution.startedAt || taskBefore.runningSince || taskBefore.firedAt
  const lowerBoundMs = startedAt
    ? (canonicalIsoTimestampMs(startedAt) as number)
    : taskRunAtMs
  if (
    taskAfter.completedAt !== afterExecution.completedAt ||
    completedAtMs !== executionCompletedAtMs ||
    completedAtMs < lowerBoundMs ||
    completedAtMs > mutationAtMs
  ) {
    return 'Scheduled occurrence settlement timestamps are not logically ordered.'
  }
  return null
}

function validateScheduledOccurrenceLedgerPostImage(
  intent: ScheduledOccurrenceMutationIntent
): string | null {
  if (intent.kind === 'materialize') {
    return intent.ledgerBefore === null && intent.ledgerAfter === null
      ? null
      : 'Scheduled occurrence materialization must not carry lifecycle ledger evidence.'
  }
  const ledgerBefore = intent.ledgerBefore
  const ledgerAfter = intent.ledgerAfter
  if (
    !ledgerBefore ||
    ledgerBefore.schemaVersion !== 1 ||
    typeof ledgerBefore.fileExisted !== 'boolean' ||
    !/^[a-f0-9]{64}$/.test(ledgerBefore.sha256) ||
    !Number.isSafeInteger(ledgerBefore.byteLength) ||
    ledgerBefore.byteLength < 0 ||
    !Number.isSafeInteger(ledgerBefore.eventCount) ||
    ledgerBefore.eventCount < 0 ||
    !Number.isSafeInteger(ledgerBefore.tailSequence) ||
    ledgerBefore.tailSequence < 0 ||
    ledgerBefore.tailSequence !== ledgerBefore.eventCount ||
    (ledgerBefore.fileExisted === false &&
      (ledgerBefore.byteLength !== 0 || ledgerBefore.eventCount !== 0)) ||
    !ledgerAfter ||
    !Number.isSafeInteger(ledgerAfter.sequence) ||
    ledgerAfter.sequence !== ledgerBefore.eventCount + 1 ||
    canonicalIsoTimestampMs(ledgerAfter.timestamp) === null ||
    ledgerAfter.timestamp !== intent.createdAt
  ) {
    return 'Scheduled occurrence lifecycle ledger evidence is invalid.'
  }
  if (intent.kind === 'claim' && ledgerBefore.eventCount !== 0) {
    return 'Scheduled occurrence claim ledger prefix is not empty.'
  }
  if (
    intent.kind === 'settle' &&
    intent.identity.runId !== undefined &&
    (!ledgerBefore.fileExisted || ledgerBefore.eventCount < 1)
  ) {
    return 'Scheduled occurrence owned settlement lacks its claimed ledger predecessor.'
  }
  const expected = canonicalScheduledOccurrenceLedgerEvent(
    intent.taskAfter,
    intent.createdAt,
    ledgerAfter.sequence
  )
  return expected && sameJsonValue(expected, ledgerAfter)
    ? null
    : 'Scheduled occurrence lifecycle ledger post-image is not canonical.'
}

function validateScheduledOccurrenceMutationDeltas(
  intent: ScheduledOccurrenceMutationIntent,
  beforeExecution: WorkflowExecutionRecord | null,
  afterExecution: WorkflowExecutionRecord,
  policy: ScheduledOccurrenceMutationValidationPolicy
): string | null {
  const workflowAllowedKeys =
    intent.kind === 'materialize'
      ? new Set([
          'history',
          'activeExecutionId',
          'lastRunAt',
          'lastStatus',
          'lastError',
          'nextRunAt',
          'updatedAt'
        ])
      : intent.kind === 'claim'
        ? new Set(['history', 'lastStatus', 'lastError', 'updatedAt'])
        : new Set([
            'history',
            'lastStatus',
            'lastError',
            'lastCompletedAt',
            'activeExecutionId',
            'failureStreak',
            'enabled',
            'nextRunAt',
            'updatedAt'
          ])
  if (
    !hasOnlyAllowedObjectDeltas(
      intent.workflowBefore,
      intent.workflowAfter,
      workflowAllowedKeys
    )
  ) {
    return 'Scheduled occurrence mutation changes unrelated workflow authority.'
  }

  if (intent.kind === 'materialize') {
    const expectedHistory = [...intent.workflowBefore.history, afterExecution].slice(
      -WORKFLOW_HISTORY_LIMIT
    )
    const materializedAtMs = Date.parse(intent.taskAfter.runAt)
    const expectedNextRunAt = Number.isFinite(materializedAtMs)
      ? resolveNextWorkflowRunAt(
          intent.workflowBefore.trigger,
          materializedAtMs,
          materializedAtMs
        )
      : undefined
    const queuedExecutionKeys = new Set([
      'id',
      'workflowId',
      'scheduledTaskId',
      'plannedFor',
      'status',
      'createdAt',
      'updatedAt'
    ])
    if (
      !sameJsonValue(intent.workflowAfter.history, expectedHistory) ||
      !materializedTaskMatchesWorkflowAuthority(intent.taskAfter, intent.workflowBefore) ||
      !materializedAttachmentsMatchTemplate(intent.taskAfter, intent.workflowBefore) ||
      !scheduledTaskDispatchReceiptIsExact(intent.taskAfter) ||
      intent.taskAfter.occurrenceSeal !== undefined ||
      Object.keys(afterExecution).some((key) => !queuedExecutionKeys.has(key)) ||
      afterExecution.startedAt !== undefined ||
      afterExecution.completedAt !== undefined ||
      afterExecution.error !== undefined ||
      !Number.isFinite(materializedAtMs) ||
      intent.taskAfter.createdAt !== intent.taskAfter.runAt ||
      intent.taskAfter.updatedAt !== intent.taskAfter.runAt ||
      intent.createdAt !== intent.taskAfter.updatedAt ||
      afterExecution.createdAt !== intent.taskAfter.updatedAt ||
      afterExecution.updatedAt !== intent.taskAfter.updatedAt ||
      intent.workflowAfter.updatedAt !== intent.taskAfter.updatedAt ||
      intent.workflowAfter.lastRunAt !== intent.taskAfter.updatedAt ||
      intent.workflowAfter.activeExecutionId !== afterExecution.id ||
      intent.workflowAfter.lastStatus !== 'queued' ||
      intent.workflowAfter.lastError !== undefined ||
      intent.workflowAfter.nextRunAt !== expectedNextRunAt
    ) {
      return 'Scheduled occurrence materialization changes unrelated occurrence authority.'
    }
    return null
  }

  if (!intent.taskBefore || !beforeExecution) {
    return 'Scheduled occurrence mutation is missing an exact delta before-image.'
  }
  const taskAllowedKeys =
    intent.kind === 'claim'
      ? new Set([
          'status',
          'runId',
          'firedAt',
          'runningSince',
          'updatedAt',
          'dispatchReceipt',
          ...(policy.claimSeal === 'require-v2' ? ['occurrenceSeal'] : [])
        ])
      : new Set(['status', 'completedAt', 'lastError', 'updatedAt'])
  if (!hasOnlyAllowedObjectDeltas(intent.taskBefore, intent.taskAfter, taskAllowedKeys)) {
    return 'Scheduled occurrence mutation changes unrelated task authority.'
  }
  if (
    intent.createdAt !== intent.taskAfter.updatedAt ||
    (intent.kind === 'claim' &&
      (intent.taskAfter.firedAt !== intent.taskAfter.updatedAt ||
        intent.taskAfter.runningSince !== intent.taskAfter.updatedAt ||
        !scheduledTaskDispatchReceiptIsExact(intent.taskAfter))) ||
    (intent.kind === 'settle' &&
      (!intent.taskAfter.completedAt ||
        !Number.isFinite(Date.parse(intent.taskAfter.completedAt))))
  ) {
    return 'Scheduled occurrence mutation timestamps or receipt are not exact.'
  }

  if (
    intent.workflowBefore.history.length !== intent.workflowAfter.history.length ||
    intent.workflowBefore.history.findIndex((item) => item.id === beforeExecution.id) !==
      intent.workflowAfter.history.findIndex((item) => item.id === afterExecution.id)
  ) {
    return 'Scheduled occurrence mutation changes unrelated workflow history.'
  }
  for (let index = 0; index < intent.workflowBefore.history.length; index += 1) {
    const before = intent.workflowBefore.history[index]
    const after = intent.workflowAfter.history[index]
    if (before.id !== beforeExecution.id) {
      if (!sameJsonValue(before, after)) {
        return 'Scheduled occurrence mutation changes an unrelated workflow execution.'
      }
      continue
    }
    const executionAllowedKeys =
      intent.kind === 'claim'
        ? new Set(['status', 'runId', 'updatedAt', 'startedAt'])
        : new Set(['status', 'updatedAt', 'completedAt', 'error'])
    if (!hasOnlyAllowedObjectDeltas(before, after, executionAllowedKeys)) {
      return 'Scheduled occurrence mutation changes unrelated execution authority.'
    }
  }
  const expectedProjection = projectWorkflowFromScheduledTask(
    intent.workflowBefore,
    intent.taskAfter,
    intent.taskAfter.updatedAt
  )
  if (!expectedProjection || !sameJsonValue(expectedProjection.workflow, intent.workflowAfter)) {
    return 'Scheduled occurrence workflow post-image is not the exact task projection.'
  }
  return null
}

function validateStandaloneScheduledOccurrenceMutationIntent(
  intent: StandaloneScheduledOccurrenceMutationIntent,
  policy: ScheduledOccurrenceMutationValidationPolicy
): string | null {
  const { identity, taskBefore, taskAfter } = intent
  const sealReason = validateScheduledOccurrenceSealPolicy(intent, policy)
  if (sealReason) return sealReason
  if (
    intent.schemaVersion !== 1 ||
    !isNonEmptyTrimmedString(intent.id) ||
    !isNonEmptyTrimmedString(intent.createdAt) ||
    !['materialize', 'claim', 'settle'].includes(intent.kind) ||
    !isNonEmptyTrimmedString(identity.taskId) ||
    !isNonEmptyTrimmedString(identity.plannedFor) ||
    taskAfter.id !== identity.taskId ||
    taskAfter.runAt !== identity.plannedFor ||
    taskAfter.workflowId !== undefined ||
    taskAfter.workflowExecutionId !== undefined ||
    taskAfter.workflowOccurrenceAt !== undefined ||
    intent.workflowBefore !== null ||
    intent.workflowAfter !== null ||
    intent.ledgerBefore !== null ||
    intent.ledgerAfter !== null
  ) {
    return 'Scheduled standalone occurrence mutation metadata is invalid.'
  }
  if (
    canonicalIsoTimestampMs(intent.createdAt) === null ||
    canonicalIsoTimestampMs(identity.plannedFor) === null ||
    canonicalIsoTimestampMs(taskAfter.createdAt) === null ||
    canonicalIsoTimestampMs(taskAfter.updatedAt) === null
  ) {
    return 'Scheduled standalone occurrence mutation timestamps are invalid.'
  }

  if (intent.kind === 'materialize') {
    if (
      taskBefore !== null ||
      identity.runId !== undefined ||
      (taskAfter.status !== 'pending' && taskAfter.status !== 'due') ||
      taskAfter.runId !== undefined ||
      taskAfter.firedAt !== undefined ||
      taskAfter.runningSince !== undefined ||
      taskAfter.completedAt !== undefined ||
      taskAfter.lastError !== undefined ||
      taskAfter.occurrenceSeal !== undefined ||
      taskAfter.createdAt !== intent.createdAt ||
      taskAfter.updatedAt !== intent.createdAt ||
      !scheduledTaskDispatchReceiptIsExact(taskAfter)
    ) {
      return 'Scheduled standalone materialization is not a fresh unowned post-image.'
    }
    return null
  }

  if (!taskBefore || taskBefore.id !== identity.taskId || taskBefore.runAt !== identity.plannedFor) {
    return 'Scheduled standalone occurrence mutation is missing an exact before-image.'
  }
  if (
    taskBefore.workflowId !== undefined ||
    taskBefore.workflowExecutionId !== undefined ||
    taskBefore.workflowOccurrenceAt !== undefined
  ) {
    return 'Scheduled standalone occurrence before-image contains workflow authority.'
  }

  if (intent.kind === 'claim') {
    const allowed = new Set([
      'status',
      'runId',
      'firedAt',
      'runningSince',
      'updatedAt',
      'dispatchReceipt',
      ...(policy.claimSeal === 'require-v2' ? ['occurrenceSeal'] : [])
    ])
    if (
      !isNonEmptyTrimmedString(identity.runId) ||
      taskBefore.status !== 'due' ||
      taskBefore.runId !== undefined ||
      taskBefore.occurrenceSeal !== undefined ||
      taskAfter.status !== 'running' ||
      taskAfter.runId !== identity.runId ||
      taskAfter.firedAt !== intent.createdAt ||
      taskAfter.runningSince !== intent.createdAt ||
      taskAfter.updatedAt !== intent.createdAt ||
      taskAfter.completedAt !== undefined ||
      Date.parse(taskAfter.runAt) > Date.parse(intent.createdAt) ||
      Date.parse(taskBefore.updatedAt) > Date.parse(intent.createdAt) ||
      !hasOnlyAllowedObjectDeltas(taskBefore, taskAfter, allowed) ||
      !scheduledTaskDispatchReceiptIsExact(taskAfter)
    ) {
      return 'Scheduled standalone claim is not an exact due-to-running owner transition.'
    }
    return null
  }

  const owned = identity.runId !== undefined
  const validUnownedBefore =
    !owned &&
    taskBefore.runId === undefined &&
    ((taskBefore.status === 'due' || taskBefore.status === 'pending')
      ? taskAfter.status === 'failed' || taskAfter.status === 'cancelled'
      : taskBefore.status === 'running')
  const allowed = new Set(['status', 'completedAt', 'lastError', 'updatedAt'])
  const completedAtMs = canonicalIsoTimestampMs(taskAfter.completedAt)
  const mutationAtMs = canonicalIsoTimestampMs(intent.createdAt)
  const lowerBoundMs = canonicalIsoTimestampMs(
    taskBefore.runningSince || taskBefore.firedAt || taskBefore.runAt
  )
  if (
    !isTerminalScheduledTaskStatus(taskAfter.status) ||
    (owned
      ? taskBefore.status !== 'running' ||
        taskBefore.runId !== identity.runId ||
        taskAfter.runId !== identity.runId
      : !validUnownedBefore || taskAfter.runId !== undefined) ||
    !hasOnlyAllowedObjectDeltas(taskBefore, taskAfter, allowed) ||
    taskAfter.updatedAt !== intent.createdAt ||
    completedAtMs === null ||
    mutationAtMs === null ||
    lowerBoundMs === null ||
    completedAtMs < lowerBoundMs ||
    completedAtMs > mutationAtMs ||
    Date.parse(taskBefore.updatedAt) > mutationAtMs ||
    !scheduledTaskDispatchReceiptIsExact(taskAfter)
  ) {
    return 'Scheduled standalone settle is not an exact terminal owner transition.'
  }
  return null
}

export function validateScheduledOccurrenceMutationIntent(
  intent: ValidatableScheduledOccurrenceMutationIntent,
  policy: ScheduledOccurrenceMutationValidationPolicy
): string | null {
  if (intent.workflowBefore === null || intent.workflowAfter === null) {
    return validateStandaloneScheduledOccurrenceMutationIntent(
      intent as StandaloneScheduledOccurrenceMutationIntent,
      policy
    )
  }

  const workflowIntent = intent as ScheduledOccurrenceMutationIntent
  const sealReason = validateScheduledOccurrenceSealPolicy(workflowIntent, policy)
  if (sealReason) return sealReason
  const { identity } = workflowIntent
  if (
    workflowIntent.schemaVersion !== 1 ||
    !isNonEmptyTrimmedString(workflowIntent.id) ||
    !isNonEmptyTrimmedString(workflowIntent.createdAt) ||
    !['materialize', 'claim', 'settle'].includes(workflowIntent.kind) ||
    !isNonEmptyTrimmedString(identity.taskId) ||
    !isNonEmptyTrimmedString(identity.workflowId) ||
    !isNonEmptyTrimmedString(identity.executionId) ||
    !isNonEmptyTrimmedString(identity.plannedFor)
  ) {
    return 'Scheduled occurrence mutation metadata is invalid.'
  }
  if (
    !taskMatchesOccurrenceIdentity(workflowIntent.taskAfter, identity) ||
    workflowIntent.workflowBefore.id !== identity.workflowId ||
    workflowIntent.workflowAfter.id !== identity.workflowId
  ) {
    return 'Scheduled occurrence mutation linkage does not match its exact tuple.'
  }
  if (
    workflowIntent.taskBefore &&
    !taskMatchesOccurrenceIdentity(workflowIntent.taskBefore, identity)
  ) {
    return 'Scheduled occurrence mutation before-image does not match its exact tuple.'
  }

  const beforeExecutionIds = workflowIntent.workflowBefore.history.filter(
    (execution) => execution.id === identity.executionId
  )
  const afterExecutionIds = workflowIntent.workflowAfter.history.filter(
    (execution) => execution.id === identity.executionId
  )
  const beforeExecutions = beforeExecutionIds.filter((execution) =>
    workflowExecutionMatchesIdentity(execution, identity)
  )
  const afterExecutions = afterExecutionIds.filter((execution) =>
    workflowExecutionMatchesIdentity(execution, identity)
  )
  if (afterExecutionIds.length !== 1 || afterExecutions.length !== 1) {
    return 'Scheduled occurrence mutation after-image has an ambiguous workflow execution.'
  }
  const deltaReason = validateScheduledOccurrenceMutationDeltas(
    workflowIntent,
    beforeExecutions[0] || null,
    afterExecutions[0],
    policy
  )
  if (deltaReason) return deltaReason
  const timestampReason = validateScheduledOccurrenceMutationTimestamps(
    workflowIntent,
    beforeExecutions[0] || null,
    afterExecutions[0]
  )
  if (timestampReason) return timestampReason
  const ledgerReason = validateScheduledOccurrenceLedgerPostImage(workflowIntent)
  if (ledgerReason) return ledgerReason

  if (workflowIntent.kind === 'materialize') {
    if (
      workflowIntent.taskBefore !== null ||
      beforeExecutionIds.length !== 0 ||
      identity.runId !== undefined ||
      workflowIntent.taskAfter.status !== 'due' ||
      workflowIntent.taskAfter.runId !== undefined ||
      afterExecutions[0].status !== 'queued' ||
      afterExecutions[0].runId !== undefined
    ) {
      return 'Scheduled occurrence materialization intent is not a fresh queued occurrence.'
    }
    return null
  }

  if (
    !workflowIntent.taskBefore ||
    beforeExecutionIds.length !== 1 ||
    beforeExecutions.length !== 1
  ) {
    return 'Scheduled occurrence mutation is missing an exact before-image.'
  }
  if (workflowIntent.kind === 'claim') {
    if (
      !isNonEmptyTrimmedString(identity.runId) ||
      workflowIntent.taskBefore.status !== 'due' ||
      workflowIntent.taskBefore.runId !== undefined ||
      beforeExecutions[0].status !== 'queued' ||
      beforeExecutions[0].runId !== undefined ||
      workflowIntent.taskAfter.status !== 'running' ||
      workflowIntent.taskAfter.runId !== identity.runId ||
      afterExecutions[0].status !== 'running' ||
      afterExecutions[0].runId !== identity.runId
    ) {
      return 'Scheduled occurrence claim intent does not establish exactly one owner.'
    }
    return null
  }

  if (identity.runId === undefined) {
    const queuedTerminal =
      (workflowIntent.taskBefore.status === 'due' ||
        workflowIntent.taskBefore.status === 'pending') &&
      beforeExecutions[0].status === 'queued' &&
      (workflowIntent.taskAfter.status === 'failed' ||
        workflowIntent.taskAfter.status === 'cancelled')
    const legacyRunningTerminal =
      workflowIntent.taskBefore.status === 'running' &&
      beforeExecutions[0].status === 'running' &&
      isTerminalScheduledTaskStatus(workflowIntent.taskAfter.status)
    if (
      (!queuedTerminal && !legacyRunningTerminal) ||
      workflowIntent.taskBefore.runId !== undefined ||
      beforeExecutions[0].runId !== undefined ||
      workflowIntent.taskAfter.runId !== undefined ||
      !isTerminalWorkflowExecutionStatus(afterExecutions[0].status) ||
      afterExecutions[0].runId !== undefined ||
      scheduledTaskStatusToWorkflowStatus(workflowIntent.taskAfter.status) !==
        afterExecutions[0].status
    ) {
      return 'Scheduled occurrence unowned settle intent is not an exact queued terminal.'
    }
    return null
  }
  if (!isNonEmptyTrimmedString(identity.runId)) {
    return 'Scheduled occurrence mutation has an invalid run owner.'
  }
  if (
    workflowIntent.taskBefore.status !== 'running' ||
    workflowIntent.taskBefore.runId !== identity.runId ||
    beforeExecutions[0].status !== 'running' ||
    beforeExecutions[0].runId !== identity.runId ||
    !isTerminalScheduledTaskStatus(workflowIntent.taskAfter.status) ||
    workflowIntent.taskAfter.runId !== identity.runId ||
    !isTerminalWorkflowExecutionStatus(afterExecutions[0].status) ||
    scheduledTaskStatusToWorkflowStatus(workflowIntent.taskAfter.status) !==
      afterExecutions[0].status ||
    afterExecutions[0].runId !== identity.runId
  ) {
    return 'Scheduled occurrence settle intent does not preserve its exact run owner.'
  }
  return null
}

export function decodeScheduledOccurrenceMutationIntent(
  value: unknown,
  policy: ScheduledOccurrenceMutationValidationPolicy
): ScheduledOccurrenceMutationIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Partial<ScheduledOccurrenceMutationIntent>
  if (
    input.schemaVersion !== 1 ||
    !input.identity ||
    typeof input.identity !== 'object' ||
    !input.taskAfter ||
    typeof input.taskAfter !== 'object' ||
    !input.workflowBefore ||
    typeof input.workflowBefore !== 'object' ||
    !input.workflowAfter ||
    typeof input.workflowAfter !== 'object'
  ) {
    return null
  }
  const intent = input as ScheduledOccurrenceMutationIntent
  try {
    return validateScheduledOccurrenceMutationIntent(intent, policy) ? null : intent
  } catch {
    return null
  }
}
