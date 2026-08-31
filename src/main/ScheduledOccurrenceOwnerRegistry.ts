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
  'ollama',
  'antigravity',
  'pi',
  'mistral'
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
  | 'duplicate-chat'
  | 'duplicate-child-run'
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

type ScheduledChildKind = 'loop' | 'ensemble'

interface ScheduledChildBinding {
  readonly kind: ScheduledChildKind
  readonly owner: ScheduledOccurrenceOwner
  readonly provider: ProviderId
}

export interface OrdinaryChatDispatchReservation {
  readonly chatId: string
  readonly nonce: symbol
}

/**
 * Short-lived exclusive launch fence for a dispatch whose pre-session work
 * must observe a stable chat transcript. Unlike an ordinary reservation, this
 * excludes scheduled claims and every other ordinary/exclusive launch until a
 * concrete RunManager session exists (or launch fails).
 */
export interface ExclusiveChatDispatchReservation {
  readonly chatId: string
  readonly nonce: symbol
}

/**
 * A context-isolated execution-graph attempt. Graph attempts deliberately
 * coexist with the owning thread's ordinary provider turn and with sibling
 * graph attempts; otherwise a parent holding `ensemble_await` prevents its own
 * UltraTask from starting. They still exclude scheduled and truly-exclusive
 * launches so ownership cannot cross those authority boundaries.
 */
export interface ConcurrentGraphChatDispatchReservation {
  readonly chatId: string
  readonly nonce: symbol
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
 *
 * Ordinary (non-scheduled) dispatch reservations are the OTHER direction of the
 * scheduled↔ordinary exclusion only — many may be live on one chat at once.
 * Legitimate ordinary dispatches overlap per chat: ensemble fan-out launches
 * its lanes concurrently, and the default Claude SDK path holds its dispatch
 * open for the whole turn. Serializing ordinary dispatches here skipped live
 * fan-out lanes with `duplicate-chat`.
 */
export class ScheduledOccurrenceOwnerRegistry {
  private readonly byTaskId = new Map<string, ScheduledOccurrenceOwner>()
  private readonly byOwnerRunId = new Map<string, ScheduledOccurrenceOwner>()
  private readonly byChatId = new Map<string, ScheduledOccurrenceOwner>()
  // chatId → every live ordinary reservation; empty sets are deleted so
  // `.has(chatId)` always means "at least one dispatch is mid-flight".
  private readonly ordinaryDispatchByChatId = new Map<
    string,
    Set<OrdinaryChatDispatchReservation>
  >()
  private readonly exclusiveDispatchByChatId = new Map<
    string,
    ExclusiveChatDispatchReservation
  >()
  private readonly graphDispatchByChatId = new Map<
    string,
    Set<ConcurrentGraphChatDispatchReservation>
  >()
  private readonly byChildRunId = new Map<string, ScheduledChildBinding>()
  private readonly childRunIdsByOwnerRunId = new Map<string, Set<string>>()
  // A released child id must not become an ordinary renderer run later in the
  // same process. Root ids remain durable on ScheduledTask; child ids need this
  // process-local replay tombstone after their live indexes are removed.
  private readonly observedChildRunIds = new Set<string>()
  private readonly byRoundId = new Map<string, ScheduledOccurrenceOwner>()
  private readonly roundIdByOwnerRunId = new Map<string, string>()
  private readonly observedRoundIds = new Set<string>()

  register(input: ScheduledOccurrenceOwner): ScheduledOccurrenceOwner {
    const owner = snapshotOwner(input)
    if (
      this.byChatId.has(owner.chatId) ||
      this.ordinaryDispatchByChatId.has(owner.chatId) ||
      this.graphDispatchByChatId.has(owner.chatId) ||
      this.exclusiveDispatchByChatId.has(owner.chatId)
    ) {
      fail('duplicate-chat', `Chat ${owner.chatId} already has a live dispatch owner.`)
    }
    if (this.byTaskId.has(owner.taskId)) {
      fail('duplicate-task', `Scheduled task ${owner.taskId} already has a live owner.`)
    }
    if (
      this.byOwnerRunId.has(owner.ownerRunId) ||
      this.observedChildRunIds.has(owner.ownerRunId)
    ) {
      fail('duplicate-run', `Scheduled run ${owner.ownerRunId} already has a live owner.`)
    }
    this.byTaskId.set(owner.taskId, owner)
    this.byOwnerRunId.set(owner.ownerRunId, owner)
    this.byChatId.set(owner.chatId, owner)
    return owner
  }

  lookupByTaskId(taskId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(taskId) ? this.byTaskId.get(taskId) : undefined
  }

  lookupByOwnerRunId(ownerRunId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(ownerRunId) ? this.byOwnerRunId.get(ownerRunId) : undefined
  }

  lookupByChatId(chatId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(chatId) ? this.byChatId.get(chatId) : undefined
  }

  /**
   * Reserve one in-flight ordinary dispatch on a chat. Only a live SCHEDULED
   * owner blocks the reservation; concurrent ordinary reservations coexist
   * (fan-out lanes, a Claude dispatch consuming its stream inline). While any
   * reservation is live, `register` refuses a scheduled claim on the chat.
   */
  reserveOrdinaryChatDispatch(chatId: string): OrdinaryChatDispatchReservation {
    if (!isExactNonEmptyString(chatId)) {
      fail('invalid-input', 'An exact chat id is required for dispatch reservation.')
    }
    if (this.byChatId.has(chatId) || this.exclusiveDispatchByChatId.has(chatId)) {
      fail('duplicate-chat', `Chat ${chatId} already has a live dispatch owner.`)
    }
    const reservation = Object.freeze({ chatId, nonce: Symbol(chatId) })
    const reservations = this.ordinaryDispatchByChatId.get(chatId) ?? new Set()
    reservations.add(reservation)
    this.ordinaryDispatchByChatId.set(chatId, reservations)
    return reservation
  }

  releaseOrdinaryChatDispatch(reservation: OrdinaryChatDispatchReservation): boolean {
    const reservations = this.ordinaryDispatchByChatId.get(reservation.chatId)
    if (!reservations?.has(reservation)) return false
    reservations.delete(reservation)
    if (reservations.size === 0) this.ordinaryDispatchByChatId.delete(reservation.chatId)
    return true
  }

  hasOrdinaryChatDispatchReservation(chatId: string): boolean {
    return isExactNonEmptyString(chatId) && this.ordinaryDispatchByChatId.has(chatId)
  }

  /**
   * Reserve one context-isolated execution-graph lane. Unlike the exclusive
   * pre-session fence, this reservation may overlap the parent turn and sibling
   * graph lanes on the same root chat. That overlap is the durable workflow's
   * async contract; each lane retains an exact run/attempt identity elsewhere.
   */
  reserveConcurrentGraphChatDispatch(chatId: string): ConcurrentGraphChatDispatchReservation {
    if (!isExactNonEmptyString(chatId)) {
      fail('invalid-input', 'An exact chat id is required for graph dispatch reservation.')
    }
    if (this.byChatId.has(chatId) || this.exclusiveDispatchByChatId.has(chatId)) {
      fail('duplicate-chat', `Chat ${chatId} already has a live dispatch owner.`)
    }
    const reservation = Object.freeze({ chatId, nonce: Symbol(chatId) })
    const reservations = this.graphDispatchByChatId.get(chatId) ?? new Set()
    reservations.add(reservation)
    this.graphDispatchByChatId.set(chatId, reservations)
    return reservation
  }

  releaseConcurrentGraphChatDispatch(reservation: ConcurrentGraphChatDispatchReservation): boolean {
    const reservations = this.graphDispatchByChatId.get(reservation.chatId)
    if (!reservations?.has(reservation)) return false
    reservations.delete(reservation)
    if (reservations.size === 0) this.graphDispatchByChatId.delete(reservation.chatId)
    return true
  }

  hasConcurrentGraphChatDispatchReservation(chatId: string): boolean {
    return isExactNonEmptyString(chatId) && this.graphDispatchByChatId.has(chatId)
  }

  /**
   * Reserve the chat exclusively across graph composition and provider
   * preflight. The reservation is intentionally process-local and short-lived:
   * the caller releases it as soon as the exact RunManager session exists.
   */
  reserveExclusiveChatDispatch(chatId: string): ExclusiveChatDispatchReservation {
    if (!isExactNonEmptyString(chatId)) {
      fail('invalid-input', 'An exact chat id is required for exclusive dispatch reservation.')
    }
    if (
      this.byChatId.has(chatId) ||
      this.ordinaryDispatchByChatId.has(chatId) ||
      this.graphDispatchByChatId.has(chatId) ||
      this.exclusiveDispatchByChatId.has(chatId)
    ) {
      fail('duplicate-chat', `Chat ${chatId} already has a live dispatch owner.`)
    }
    const reservation = Object.freeze({ chatId, nonce: Symbol(chatId) })
    this.exclusiveDispatchByChatId.set(chatId, reservation)
    return reservation
  }

  releaseExclusiveChatDispatch(reservation: ExclusiveChatDispatchReservation): boolean {
    if (this.exclusiveDispatchByChatId.get(reservation.chatId) !== reservation) return false
    this.exclusiveDispatchByChatId.delete(reservation.chatId)
    return true
  }

  hasExclusiveChatDispatchReservation(chatId: string): boolean {
    return isExactNonEmptyString(chatId) && this.exclusiveDispatchByChatId.has(chatId)
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
    this.observedRoundIds.add(roundId)
    return owner
  }

  lookupEnsembleRound(roundId: string): ScheduledOccurrenceOwner | undefined {
    return isExactNonEmptyString(roundId) ? this.byRoundId.get(roundId) : undefined
  }

  lookupEnsembleRoundIdForOwner(owner: ScheduledOccurrenceOwner): string | undefined {
    if (this.lookupByOwnerRunId(owner.ownerRunId) !== owner) return undefined
    return this.roundIdByOwnerRunId.get(owner.ownerRunId)
  }

  wasEnsembleRoundIdObserved(roundId: string): boolean {
    return isExactNonEmptyString(roundId) && this.observedRoundIds.has(roundId)
  }

  /** Bind one provider child run to its already-claimed loop root. */
  bindLoopChildRun(
    childRunId: string,
    ownerRunId: string,
    provider: ProviderId
  ): ScheduledOccurrenceOwner {
    if (
      !isExactNonEmptyString(childRunId) ||
      !isExactNonEmptyString(ownerRunId) ||
      !isProviderId(provider)
    ) {
      fail('invalid-input', 'An exact child run id, owner run id, and provider are required.')
    }
    const owner = this.byOwnerRunId.get(ownerRunId)
    if (!owner || owner.rootOwner !== 'loop-root') {
      fail('owner-kind-mismatch', 'Scheduled loop child owner is not a live loop root.')
    }
    return this.bindChildRun(childRunId, owner, 'loop', provider)
  }

  lookupLoopChildRun(
    childRunId: string,
    provider: ProviderId
  ): ScheduledOccurrenceOwner | undefined {
    if (!isExactNonEmptyString(childRunId) || !isProviderId(provider)) return undefined
    const binding = this.byChildRunId.get(childRunId)
    return binding?.kind === 'loop' && binding.provider === provider
      ? binding.owner
      : undefined
  }

  /** Bind one provider child run to its exact reserved ensemble round. */
  bindEnsembleChildRun(
    childRunId: string,
    roundId: string,
    provider: ProviderId
  ): ScheduledOccurrenceOwner {
    if (
      !isExactNonEmptyString(childRunId) ||
      !isExactNonEmptyString(roundId) ||
      !isProviderId(provider)
    ) {
      fail('invalid-input', 'An exact child run id, round id, and provider are required.')
    }
    const owner = this.byRoundId.get(roundId)
    if (!owner || owner.rootOwner !== 'ensemble-root') {
      fail('round-owner-mismatch', 'Scheduled ensemble child has no live owning round.')
    }
    return this.bindChildRun(childRunId, owner, 'ensemble', provider)
  }

  lookupEnsembleChildRun(
    childRunId: string,
    provider: ProviderId
  ): ScheduledOccurrenceOwner | undefined {
    if (!isExactNonEmptyString(childRunId) || !isProviderId(provider)) return undefined
    const binding = this.byChildRunId.get(childRunId)
    return binding?.kind === 'ensemble' && binding.provider === provider
      ? binding.owner
      : undefined
  }

  wasChildRunIdObserved(childRunId: string): boolean {
    return isExactNonEmptyString(childRunId) && this.observedChildRunIds.has(childRunId)
  }

  lookupChildRunIdsForOwner(owner: ScheduledOccurrenceOwner): readonly string[] {
    if (this.lookupByOwnerRunId(owner.ownerRunId) !== owner) return Object.freeze([])
    return Object.freeze([
      ...(this.childRunIdsByOwnerRunId.get(owner.ownerRunId) ?? new Set<string>())
    ])
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
    return (
      isExactNonEmptyString(appRunId) &&
      (this.byOwnerRunId.has(appRunId) || this.byChildRunId.has(appRunId))
    )
  }

  private bindChildRun(
    childRunId: string,
    owner: ScheduledOccurrenceOwner,
    kind: ScheduledChildKind,
    provider: ProviderId
  ): ScheduledOccurrenceOwner {
    if (
      this.byOwnerRunId.has(childRunId) ||
      this.byChildRunId.has(childRunId) ||
      this.observedChildRunIds.has(childRunId)
    ) {
      fail('duplicate-child-run', `Scheduled ${kind} child ${childRunId} is already bound.`)
    }
    this.byChildRunId.set(childRunId, Object.freeze({ kind, owner, provider }))
    this.observedChildRunIds.add(childRunId)
    const childRunIds = this.childRunIdsByOwnerRunId.get(owner.ownerRunId) ?? new Set<string>()
    childRunIds.add(childRunId)
    this.childRunIdsByOwnerRunId.set(owner.ownerRunId, childRunIds)
    return owner
  }

  private remove(owner: ScheduledOccurrenceOwner): void {
    this.byTaskId.delete(owner.taskId)
    this.byOwnerRunId.delete(owner.ownerRunId)
    this.byChatId.delete(owner.chatId)
    const roundId = this.roundIdByOwnerRunId.get(owner.ownerRunId)
    if (roundId !== undefined) {
      this.roundIdByOwnerRunId.delete(owner.ownerRunId)
      this.byRoundId.delete(roundId)
    }
    const childRunIds = this.childRunIdsByOwnerRunId.get(owner.ownerRunId)
    if (childRunIds) {
      this.childRunIdsByOwnerRunId.delete(owner.ownerRunId)
      for (const childRunId of childRunIds) this.byChildRunId.delete(childRunId)
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
