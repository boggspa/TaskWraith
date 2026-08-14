import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { resolveCanonicalToolName } from '../../../shared/canonicalToolCoalesce'
import { isGuestParticipantReplyMessage } from '../components/GuestParticipantReplyCardModel'
import { isSubThreadDelegationMessage } from '../components/SubThreadDelegationCardModel'
import { isSubThreadReturnMessage } from '../components/SubThreadReturnCardModel'

function isPlainToolMessage(message: ChatMessage): boolean {
  return (
    message.role === 'tool' &&
    !isSubThreadDelegationMessage(message) &&
    !isSubThreadReturnMessage(message) &&
    !isGuestParticipantReplyMessage(message) &&
    (message.toolActivities?.length || 0) > 0
  )
}

const TOOL_ATTRIBUTION_BOUNDARY_KEYS = [
  'kind',
  'ensembleProvider',
  'ensembleParticipantId',
  'ensembleRole',
  'ensembleModel',
  'ensembleReasoningEffort',
  'ensembleThinkingEnabled',
  'ensembleOrder',
  'ensembleRoundId',
  'ensembleLaneId',
  'pooledAgentId',
  'guestProvider',
  'subThreadProvider'
]

function metadataValue(message: ChatMessage, key: string): string {
  const value = message.metadata?.[key]
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function activityProviderSignature(message: ChatMessage): string {
  return (message.toolActivities || [])
    .map((activity) => `${activity.metadata?.ensembleProvider || ''}/${activity.metadata?.provider || ''}`)
    .join('|')
}

function toolAttributionSignature(message: ChatMessage): string {
  return [
    ...TOOL_ATTRIBUTION_BOUNDARY_KEYS.map((key) => metadataValue(message, key)),
    activityProviderSignature(message)
  ].join('\u0000')
}

function sameToolRunBoundary(a: ChatMessage, b: ChatMessage): boolean {
  if ((a.runId || b.runId) && a.runId !== b.runId) return false
  return toolAttributionSignature(a) === toolAttributionSignature(b)
}

function activityProvider(activity: ToolActivity): string {
  return activity.metadata?.ensembleProvider || activity.metadata?.provider || ''
}

function stableParameterValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableParameterValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableParameterValue(record[key])])
  )
}

function mirroredParameterSignature(parameters?: Record<string, unknown>): string {
  const comparable = { ...(parameters || {}) }
  // The host mirror adds its effective workspace cwd after the provider has
  // already emitted the same MCP request. That transport context does not make
  // it a second user-visible tool call.
  delete comparable.cwd
  return JSON.stringify(stableParameterValue(comparable))
}

function parsedActivityTime(value?: string): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isMirroredClaudeTaskWraithActivity(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): boolean {
  const wrapperMatch = providerActivity.toolName.match(
    /^mcp__(?:taskwraith|taskwraith-broker)__(.+)$/i
  )
  if (!wrapperMatch || !providerActivity.id.startsWith('toolu_')) return false
  if (
    activityProvider(providerActivity) !== 'claude' ||
    activityProvider(hostActivity) !== 'claude'
  ) {
    return false
  }

  const canonicalToolName = resolveCanonicalToolName(wrapperMatch[1])
  if (resolveCanonicalToolName(hostActivity.toolName) !== canonicalToolName) return false
  if (!hostActivity.id.toLowerCase().startsWith(`claude-mcp-${canonicalToolName}-`)) {
    return false
  }
  if (providerActivity.status !== hostActivity.status) return false
  if (
    !providerActivity.resultSummary ||
    providerActivity.resultSummary !== hostActivity.resultSummary
  ) {
    return false
  }
  if (
    mirroredParameterSignature(providerActivity.parameters) !==
    mirroredParameterSignature(hostActivity.parameters)
  ) {
    return false
  }

  const providerStart = parsedActivityTime(providerActivity.startedAt)
  const providerEnd = parsedActivityTime(providerActivity.endedAt)
  const hostStart = parsedActivityTime(hostActivity.startedAt)
  const hostEnd = parsedActivityTime(hostActivity.endedAt)
  if (providerStart === null || providerEnd === null || hostStart === null || hostEnd === null) {
    return false
  }
  return (
    hostStart >= providerStart &&
    hostStart - providerStart <= 1_000 &&
    hostEnd >= hostStart &&
    hostEnd <= providerEnd + 250
  )
}

/**
 * Claude reports TaskWraith MCP execution twice: its provider-native `toolu_`
 * wrapper and the host's `claude-mcp-*` execution receipt. Keep the provider
 * activity (the real round-trip duration) only when identity, payload, result,
 * attribution, and nested timing all prove that the following row is a mirror.
 */
export function coalesceMirroredClaudeTaskWraithActivities(
  activities: readonly ToolActivity[]
): ToolActivity[] {
  const coalesced: ToolActivity[] = []
  for (const activity of activities) {
    const previous = coalesced[coalesced.length - 1]
    if (previous && isMirroredClaudeTaskWraithActivity(previous, activity)) continue
    coalesced.push(activity)
  }
  return coalesced
}

export function shouldGroupAdjacentToolMessages(a: ChatMessage, b: ChatMessage): boolean {
  return isPlainToolMessage(a) && isPlainToolMessage(b) && sameToolRunBoundary(a, b)
}

function mergeToolRun(run: ChatMessage[]): ChatMessage {
  if (run.length === 1) return run[0]
  const first = run[0]
  const toolActivities = coalesceMirroredClaudeTaskWraithActivities(
    run.flatMap((message) => message.toolActivities || [])
  )
  return {
    ...first,
    // Identity is derived from the FIRST message only, so it stays STABLE as
    // the run grows (more tool messages stream into the same group). Baking
    // `last.id`/`run.length` into the id (as before) changed the id on every
    // new tool, which churned the React key → remounted the grouped row → the
    // CSS `fadeIn` entrance replayed = visible flashing near the tail during
    // streaming. The growth is still tracked for measurement/diffing via
    // `contentVersion` (tool activity count + statuses + output length) and the
    // full constituent list is preserved in `groupedToolMessageIds` below, so
    // nothing depends on the churning id.
    id: `tool-group-${first.id}`,
    toolActivities,
    metadata: {
      ...first.metadata,
      kind: first.metadata?.kind,
      groupedToolMessageIds: run.map((message) => message.id)
    }
  }
}

export interface TranscriptGroupedMessageRange {
  message: ChatMessage
  startIndex: number
  endIndex: number
}

export function groupAdjacentToolMessagesWithRanges(
  messages: readonly ChatMessage[]
): TranscriptGroupedMessageRange[] {
  const grouped: TranscriptGroupedMessageRange[] = []
  let pending: ChatMessage[] = []
  let pendingStart = 0

  const flush = (endIndex: number): void => {
    if (pending.length > 0) {
      grouped.push({
        message: mergeToolRun(pending),
        startIndex: pendingStart,
        endIndex
      })
      pending = []
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!isPlainToolMessage(message)) {
      flush(index)
      grouped.push({ message, startIndex: index, endIndex: index + 1 })
      continue
    }

    const previous = pending[pending.length - 1]
    if (previous && !sameToolRunBoundary(previous, message)) {
      flush(index)
    }
    if (pending.length === 0) {
      pendingStart = index
    }
    pending.push(message)
  }

  flush(messages.length)
  return grouped
}

export function groupAdjacentToolMessages(messages: ChatMessage[]): ChatMessage[] {
  return groupAdjacentToolMessagesWithRanges(messages).map((entry) => entry.message)
}

// The fan-out lane fold lives in shared/ so the remote projection groups lane
// fragments identically to this renderer (one card per lane on every surface).
// Re-exported here so renderer import sites keep a single grouping module.
export {
  fanoutLaneGroupingKey,
  groupedTranscriptMessageIds,
  groupFanoutLaneMessages,
  groupFanoutLaneMessagesStable
} from '../../../shared/fanoutLaneGrouping'
export type {
  FanoutLaneGroupingCacheEntry,
  FanoutLaneGroupingState
} from '../../../shared/fanoutLaneGrouping'
