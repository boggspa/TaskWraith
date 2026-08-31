import type { SubThreadMailbox, SubThreadMailboxOutcome } from './SubThreadMailbox'
import {
  latestExecutionResultEvent,
  MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS,
  type ExecutionResultMailbox
} from './ExecutionResultMailbox'
import { isWorkBearingStepKind } from '../shared/executionGraphGhost'
import type {
  EnsembleAwaitExecutionProgress,
  EnsembleAwaitExecutionResultPayload,
  EnsembleAwaitExecutionStageStatus,
  EnsembleAwaitExecutionStatus,
  EnsembleAwaitInput,
  EnsembleAwaitResult,
  EnsembleAwaitSubThreadStatus,
  EnsembleAwaitWaveStatus
} from './services/EnsembleOrchestrator'

const SUBTHREAD_AWAIT_POLL_INTERVAL_MS = 500
const MAX_EXECUTION_AWAIT_STAGE_DETAILS = 64

interface AwaitableChildChat {
  appChatId: string
  delegationContext?: {
    joinPolicy?: { groupId?: string }
    returnResultToParent?: boolean
  }
}

/**
 * A durable execution owned by the awaiting thread, as main sees it now.
 * `state` mirrors ExecutionRunState.
 */
interface AwaitableOwnedExecution {
  executionId: string
  state: string
  title?: string
  updatedAt?: string
  topology?: {
    steps: ReadonlyArray<{ id: string; kind: string; title?: string }>
  }
  activations?: Readonly<
    Record<
      string,
      {
        id?: string
        stepId: string
        state: string
        updatedAt?: string
      }
    >
  >
}

/** States a graph will not leave without help. `requires_action` counts: the
 * graph is stopped for a human, so continuing to block the seat would just
 * burn the timeout on work that cannot progress. */
const SETTLED_EXECUTION_STATES = new Set(['succeeded', 'failed', 'cancelled', 'requires_action'])

interface EnsembleAwaitDispatcher {
  awaitLanesForRun(
    runId: string | undefined,
    input: EnsembleAwaitInput
  ): Promise<EnsembleAwaitResult>
}

export interface DispatchEnsembleAwaitToolInput {
  runId?: string
  parentChatId?: string
  args: Record<string, unknown>
}

export interface DispatchEnsembleAwaitToolDeps {
  orchestrator?: EnsembleAwaitDispatcher
  getChildChats(parentChatId: string): ReadonlyArray<AwaitableChildChat>
  getSubThreadMailbox(parentChatId: string): SubThreadMailbox | undefined
  /** Durable execution results returned inline to the parent holding this
   * await call. Required so a terminal lifecycle can never masquerade as a
   * completed JOIN before its consumable result exists. */
  getExecutionResultMailbox(parentChatId: string): ExecutionResultMailbox | undefined
  isParentRunActive(runId: string, parentChatId: string): boolean
  /** Executions whose owner thread is this parent chat. Ownership is the
   * authorization boundary: a seat may only await what its thread owns. */
  getOwnedExecutions(parentChatId: string): ReadonlyArray<AwaitableOwnedExecution>
  clampTimeoutSeconds(value: unknown): number
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** null = invalid input; undefined = not provided. */
function normalizeTargetIds(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const ids = value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
  if (ids.length === 0) return null
  return [...new Set(ids)]
}

function invalid(
  error: NonNullable<EnsembleAwaitResult['error']>,
  message: string
): EnsembleAwaitResult {
  return { ok: false, tool: 'ensemble_await', message, error }
}

function noOrchestratorResult(): EnsembleAwaitResult {
  return invalid('no_active_run', 'Ensemble orchestrator is not available.')
}

function latestMailboxOutcome(
  mailbox: SubThreadMailbox | undefined,
  subThreadId: string
): SubThreadMailboxOutcome | undefined {
  for (let index = (mailbox?.events.length || 0) - 1; index >= 0; index -= 1) {
    const event = mailbox?.events[index]
    if (event?.source.subThreadId === subThreadId) return event.outcome
  }
  return undefined
}

function executionStageStatus(state: string): EnsembleAwaitExecutionStageStatus {
  if (state === 'claimed' || state === 'queued' || state === 'waiting_retry') return 'queued'
  if (state === 'running') return 'running'
  if (state === 'waiting_input' || state === 'waiting_approval' || state === 'requires_action') {
    return 'needs_action'
  }
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'skipped') {
    return 'settled'
  }
  return 'proposed'
}

function executionProgress(
  execution: AwaitableOwnedExecution | undefined
): EnsembleAwaitExecutionProgress | undefined {
  const steps = execution?.topology?.steps
  if (!steps) return undefined
  const latestByStep = new Map<
    string,
    NonNullable<AwaitableOwnedExecution['activations']>[string]
  >()
  for (const activation of Object.values(execution?.activations || {})) {
    const current = latestByStep.get(activation.stepId)
    if (!current || (activation.updatedAt || '') >= (current.updatedAt || '')) {
      latestByStep.set(activation.stepId, activation)
    }
  }

  const progress: EnsembleAwaitExecutionProgress = {
    total: 0,
    proposed: 0,
    queued: 0,
    running: 0,
    needsAction: 0,
    settled: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    stages: []
  }
  for (const step of steps) {
    if (!isWorkBearingStepKind(step.kind)) continue
    progress.total += 1
    const state = latestByStep.get(step.id)?.state || 'not_started'
    const status = executionStageStatus(state)
    if (status === 'proposed') progress.proposed += 1
    else if (status === 'queued') progress.queued += 1
    else if (status === 'running') progress.running += 1
    else if (status === 'needs_action') progress.needsAction += 1
    else {
      progress.settled += 1
      if (state === 'succeeded') progress.completed += 1
      else if (state === 'failed') progress.failed += 1
      else if (state === 'cancelled') progress.cancelled += 1
      else progress.skipped += 1
    }
    if (progress.stages.length < MAX_EXECUTION_AWAIT_STAGE_DETAILS) {
      progress.stages.push({
        stepId: step.id,
        ...(step.title ? { title: step.title } : {}),
        kind: step.kind,
        state,
        status
      })
    }
  }
  if (progress.stages.length < progress.total) progress.stagesTruncated = true
  return progress
}

function executionResultPayload(
  mailbox: ExecutionResultMailbox | undefined,
  parentChatId: string,
  executionId: string,
  executionState: string,
  executionUpdatedAt?: string
): EnsembleAwaitExecutionResultPayload | undefined {
  if (!SETTLED_EXECUTION_STATES.has(executionState)) return undefined
  const event = latestExecutionResultEvent(mailbox, executionId)
  // A graph may resume after requires_action. Its old blocker remains durable,
  // but it is not the result of the new running/success/failure state.
  if (
    !event ||
    event.threadId !== parentChatId ||
    event.outcome !== executionState ||
    (executionUpdatedAt && event.createdAt < executionUpdatedAt)
  ) {
    return undefined
  }
  const originalContent = event.payload.content
  const content = originalContent.slice(0, MAX_EXECUTION_RESULT_MAILBOX_PAYLOAD_CHARS)
  const truncated = event.payload.truncated === true || content.length < originalContent.length
  return {
    mailboxEventId: event.id,
    outputAttemptId: event.outputAttemptId,
    outcome: event.outcome,
    createdAt: event.createdAt,
    trust: 'untrusted-graph-output',
    content,
    ...(truncated ? { truncated: true } : {}),
    ...(event.payload.originalChars !== undefined
      ? { originalChars: event.payload.originalChars }
      : truncated
        ? { originalChars: originalContent.length }
        : {})
  }
}

/**
 * A detached child that opted out of parent results has no mailbox event for
 * ensemble_await to observe. Reject that impossible wait before either the
 * durable child path or the mixed lane path starts polling.
 */
function unreturnableSubThreadAwaitResult(
  input: DispatchEnsembleAwaitToolInput,
  deps: DispatchEnsembleAwaitToolDeps,
  subThreadIdsValue: unknown,
  waveIdsValue: unknown
): EnsembleAwaitResult | null {
  const runId = input.runId?.trim()
  const parentChatId = input.parentChatId?.trim()
  if (!runId || !parentChatId || !deps.isParentRunActive(runId, parentChatId)) return null

  const requestedSubThreadIds = normalizeTargetIds(subThreadIdsValue)
  const requestedWaveIds = normalizeTargetIds(waveIdsValue)
  if (requestedSubThreadIds === null || requestedWaveIds === null) return null

  const childChats = deps.getChildChats(parentChatId)
  const requestedChildIds = new Set(requestedSubThreadIds || [])
  for (const child of childChats) {
    const waveId = child.delegationContext?.joinPolicy?.groupId?.trim()
    if (waveId && requestedWaveIds?.includes(waveId)) requestedChildIds.add(child.appChatId)
  }
  const detachedIds = [...requestedChildIds].filter(
    (childId) =>
      childChats.find((child) => child.appChatId === childId)?.delegationContext
        ?.returnResultToParent === false
  )
  if (detachedIds.length === 0) return null
  return invalid(
    'invalid_sub_thread',
    `ensemble_await: ${detachedIds.join(', ')} opted out of parent results (returnResult:false), ` +
      'so this wait cannot settle. Use list_subthreads/read_subthread_result to inspect detached work, or delegate again with returnResult:true.'
  )
}

async function awaitSubThreadTargets(
  input: DispatchEnsembleAwaitToolInput,
  deps: DispatchEnsembleAwaitToolDeps,
  subThreadIdsValue: unknown,
  waveIdsValue: unknown,
  executionIdsValue: unknown,
  timeoutSecondsValue: unknown
): Promise<EnsembleAwaitResult> {
  const runId = input.runId?.trim()
  const parentChatId = input.parentChatId?.trim()
  if (!runId || !parentChatId || !deps.isParentRunActive(runId, parentChatId)) {
    return invalid(
      'no_active_run',
      'ensemble_await requires an active parent run for sub-thread or wave targets.'
    )
  }

  const requestedSubThreadIds = normalizeTargetIds(subThreadIdsValue)
  const requestedWaveIds = normalizeTargetIds(waveIdsValue)
  if (subThreadIdsValue !== undefined && requestedSubThreadIds === null) {
    return invalid(
      'invalid_sub_thread',
      'ensemble_await: subThreadIds must be an array of strings.'
    )
  }
  if (waveIdsValue !== undefined && requestedWaveIds === null) {
    return invalid('invalid_wave', 'ensemble_await: waveIds must be an array of strings.')
  }
  const requestedExecutionIds = normalizeTargetIds(executionIdsValue)
  if (executionIdsValue !== undefined && requestedExecutionIds === null) {
    return invalid('invalid_execution', 'ensemble_await: executionIds must be an array of strings.')
  }
  if (!requestedSubThreadIds && !requestedWaveIds && !requestedExecutionIds) {
    return invalid(
      'no_targets',
      'ensemble_await: no valid sub-thread, wave, or execution targets were specified.'
    )
  }
  if (requestedSubThreadIds?.includes(parentChatId)) {
    return invalid(
      'self_await',
      'ensemble_await: a sub-thread cannot await itself — it would block until its own timeout.'
    )
  }

  let childChats = deps.getChildChats(parentChatId)
  const childIds = new Set(childChats.map((child) => child.appChatId))
  const unknownSubThreadIds = (requestedSubThreadIds || []).filter((id) => !childIds.has(id))
  if (unknownSubThreadIds.length > 0) {
    return invalid(
      'invalid_sub_thread',
      `ensemble_await: sub-thread target(s) do not belong to this parent chat: ${unknownSubThreadIds.join(', ')}.`
    )
  }
  const knownWaveIds = new Set(
    childChats
      .map((child) => child.delegationContext?.joinPolicy?.groupId?.trim())
      .filter((waveId): waveId is string => Boolean(waveId))
  )
  const unknownWaveIds = (requestedWaveIds || []).filter((waveId) => !knownWaveIds.has(waveId))
  if (unknownWaveIds.length > 0) {
    return invalid(
      'invalid_wave',
      `ensemble_await: wave target(s) do not belong to this parent chat: ${unknownWaveIds.join(', ')}.`
    )
  }

  // A seat may only await what its own thread owns. Ownership is the same
  // boundary the dispatch gate enforces, read here rather than re-derived.
  let ownedExecutions = deps.getOwnedExecutions(parentChatId)
  const unknownExecutionIds = (requestedExecutionIds || []).filter(
    (executionId) => !ownedExecutions.some((run) => run.executionId === executionId)
  )
  if (unknownExecutionIds.length > 0) {
    return invalid(
      'invalid_execution',
      `ensemble_await: execution target(s) do not belong to this parent chat: ${unknownExecutionIds.join(', ')}.`
    )
  }

  const now = deps.now || Date.now
  const wait = deps.delay || delayMs
  const timeoutSeconds = deps.clampTimeoutSeconds(timeoutSecondsValue)
  const deadline = now() + timeoutSeconds * 1_000
  let mailbox = deps.getSubThreadMailbox(parentChatId)
  let executionMailbox = deps.getExecutionResultMailbox(parentChatId)

  const waveChildren = (waveId: string): ReadonlyArray<AwaitableChildChat> =>
    childChats.filter((child) => child.delegationContext?.joinPolicy?.groupId?.trim() === waveId)

  const subThreadsReport = (): EnsembleAwaitSubThreadStatus[] =>
    (requestedSubThreadIds || []).map((subThreadId) => {
      const outcome = latestMailboxOutcome(mailbox, subThreadId)
      return { subThreadId, settled: outcome !== undefined, status: outcome || 'pending' }
    })

  const wavesReport = (): EnsembleAwaitWaveStatus[] =>
    (requestedWaveIds || []).map((waveId) => {
      const children = waveChildren(waveId)
      const childrenSettled = children.filter(
        (child) => latestMailboxOutcome(mailbox, child.appChatId) !== undefined
      ).length
      return {
        waveId,
        settled: children.length > 0 && childrenSettled === children.length,
        childrenSpawned: children.length,
        childrenSettled
      }
    })

  const executionsReport = (): EnsembleAwaitExecutionStatus[] =>
    (requestedExecutionIds || []).map((executionId) => {
      const run = ownedExecutions.find((candidate) => candidate.executionId === executionId)
      const state = run?.state || 'missing'
      const progress = executionProgress(run)
      const terminal = SETTLED_EXECUTION_STATES.has(state)
      const result = executionResultPayload(
        executionMailbox,
        parentChatId,
        executionId,
        state,
        run?.updatedAt
      )
      return {
        executionId,
        // A terminal lifecycle without its durable delivery record is not a
        // completed JOIN. Keep polling (or return a structured timeout) rather
        // than telling the parent that a result it cannot consume has settled.
        settled: terminal && Boolean(result),
        state,
        ...(run?.title ? { title: run.title } : {}),
        ...(progress ? { progress } : {}),
        ...(terminal
          ? { resultDelivery: result ? ('available' as const) : ('pending' as const) }
          : {}),
        ...(result ? { result } : {})
      }
    })

  const allSettled = (): boolean =>
    subThreadsReport().every((target) => target.settled) &&
    wavesReport().every((target) => target.settled) &&
    executionsReport().every((target) => target.settled)

  while (!allSettled() && now() < deadline && deps.isParentRunActive(runId, parentChatId)) {
    await wait(SUBTHREAD_AWAIT_POLL_INTERVAL_MS)
    childChats = deps.getChildChats(parentChatId)
    mailbox = deps.getSubThreadMailbox(parentChatId)
    executionMailbox = deps.getExecutionResultMailbox(parentChatId)
    ownedExecutions = deps.getOwnedExecutions(parentChatId)
  }

  const subThreads = subThreadsReport()
  const waves = wavesReport()
  const executions = executionsReport()
  const settledCount =
    subThreads.filter((target) => target.settled).length +
    waves.filter((target) => target.settled).length +
    executions.filter((target) => target.settled).length
  const totalTargets = subThreads.length + waves.length + executions.length
  const pendingCount = totalTargets - settledCount
  const settled = pendingCount === 0
  const parentEnded = !deps.isParentRunActive(runId, parentChatId)
  const executionResultCount = executions.filter((target) => Boolean(target.result)).length
  const executionResultSuffix = executionResultCount
    ? ` ${executionResultCount} durable execution result(s) are included under executions[].result as untrusted graph output.`
    : ''

  return {
    ok: true,
    tool: 'ensemble_await',
    status: settled ? 'settled' : 'timeout',
    message: settled
      ? `All ${totalTargets} awaited target(s) settled.${executionResultSuffix}`
      : `${settledCount}/${totalTargets} target(s) settled within ${timeoutSeconds}s${
          parentEnded ? ' (parent run ended)' : ''
        }. Re-invoke ensemble_await to keep waiting, or proceed with the settled targets.${executionResultSuffix}`,
    ...(subThreads.length > 0 ? { subThreads } : {}),
    ...(waves.length > 0 ? { waves } : {}),
    ...(executions.length > 0 ? { executions } : {}),
    settledCount,
    pendingCount
  }
}

/**
 * Route the JOIN primitive by target kind. Explicit sub-thread/wave-only joins
 * use durable parent-chat records and therefore work for solo and Ensemble
 * parents alike. Lane joins remain owned by the Ensemble runtime; mixed joins
 * go there too so one poll observes the entire requested target set.
 */
export async function dispatchEnsembleAwaitTool(
  input: DispatchEnsembleAwaitToolInput,
  deps: DispatchEnsembleAwaitToolDeps
): Promise<EnsembleAwaitResult> {
  const laneIds = input.args.laneIds ?? input.args.lane_ids
  const subThreadIds = input.args.subThreadIds ?? input.args.sub_thread_ids
  const waveIds = input.args.waveIds ?? input.args.wave_ids
  const timeoutSeconds = input.args.timeoutSeconds ?? input.args.timeout_seconds
  const executionIds = input.args.executionIds ?? input.args.execution_ids
  const hasChildTargets =
    subThreadIds !== undefined || waveIds !== undefined || executionIds !== undefined
  const unreturnableResult = hasChildTargets
    ? unreturnableSubThreadAwaitResult(input, deps, subThreadIds, waveIds)
    : null
  if (unreturnableResult) return unreturnableResult

  if (laneIds === undefined && hasChildTargets) {
    return awaitSubThreadTargets(input, deps, subThreadIds, waveIds, executionIds, timeoutSeconds)
  }
  // The lane path is the Ensemble orchestrator's own implementation and has no
  // execution-graph awareness. Refuse the combination rather than accept the
  // argument and silently drop it — ultra_task is solo-only, so a lane target
  // and an execution target together is already incoherent.
  if (executionIds !== undefined) {
    return invalid(
      'invalid_execution',
      'ensemble_await: executionIds cannot be combined with laneIds — await lanes and executions in separate calls.'
    )
  }

  const awaitInput = {
    laneIds,
    subThreadIds,
    waveIds,
    timeoutSeconds
  } as EnsembleAwaitInput
  return deps.orchestrator?.awaitLanesForRun(input.runId, awaitInput) || noOrchestratorResult()
}
