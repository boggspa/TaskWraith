import type { ToolActivity } from '../main/store/types'
import { resolveCanonicalToolName, resolveCatalogToolName } from './canonicalToolCoalesce'
import { mergeToolDiffSummary } from './toolDiffSummaryMerge'

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
  // Host mirrors add an effective cwd after the provider already emitted the
  // same request. It is routing context, not a second user-visible call.
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
  const wrapperName = rawActivityToolName(activity) || activity.toolName
  const isTaskWraithWrapper =
    /^mcp__(?:taskwraith|taskwraith-broker)__/i.test(wrapperName) ||
    /^taskwraith(?:[-_](?:broker|mistral|grok))?[_-]/i.test(wrapperName)
  if (!isTaskWraithWrapper) return null
  // Gateway calls retain their outer raw invocation for audit, while their
  // activity is already target-projected. Mirror proof therefore compares the
  // target to the host receipt, never the transparent wrapper name.
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
  if (!hostActivity.id.toLowerCase().startsWith(`claude-mcp-${canonicalToolName}-`)) return false
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

/**
 * Muse streams its own MSP `call_…` row for every TaskWraith MCP invocation and
 * ALSO receives the host mirror, because `muse` is absent from
 * `PROVIDERS_WITH_NATIVE_MCP_TRANSCRIPT_ROWS` — its MSP transport landed after
 * that list's 2026-08-18 run-event measurement, so it was never measured. The
 * fix belongs here rather than in that list: only the MSP lane was observed
 * twinning (38/38 native↔mirror across the two Muse runs that carry MCP rows),
 * and no exec-lane Muse run carries MCP rows at all, so suppressing the mirror
 * at the gateway would DELETE an exec-lane card instead of deduplicating it.
 *
 * Coalescing therefore proves the twin from both rows and is a no-op whenever
 * only one of them is present. The MSP row reframes a failure as
 * `tool failed: <reserialised payload>`, so its result text is deliberately NOT
 * required to match on the error path — the host receipt owns the governed
 * text, and the shared arguments are what prove the pair.
 */
function isMirroredMuseTaskWraithActivity(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): boolean {
  const canonicalToolName = taskWraithWrapperCanonicalToolName(providerActivity)
  // Only MSP call ids were measured. An exec-lane or legacy row carrying some
  // other id shape is unproven, and folding it would delete a card.
  if (!canonicalToolName || !/^call_/i.test(providerActivity.id)) return false
  if (activityProvider(providerActivity) !== 'muse' || activityProvider(hostActivity) !== 'muse') {
    return false
  }
  if (resolveCanonicalToolName(hostActivity.toolName) !== canonicalToolName) return false
  if (!hostActivity.id.toLowerCase().startsWith(`muse-mcp-${canonicalToolName}-`)) return false

  const providerLive = isLiveActivityStatus(providerActivity.status)
  const hostLive = isLiveActivityStatus(hostActivity.status)
  if (!providerLive && !hostLive) {
    if (providerActivity.status !== hostActivity.status) return false
    // A successful pair was byte-identical in every measured row, so require it.
    // The errored pair cannot be: the MSP row prefixes and reserialises.
    if (
      hostActivity.status === 'success' &&
      providerActivity.resultSummary !== hostActivity.resultSummary
    ) {
      return false
    }
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
  if (providerStart === null || hostStart === null || hostStart < providerStart) return false
  if (hostStart - providerStart > 1_000) return false
  if (providerEnd !== null && hostStart > providerEnd + 250) return false
  if (hostEnd !== null && hostEnd < hostStart) return false
  return providerEnd === null || hostEnd === null || hostEnd <= providerEnd + 250
}

function isMirroredMistralTaskWraithActivity(
  providerActivity: ToolActivity,
  hostActivity: ToolActivity
): boolean {
  const canonicalToolName = taskWraithWrapperCanonicalToolName(providerActivity)
  const wrapperName = rawActivityToolName(providerActivity) || providerActivity.toolName
  if (!canonicalToolName || !/^taskwraith(?:[-_](?:broker|mistral|grok))?[_-]/i.test(wrapperName)) {
    return false
  }
  if (
    activityProvider(providerActivity) !== 'mistral' ||
    activityProvider(hostActivity) !== 'mistral'
  ) {
    return false
  }
  if (Object.keys(providerActivity.parameters || {}).length > 0) return false
  if (resolveCanonicalToolName(hostActivity.toolName) !== canonicalToolName) return false
  if (!hostActivity.id.toLowerCase().startsWith(`mistral-mcp-${canonicalToolName}-`)) {
    return false
  }
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

function mergeHostTiming(providerActivity: ToolActivity, hostActivity: ToolActivity): ToolActivity {
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
 * Collapse only proven provider/native ↔ host execution mirrors. This runs in
 * both normal transcript grouping and fan-out lane grouping so a provider's
 * richer host receipt (path/diff) cannot disappear simply because a row is
 * rendered through Ensemble instead of a solo transcript.
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

    // Kimi, Mistral and Muse all keep the enriched HOST receipt and copy the
    // provider wrapper's round-trip timing onto it, so one index serves all
    // three: the search breaks on the first match, so at most one can win.
    let hostRetainedProviderIndex = -1
    for (let index = coalesced.length - 1; index >= 0; index -= 1) {
      if (
        isMirroredKimiTaskWraithActivity(coalesced[index], activity) ||
        isMirroredMistralTaskWraithActivity(coalesced[index], activity) ||
        isMirroredMuseTaskWraithActivity(coalesced[index], activity)
      ) {
        hostRetainedProviderIndex = index
        break
      }
    }
    if (hostRetainedProviderIndex >= 0) {
      const providerActivity = coalesced[hostRetainedProviderIndex]
      coalesced.splice(hostRetainedProviderIndex, 1)
      coalesced.push(mergeHostTiming(providerActivity, activity))
      continue
    }
    coalesced.push(activity)
  }
  return coalesced
}
