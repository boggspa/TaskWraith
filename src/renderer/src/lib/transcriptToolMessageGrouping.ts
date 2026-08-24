import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import {
  resolveCanonicalToolName,
  resolveCatalogToolName
} from '../../../shared/canonicalToolCoalesce'
import { mergeToolDiffSummary } from '../../../shared/toolDiffSummaryMerge'
import { coalesceMirroredTaskWraithActivities as coalesceToolActivityMirrors } from '../../../shared/toolActivityMirrorCoalesce'
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

function rawActivityToolName(activity: ToolActivity): string {
  const raw = activity.rawUseEvent
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ''
  const record = raw as Record<string, unknown>
  const nestedFunction =
    record.function && typeof record.function === 'object' && !Array.isArray(record.function)
      ? (record.function as Record<string, unknown>)
      : {}
  const value = record.tool_name || record.toolName || record.name || nestedFunction.name
  return typeof value === 'string' ? value : ''
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

function isLiveActivityStatus(status: ToolActivity['status']): boolean {
  return status === 'running' || status === 'pending'
}

function taskWraithWrapperCanonicalToolName(activity: ToolActivity): string | null {
  // Canonical activity projection can replace a provider wrapper name (for
  // example mcp__TaskWraith__image_view -> image_view). Mirror proof still
  // needs the exact wrapper, so recover it from the retained raw event.
  const wrapperName = rawActivityToolName(activity) || activity.toolName
  const isTaskWraithWrapper =
    /^mcp__(?:taskwraith|taskwraith-broker)__/i.test(wrapperName) ||
    /^taskwraith(?:[-_](?:broker|mistral|grok))?[_-]/i.test(wrapperName)
  if (!isTaskWraithWrapper) return null
  // Gateway calls are already projected to their strict target by the shared
  // display normalizer, while `rawUseEvent` deliberately retains the outer
  // capability_invoke provenance. Use that resolved activity identity for
  // mirror proof; the host receipt names the same target.
  if (/capability[_-]?invoke/i.test(wrapperName)) {
    return resolveCatalogToolName(activity.toolName) || null
  }
  return resolveCatalogToolName(wrapperName) || null
}

function isMirroredClaudeTaskWraithActivity(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): boolean {
  const canonicalToolName = taskWraithWrapperCanonicalToolName(providerActivity)
  if (!canonicalToolName || !providerActivity.id.startsWith('toolu_')) return false
  if (
    activityProvider(providerActivity) !== 'claude' ||
    activityProvider(hostActivity) !== 'claude'
  ) {
    return false
  }

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

function isMirroredKimiTaskWraithActivity(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): boolean {
  const canonicalToolName = taskWraithWrapperCanonicalToolName(providerActivity)
  if (!canonicalToolName || !/^\d+:tool_/i.test(providerActivity.id)) return false
  if (activityProvider(providerActivity) !== 'kimi' || activityProvider(hostActivity) !== 'kimi') {
    return false
  }
  if (resolveCanonicalToolName(hostActivity.toolName) !== canonicalToolName) return false
  if (!hostActivity.id.toLowerCase().startsWith(`kimi-mcp-${canonicalToolName}-`)) return false
  const providerLive = isLiveActivityStatus(providerActivity.status)
  const hostLive = isLiveActivityStatus(hostActivity.status)
  if (!providerLive && !hostLive) {
    if (providerActivity.status !== hostActivity.status) return false
    if (
      !providerActivity.resultSummary ||
      providerActivity.resultSummary !== hostActivity.resultSummary
    ) {
      return false
    }
  } else if (
    providerActivity.resultSummary &&
    hostActivity.resultSummary &&
    providerActivity.resultSummary !== hostActivity.resultSummary
  ) {
    return false
  }

  const providerParameters = { ...(providerActivity.parameters || {}) }
  delete providerParameters.cwd
  if (
    Object.keys(providerParameters).length > 0 &&
    mirroredParameterSignature(providerActivity.parameters) !==
      mirroredParameterSignature(hostActivity.parameters)
  ) {
    return false
  }

  const providerStart = parsedActivityTime(providerActivity.startedAt)
  const providerEnd = parsedActivityTime(providerActivity.endedAt)
  const hostStart = parsedActivityTime(hostActivity.startedAt)
  const hostEnd = parsedActivityTime(hostActivity.endedAt)
  if (providerStart === null || hostStart === null || hostStart < providerStart) return false
  if (providerEnd !== null && hostStart > providerEnd + 250) return false
  if (hostEnd !== null && hostEnd < hostStart) return false
  return providerEnd === null || hostEnd === null || hostEnd <= providerEnd + 250
}

function mergeKimiMirrorTiming(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): ToolActivity {
  const startedAt = providerActivity.startedAt || hostActivity.startedAt
  const endedAt = providerActivity.endedAt || hostActivity.endedAt
  const parsedStart = parsedActivityTime(startedAt)
  const parsedEnd = parsedActivityTime(endedAt)
  const durationMs =
    providerActivity.durationMs ??
    (parsedStart !== null && parsedEnd !== null
      ? Math.max(0, parsedEnd - parsedStart)
      : hostActivity.durationMs)
  return {
    ...hostActivity,
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(durationMs === undefined ? {} : { durationMs })
  }
}

/** Keep Claude's real provider duration while retaining any host-only diff
 * receipt. The host row is a proved mirror, so it can enrich presentation but
 * must not replace the provider row's identity or round-trip timing. */
function mergeClaudeMirror(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): ToolActivity {
  const diffSummary = hostActivity.diffSummary
    ? mergeToolDiffSummary(providerActivity.diffSummary, hostActivity.diffSummary)
    : providerActivity.diffSummary
  return {
    ...providerActivity,
    ...(providerActivity.filePath || !hostActivity.filePath
      ? {}
      : { filePath: hostActivity.filePath }),
    ...(diffSummary ? { diffSummary } : {})
  }
}

/**
 * Mistral ACP exposes an empty TaskWraith_* wrapper around a host-minted
 * mistral-mcp-* receipt. There is no wire parent id in older transcripts, so
 * coalesce only a strictly adjacent, same-target, same-provider pair whose
 * host interval is nested in the wrapper's short round trip. Unmatched rows
 * stay visible rather than guessing across simultaneous calls.
 */
function isMirroredMistralTaskWraithActivity(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): boolean {
  const canonicalToolName = taskWraithWrapperCanonicalToolName(providerActivity)
  if (!canonicalToolName) return false
  if (
    activityProvider(providerActivity) !== 'mistral' ||
    activityProvider(hostActivity) !== 'mistral'
  ) {
    return false
  }
  const wrapperName = rawActivityToolName(providerActivity) || providerActivity.toolName
  if (!/^taskwraith(?:[-_](?:broker|mistral|grok))?[_-]/i.test(wrapperName)) {
    return false
  }
  if (Object.keys(providerActivity.parameters || {}).length > 0) return false
  if (resolveCanonicalToolName(hostActivity.toolName) !== canonicalToolName) return false
  if (!hostActivity.id.toLowerCase().startsWith(`mistral-mcp-${canonicalToolName}-`)) return false
  const providerLive = isLiveActivityStatus(providerActivity.status)
  const hostLive = isLiveActivityStatus(hostActivity.status)
  if (!providerLive && !hostLive && providerActivity.status !== hostActivity.status) return false

  const providerStart = parsedActivityTime(providerActivity.startedAt)
  const providerEnd = parsedActivityTime(providerActivity.endedAt)
  const hostStart = parsedActivityTime(hostActivity.startedAt)
  const hostEnd = parsedActivityTime(hostActivity.endedAt)
  if (providerStart === null || hostStart === null || hostStart < providerStart) return false
  if (hostStart - providerStart > 1_000) return false
  if (providerEnd !== null && hostStart > providerEnd + 250) return false
  if (hostEnd !== null && hostEnd < hostStart) return false
  return providerEnd === null || hostEnd === null || hostEnd <= providerEnd + 250
}

/**
 * Claude reports TaskWraith MCP execution twice: its provider-native `toolu_`
 * wrapper and the host's `claude-mcp-*` execution receipt. Keep the provider
 * activity (the real round-trip duration) only when identity, payload, result,
 * attribution, and nested timing all prove that the following row is a mirror.
 *
 * Kimi ACP now has the same dual projection, but its outer `N:tool_*` row has
 * no arguments while the host receipt owns the path/command and exact diff.
 * Keep that enriched host activity and copy the outer round-trip timing onto
 * it. A Kimi wrapper is removed only when canonical identity, attribution,
 * compatible lifecycle evidence, and nested timing prove a matching host
 * receipt; an unbrokered or denied wrapper therefore remains visible.
 */
export function coalesceMirroredTaskWraithActivities(
  activities: readonly ToolActivity[]
): ToolActivity[] {
  const coalesced: ToolActivity[] = []
  for (const activity of activities) {
    const previous = coalesced[coalesced.length - 1]
    if (previous && isMirroredClaudeTaskWraithActivity(previous, activity)) {
      coalesced[coalesced.length - 1] = mergeClaudeMirror(previous, activity)
      continue
    }

    let kimiProviderIndex = -1
    for (let index = coalesced.length - 1; index >= 0; index -= 1) {
      if (isMirroredKimiTaskWraithActivity(coalesced[index], activity)) {
        kimiProviderIndex = index
        break
      }
    }
    if (kimiProviderIndex >= 0) {
      const providerActivity = coalesced[kimiProviderIndex]
      coalesced.splice(kimiProviderIndex, 1)
      coalesced.push(mergeKimiMirrorTiming(providerActivity, activity))
      continue
    }
    let mistralProviderIndex = -1
    for (let index = coalesced.length - 1; index >= 0; index -= 1) {
      if (isMirroredMistralTaskWraithActivity(coalesced[index], activity)) {
        mistralProviderIndex = index
        break
      }
    }
    if (mistralProviderIndex >= 0) {
      const providerActivity = coalesced[mistralProviderIndex]
      coalesced.splice(mistralProviderIndex, 1)
      coalesced.push(mergeKimiMirrorTiming(providerActivity, activity))
      continue
    }
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
  const toolActivities = coalesceToolActivityMirrors(
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
