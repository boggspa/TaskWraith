import type { ChatMessage, ChatRecord, ChatRun, ToolActivity, ToolActivityDetailRef } from './types'

export const TOOL_DETAIL_EXTERNALIZATION_GENERATION = 1

export interface ToolActivityDetailSink {
  (runId: string, activity: ToolActivity): ToolActivityDetailRef | null
}

export interface ChatToolDetailExternalizationResult {
  chat: ChatRecord
  externalizedActivityCount: number
  completedRunIds: string[]
}

const HEAVY_TOOL_ACTIVITY_FIELDS = [
  'parameters',
  'resultSummary',
  'outputPreview',
  'rawUseEvent',
  'rawResultEvent',
  'outputSummary'
] as const satisfies readonly (keyof ToolActivity)[]

function isTerminalRun(run: ChatRun, hasLaterRun: boolean): boolean {
  const status = String(run.status || '')
    .trim()
    .toLowerCase()
  if (
    status === 'running' ||
    status === 'pending' ||
    status === 'starting' ||
    status === 'sleeping'
  ) {
    return false
  }
  const terminalStatus =
    status === 'success' ||
    status === 'success_with_warnings' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'error'
  // `status` can flip before the provider exit/terminal save reaches the
  // store. Require an explicit seal for the latest run; a later run is itself
  // durable proof that an older status-only record crossed its turn boundary.
  return Boolean(
    run.endedAt || run.cancelled || run.exitCode !== undefined || (hasLaterRun && terminalStatus)
  )
}

export function hasExternalizableToolActivityDetail(activity: ToolActivity): boolean {
  return HEAVY_TOOL_ACTIVITY_FIELDS.some((field) => activity[field] !== undefined)
}

export function compactToolActivityWithDetailRef(
  activity: ToolActivity,
  detailRef: ToolActivityDetailRef
): ToolActivity {
  const compact = { ...activity, detailRef }
  for (const field of HEAVY_TOOL_ACTIVITY_FIELDS) delete compact[field]
  return compact
}

/**
 * Traverse each newly-terminal run exactly once. The sink stages complete
 * activities in durable storage; only successful stages are replaced by
 * lightweight transcript rows. A run is stamped only when every detail row
 * was safely externalized, so failures remain retryable without data loss.
 */
export function externalizeTerminalToolActivityDetails(
  chat: ChatRecord,
  sink: ToolActivityDetailSink
): ChatToolDetailExternalizationResult {
  const runs = Array.isArray(chat.runs) ? chat.runs : []
  const candidateRunIds = new Set<string>()
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]
    if (
      isTerminalRun(run, index < runs.length - 1) &&
      run.toolDetailExternalizationGeneration !== TOOL_DETAIL_EXTERNALIZATION_GENERATION
    ) {
      candidateRunIds.add(run.runId)
    }
  }
  if (candidateRunIds.size === 0) {
    return { chat, externalizedActivityCount: 0, completedRunIds: [] }
  }

  const incompleteRunIds = new Set<string>()
  let externalizedActivityCount = 0
  let messagesChanged = false
  const nextMessages = chat.messages.map((message: ChatMessage) => {
    const runId = message.runId
    const activities = message.toolActivities
    if (!runId || !candidateRunIds.has(runId) || !Array.isArray(activities)) return message

    let activitiesChanged = false
    const nextActivities = activities.map((activity) => {
      if (!hasExternalizableToolActivityDetail(activity)) return activity
      let detailRef: ToolActivityDetailRef | null = null
      try {
        detailRef = sink(runId, activity)
      } catch {
        detailRef = null
      }
      if (!detailRef) {
        incompleteRunIds.add(runId)
        return activity
      }
      activitiesChanged = true
      externalizedActivityCount += 1
      return compactToolActivityWithDetailRef(activity, detailRef)
    })
    if (!activitiesChanged) return message
    messagesChanged = true
    return { ...message, toolActivities: nextActivities }
  })

  const completedRunIds: string[] = []
  let runsChanged = false
  const nextRuns = runs.map((run) => {
    if (!candidateRunIds.has(run.runId) || incompleteRunIds.has(run.runId)) return run
    completedRunIds.push(run.runId)
    runsChanged = true
    return {
      ...run,
      toolDetailExternalizationGeneration: TOOL_DETAIL_EXTERNALIZATION_GENERATION
    }
  })
  if (!messagesChanged && !runsChanged) {
    return { chat, externalizedActivityCount, completedRunIds }
  }
  return {
    chat: {
      ...chat,
      messages: messagesChanged ? nextMessages : chat.messages,
      runs: runsChanged ? nextRuns : runs
    },
    externalizedActivityCount,
    completedRunIds
  }
}
