import type {
  ProviderId,
  ScheduledOccurrenceRootOwner,
  ScheduledTask
} from './store/types'

const PROVIDER_IDS: ReadonlySet<string> = new Set([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
])

const ROOT_OWNERS: ReadonlySet<string> = new Set([
  'solo',
  'loop-root',
  'ensemble-root'
])

export interface ScheduledWorkflowOccurrence {
  readonly workflowId: string
  readonly executionId: string
  readonly plannedFor: string
  readonly taskId: string
}

/** Process-local identity for one exact, already-claimed scheduled occurrence. */
export interface ScheduledOccurrenceOwner {
  readonly taskId: string
  readonly ownerRunId: string
  readonly provider: ProviderId
  readonly chatId: string
  readonly workspaceId: string
  readonly workspacePath: string
  readonly rootOwner: ScheduledOccurrenceRootOwner
  readonly workflowOccurrence?: ScheduledWorkflowOccurrence
}

export type ScheduledOccurrenceOwnerRegistryErrorCode =
  | 'duplicate-round'
  | 'duplicate-run'
  | 'duplicate-task'
  | 'invalid-input'
  | 'invalid-task-state'
  | 'owner-kind-mismatch'
  | 'partial-workflow-linkage'
  | 'round-owner-mismatch'

export class ScheduledOccurrenceOwnerRegistryError extends Error {
  constructor(
    readonly code: ScheduledOccurrenceOwnerRegistryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ScheduledOccurrenceOwnerRegistryError'
  }
}

export interface ScheduledSoloExitIdentity {
  readonly appRunId: string
  readonly provider: ProviderId
  readonly chatId: string
}

/**
 * Derive the exact tuple accepted by AppStore's claim/heartbeat/settle APIs.
 * A task is either wholly standalone or wholly workflow-linked; partial linkage
 * is rejected rather than silently being treated as standalone authority.
 */
export function deriveScheduledWorkflowOccurrence(
  task: ScheduledTask
): ScheduledWorkflowOccurrence | undefined {
  if (!task || typeof task !== 'object') {
    fail('invalid-input', 'A scheduled task is required.')
  }

  const taskId = task.id
  const workflowId = task.workflowId
  const executionId = task.workflowExecutionId
  const plannedFor = task.workflowOccurrenceAt
  const linkage = [workflowId, executionId, plannedFor]
  const hasAnyLinkage = linkage.some((value) => value !== undefined)
  if (!hasAnyLinkage) return undefined

  if (
    !isExactNonEmptyString(taskId) ||
    !isExactNonEmptyString(workflowId) ||
    !isExactNonEmptyString(executionId) ||
    !isExactNonEmptyString(plannedFor) ||
    !Number.isFinite(Date.parse(plannedFor))
  ) {
    fail(
      'partial-workflow-linkage',
      'Workflow-linked scheduled tasks require an exact workflow, execution, planned time, and task tuple.'
    )
  }

  return Object.freeze({
    workflowId,
    executionId,
    plannedFor,
    taskId
  })
}

/** Snapshot a running claim into immutable process-local owner authority. */
export function createScheduledOccurrenceOwner(
  task: ScheduledTask,
  rootOwner: ScheduledOccurrenceRootOwner
): ScheduledOccurrenceOwner {
  if (!task || typeof task !== 'object' || task.status !== 'running') {
    fail('invalid-task-state', 'Only a claimed running scheduled task can own a run.')
  }
  if (!isRootOwner(rootOwner)) {
    fail('invalid-input', 'Scheduled occurrence root owner is invalid.')
  }

  const isEnsemble = task.kind === 'ensemble'
  if ((rootOwner === 'ensemble-root') !== isEnsemble) {
    fail(
      'owner-kind-mismatch',
      'The scheduled task kind does not match its requested root owner.'
    )
  }

  return snapshotOwner({
    taskId: task.id,
    ownerRunId: task.runId as string,
    provider: task.provider,
    chatId: task.chatId,
    workspaceId: task.workspaceId,
    workspacePath: task.workspacePath,
    rootOwner,
    workflowOccurrence: deriveScheduledWorkflowOccurrence(task)
  })
}

/**
 * Main-process registry for live scheduled occurrence ownership.
 *
 * Registration snapshots caller data. A task id, owner run id, and ensemble
 * round id may each name at most one live occurrence. Terminal consumers remove
 * all indexes synchronously so a duplicate exit/round callback has no authority.
 */
export class ScheduledOccurrenceOwnerRegistry {
  private readonly byTaskId = new Map<string, ScheduledOccurrenceOwner>()
  private readonly byOwnerRunId = new Map<string, ScheduledOccurrenceOwner>()
  private readonly byRoundId = new Map<string, ScheduledOccurrenceOwner>()
  private readonly roundIdByOwnerRunId = new Map<string, string>()

  register(input: ScheduledOccurrenceOwner): ScheduledOccurrenceOwner {
    const owner = snapshotOwner(input)
    if (this.byTaskId.has(owner.taskId)) {
      fail('duplicate-task', `Scheduled task ${owner.taskId} already has a live owner.`)
    }
    if (this.byOwnerRunId.has(owner.ownerRunId)) {
      fail('duplicate-run', `Scheduled run ${owner.ownerRunId} already has a live owner.`)
    }
    this.byTaskId.set(owner.taskId, owner)
    this.byOwnerRunId.set(owner.ownerRunId, owner)
    return owner
  }

  lookupByTaskId(taskId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(taskId) ? this.byTaskId.get(taskId) : undefined
  }

  lookupByOwnerRunId(ownerRunId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(ownerRunId) ? this.byOwnerRunId.get(ownerRunId) : undefined
  }

  /** Resolve a solo provider exit only when run, provider, and chat all match. */
  lookupSoloExit(input: ScheduledSoloExitIdentity): ScheduledOccurrenceOwner | undefined {
    if (!isSoloExitIdentity(input)) return undefined
    const owner = this.byOwnerRunId.get(input.appRunId)
    if (
      !owner ||
      owner.rootOwner !== 'solo' ||
      owner.provider !== input.provider ||
      owner.chatId !== input.chatId
    ) {
      return undefined
    }
    return owner
  }

  /** Bind one newly reserved ensemble round to its already-registered root. */
  bindEnsembleRound(roundId: string, ownerRunId: string): ScheduledOccurrenceOwner {
    if (!isExactNonEmptyString(roundId) || !isExactNonEmptyString(ownerRunId)) {
      fail('invalid-input', 'An exact round id and owner run id are required.')
    }
    if (this.byRoundId.has(roundId)) {
      fail('duplicate-round', `Ensemble round ${roundId} already has a live owner.`)
    }
    const owner = this.byOwnerRunId.get(ownerRunId)
    if (!owner || owner.rootOwner !== 'ensemble-root') {
      fail('round-owner-mismatch', 'Ensemble round owner is not a live ensemble root.')
    }
    if (this.roundIdByOwnerRunId.has(owner.ownerRunId)) {
      fail('duplicate-round', 'This ensemble root is already bound to a live round.')
    }
    this.byRoundId.set(roundId, owner)
    this.roundIdByOwnerRunId.set(owner.ownerRunId, roundId)
    return owner
  }

  lookupEnsembleRound(roundId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(roundId) ? this.byRoundId.get(roundId) : undefined
  }

  /**
   * Release exactly the live object returned by `register` after its durable
   * terminal mutation succeeds. Stale clones and mismatched identities consume
   * nothing, so callers cannot accidentally discard settlement authority.
   */
  release(owner: ScheduledOccurrenceOwner): boolean {
    if (this.lookupByOwnerRunId(owner.ownerRunId) !== owner) return false
    this.remove(owner)
    return true
  }

  isAppRunIdLiveOwned(appRunId: string): boolean {
    return isExactNonEmptyString(appRunId) && this.byOwnerRunId.has(appRunId)
  }

  private remove(owner: ScheduledOccurrenceOwner): void {
    this.byTaskId.delete(owner.taskId)
    this.byOwnerRunId.delete(owner.ownerRunId)
    const roundId = this.roundIdByOwnerRunId.get(owner.ownerRunId)
    if (roundId !== undefined) {
      this.roundIdByOwnerRunId.delete(owner.ownerRunId)
      this.byRoundId.delete(roundId)
    }
  }
}

function snapshotOwner(input: ScheduledOccurrenceOwner): ScheduledOccurrenceOwner {
  if (!input || typeof input !== 'object') {
    fail('invalid-input', 'A scheduled occurrence owner is required.')
  }

  const taskId = input.taskId
  const ownerRunId = input.ownerRunId
  const provider = input.provider
  const chatId = input.chatId
  const workspaceId = input.workspaceId
  const workspacePath = input.workspacePath
  const rootOwner = input.rootOwner
  if (
    !isExactNonEmptyString(taskId) ||
    !isExactNonEmptyString(ownerRunId) ||
    !isProviderId(provider) ||
    !isExactNonEmptyString(chatId) ||
    !isExactNonEmptyString(workspaceId) ||
    !isExactNonEmptyString(workspacePath) ||
    !isRootOwner(rootOwner)
  ) {
    fail('invalid-input', 'Scheduled occurrence owner identity is invalid.')
  }

  const workflowOccurrence = input.workflowOccurrence
    ? snapshotWorkflowOccurrence(input.workflowOccurrence, taskId)
    : undefined
  return Object.freeze({
    taskId,
    ownerRunId,
    provider,
    chatId,
    workspaceId,
    workspacePath,
    rootOwner,
    ...(workflowOccurrence ? { workflowOccurrence } : {})
  })
}

function snapshotWorkflowOccurrence(
  input: ScheduledWorkflowOccurrence,
  taskId: string
): ScheduledWorkflowOccurrence {
  if (
    !input ||
    typeof input !== 'object' ||
    !isExactNonEmptyString(input.workflowId) ||
    !isExactNonEmptyString(input.executionId) ||
    !isExactNonEmptyString(input.plannedFor) ||
    !Number.isFinite(Date.parse(input.plannedFor)) ||
    input.taskId !== taskId
  ) {
    fail('partial-workflow-linkage', 'Scheduled workflow occurrence identity is invalid.')
  }
  return Object.freeze({
    workflowId: input.workflowId,
    executionId: input.executionId,
    plannedFor: input.plannedFor,
    taskId
  })
}

function isSoloExitIdentity(input: ScheduledSoloExitIdentity): boolean {
  return Boolean(
    input &&
      typeof input === 'object' &&
      isExactNonEmptyString(input.appRunId) &&
      isProviderId(input.provider) &&
      isExactNonEmptyString(input.chatId)
  )
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.has(value)
}

function isRootOwner(value: unknown): value is ScheduledOccurrenceRootOwner {
  return typeof value === 'string' && ROOT_OWNERS.has(value)
}

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function fail(code: ScheduledOccurrenceOwnerRegistryErrorCode, message: string): never {
  throw new ScheduledOccurrenceOwnerRegistryError(code, message)
}
