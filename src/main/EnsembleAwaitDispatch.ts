import type { SubThreadMailbox, SubThreadMailboxOutcome } from './SubThreadMailbox'
import type {
  EnsembleAwaitInput,
  EnsembleAwaitResult,
  EnsembleAwaitSubThreadStatus,
  EnsembleAwaitWaveStatus
} from './services/EnsembleOrchestrator'

const SUBTHREAD_AWAIT_POLL_INTERVAL_MS = 500

interface AwaitableChildChat {
  appChatId: string
  delegationContext?: {
    joinPolicy?: { groupId?: string }
    returnResultToParent?: boolean
  }
}

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
  isParentRunActive(runId: string, parentChatId: string): boolean
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
  if (!requestedSubThreadIds && !requestedWaveIds) {
    return invalid(
      'no_targets',
      'ensemble_await: no valid sub-thread or wave targets were specified.'
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

  const now = deps.now || Date.now
  const wait = deps.delay || delayMs
  const timeoutSeconds = deps.clampTimeoutSeconds(timeoutSecondsValue)
  const deadline = now() + timeoutSeconds * 1_000
  let mailbox = deps.getSubThreadMailbox(parentChatId)

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

  const allSettled = (): boolean =>
    subThreadsReport().every((target) => target.settled) &&
    wavesReport().every((target) => target.settled)

  while (!allSettled() && now() < deadline && deps.isParentRunActive(runId, parentChatId)) {
    await wait(SUBTHREAD_AWAIT_POLL_INTERVAL_MS)
    childChats = deps.getChildChats(parentChatId)
    mailbox = deps.getSubThreadMailbox(parentChatId)
  }

  const subThreads = subThreadsReport()
  const waves = wavesReport()
  const settledCount =
    subThreads.filter((target) => target.settled).length +
    waves.filter((target) => target.settled).length
  const totalTargets = subThreads.length + waves.length
  const pendingCount = totalTargets - settledCount
  const settled = pendingCount === 0
  const parentEnded = !deps.isParentRunActive(runId, parentChatId)

  return {
    ok: true,
    tool: 'ensemble_await',
    status: settled ? 'settled' : 'timeout',
    message: settled
      ? `All ${totalTargets} awaited target(s) settled.`
      : `${settledCount}/${totalTargets} target(s) settled within ${timeoutSeconds}s${
          parentEnded ? ' (parent run ended)' : ''
        }. Re-invoke ensemble_await to keep waiting, or proceed with the settled targets.`,
    ...(subThreads.length > 0 ? { subThreads } : {}),
    ...(waves.length > 0 ? { waves } : {}),
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
  const hasChildTargets = subThreadIds !== undefined || waveIds !== undefined
  const unreturnableResult = hasChildTargets
    ? unreturnableSubThreadAwaitResult(input, deps, subThreadIds, waveIds)
    : null
  if (unreturnableResult) return unreturnableResult

  if (laneIds === undefined && hasChildTargets) {
    return awaitSubThreadTargets(input, deps, subThreadIds, waveIds, timeoutSeconds)
  }

  const awaitInput = {
    laneIds,
    subThreadIds,
    waveIds,
    timeoutSeconds
  } as EnsembleAwaitInput
  return deps.orchestrator?.awaitLanesForRun(input.runId, awaitInput) || noOrchestratorResult()
}
