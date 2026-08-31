import type { ToolActivity } from '../../../main/store/types'
import { resolveCanonicalToolName } from '../../../shared/canonicalToolCoalesce'
import { isMcpTransportWrapperActivity } from '../../../shared/toolInvocationPresentation'
import { sumActivityDiffTotals, type InlineStatTotals } from './ActivityInlineStats'
import { isHiddenInfrastructureToolName, isReasoningToolName } from './ToolParser'

/**
 * Settled-stack auto-collapse (transcript tidy-up).
 *
 * Once the conversation has moved past an activity stack (a later message
 * exists and nothing in the stack is still running), the whole stack folds
 * into a one-line summary row — "Thought for 12s · Searched ×8 · Read 5
 * files · Edited 2 files" — expandable back to the untouched sequential
 * viewports. Pure helpers only: TranscriptPanel owns the state and render.
 */

/** Mirrors ActivityStack's thinking-trace predicate (kept here, not imported
 * from the component, so lib tests never drag the component graph in). */
export function isThinkingStackActivity(activity: ToolActivity): boolean {
  if (isReasoningToolName(activity.toolName || '')) return true
  const kind = activity.parameters?.kind
  if (typeof kind === 'string' && ['thinking', 'reasoning'].includes(kind.trim().toLowerCase())) {
    return true
  }
  const displayName = (activity.displayName || '').trim().toLowerCase()
  return (
    displayName === 'thinking' ||
    displayName === 'reasoning' ||
    displayName.endsWith(' thinking') ||
    displayName.endsWith(' reasoning')
  )
}

export function activityStackHasLiveWork(activities: readonly ToolActivity[]): boolean {
  return activities.some(
    (activity) => activity.status === 'running' || activity.status === 'pending'
  )
}

function isCollapsedStackPresentationActivity(activity: ToolActivity): boolean {
  return (
    !isHiddenInfrastructureToolName(activity.toolName || '') &&
    !isMcpTransportWrapperActivity(activity)
  )
}

/** Lifecycle-routing actions have the same transcript standing as seat and
 * handoff-turn changes. Their full attributed row is conversation structure,
 * not tool noise, so no settled-stack or super-group fold may hide it behind
 * a generic "Used N tools" summary. */
function isTranscriptPriorityActivity(activity: ToolActivity): boolean {
  return resolveCanonicalToolName(activity.toolName || '') === 'ensemble_yield'
}

export type CollapsedStackFamily = 'thinking' | 'read' | 'write' | 'search' | 'shell' | 'task'

/** One " · "-joined segment of the collapsed summary line. `verb` is the
 * leading action word ("Ran", "Edited") — the failure-accent target when
 * `failed` is set; a failed part with no verb (the error tally) accents the
 * whole segment. */
export interface CollapsedStackLabelPart {
  text: string
  verb: string
  /** True when an activity behind this segment exited with error status. */
  failed: boolean
}

/** Summed `+N −M` line counts for the write activities a one-liner folded
 * away ("Edited file" / "Created file" / "Wrote file" / "Deleted file" …).
 * Totals are the sum of exactly the per-row odometers the expanded stack
 * would paint, so folding a stack never loses the diff — it adds it up.
 * Shared with the in-stack compact group, which folds the same way. */
export type CollapsedStackDiffTotals = InlineStatTotals

export interface CollapsedStackSummary {
  /** "Thought for 12s · Searched ×8 · Read 5 files · Edited 2 files" */
  label: string
  /** The same line as segments, with per-family failure attribution so the
   * row can paint just the verb of the family that failed. */
  parts: CollapsedStackLabelPart[]
  /** Activity families present, in label order — drives the icon strip. */
  families: CollapsedStackFamily[]
  /** Count of error-status activities, surfaced on the summary row. */
  errorCount: number
  /** Total activities folded away (for the a11y label / tooltip). */
  activityCount: number
  /** Summed line counts of the folded file writes, or null when none of the
   * activities carried a diff. Rendered at the end of the one-liner (main
   * transcript only — fan-out lane summaries opt out). */
  diff: CollapsedStackDiffTotals | null
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function thinkingDurationLabel(totalMs: number): string {
  if (totalMs < 1000) return 'Thought for <1s'
  const seconds = Math.round(totalMs / 1000)
  if (seconds < 60) return `Thought for ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest > 0 ? `Thought for ${minutes}m ${rest}s` : `Thought for ${minutes}m`
}

/** Build the one-line collapsed summary. Thinking leads (it visually leads
 * the expanded stack too); tool families follow in first-appearance order so
 * the summary reads in the same sequence as the work happened. */
export function summarizeCollapsedActivityStack(
  rawActivities: readonly ToolActivity[]
): CollapsedStackSummary {
  // Synthetic housekeeping rows (AntiGravity init, unclassified agy steps)
  // never count toward the folded one-liner.
  const activities = rawActivities.filter(isCollapsedStackPresentationActivity)
  let thinkingCount = 0
  let thinkingMs = 0
  let thinkingFailed = false
  let errorCount = 0
  const familyOrder: string[] = []
  const familyCounts = new Map<string, number>()
  const familyFiles = new Map<string, Set<string>>()
  const failedFamilies = new Set<string>()

  const bump = (family: string, filePath?: string): void => {
    if (!familyCounts.has(family)) familyOrder.push(family)
    familyCounts.set(family, (familyCounts.get(family) || 0) + 1)
    if (filePath) {
      const files = familyFiles.get(family) || new Set<string>()
      files.add(filePath)
      familyFiles.set(family, files)
    }
  }

  for (const activity of activities) {
    const failed = activity.status === 'error'
    if (failed) errorCount += 1
    if (isThinkingStackActivity(activity)) {
      thinkingCount += 1
      thinkingMs += Math.max(0, activity.durationMs || 0)
      if (failed) thinkingFailed = true
      continue
    }
    const family = activity.category === 'unknown' ? 'task' : activity.category
    if (failed) failedFamilies.add(family)
    bump(family, activity.filePath)
  }

  const parts: CollapsedStackLabelPart[] = []
  const families: CollapsedStackFamily[] = []
  if (thinkingCount > 0) {
    parts.push({ text: thinkingDurationLabel(thinkingMs), verb: 'Thought', failed: thinkingFailed })
    families.push('thinking')
  }
  for (const family of familyOrder) {
    const count = familyCounts.get(family) || 0
    const files = familyFiles.get(family)?.size || 0
    const failed = failedFamilies.has(family)
    switch (family) {
      case 'read':
        parts.push({
          text: files > 0 ? `Read ${pluralize(files, 'file')}` : `Read ×${count}`,
          verb: 'Read',
          failed
        })
        families.push('read')
        break
      case 'write':
        parts.push({
          text: files > 0 ? `Edited ${pluralize(files, 'file')}` : `Edited ×${count}`,
          verb: 'Edited',
          failed
        })
        families.push('write')
        break
      case 'search':
        parts.push({
          text: count === 1 ? 'Searched once' : `Searched ×${count}`,
          verb: 'Searched',
          failed
        })
        families.push('search')
        break
      case 'shell':
        parts.push({ text: `Ran ${pluralize(count, 'command')}`, verb: 'Ran', failed })
        families.push('shell')
        break
      default:
        parts.push({
          text: count === 1 ? 'Used 1 tool' : `Used ${count} tools`,
          verb: 'Used',
          failed
        })
        families.push('task')
        break
    }
  }
  if (parts.length === 0) parts.push({ text: 'Activity', verb: '', failed: false })
  if (errorCount > 0) {
    parts.push({ text: pluralize(errorCount, 'error'), verb: '', failed: true })
  }

  return {
    label: parts.map((part) => part.text).join(' · '),
    parts,
    families,
    errorCount,
    activityCount: activities.length,
    // Sum exactly what the expanded viewports would have shown per row, so a
    // folded "Edited 3 files" carries the same +N −M the three open rows
    // added up to.
    diff: sumActivityDiffTotals(activities)
  }
}

/** Screen-reader phrasing for the summed diff — the row is a single button,
 * so the totals have to ride its accessible name or they go unannounced. */
export function collapsedStackDiffAriaLabel(diff: CollapsedStackDiffTotals): string {
  const added = `${diff.additions} ${diff.additions === 1 ? 'line' : 'lines'} added`
  const removed = `${diff.deletions} ${diff.deletions === 1 ? 'line' : 'lines'} removed`
  return diff.estimated ? `about ${added}, ${removed}` : `${added}, ${removed}`
}

/** One-line label for a collapsed plain system notice: the first non-empty
 * line of the message body (CSS ellipsizes overflow). */
export function collapsedSystemNoticeLabel(content: string | undefined): string {
  for (const line of (content || '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed) return trimmed
  }
  return 'System notice'
}

/**
 * Second-level fold: a run of adjacent collapsed one-liners (same-participant
 * stack summaries + interleaved system notices) condenses into ONE merged
 * line — "Thought for 19s · Used 9 tools · Ran 4 commands · 2 system
 * notices". Activities from every member stack merge through the ordinary
 * summarizer (thinking durations sum; files dedupe per family; diff counts
 * sum across every folded write); an all-system group leads with the notice
 * count and the first notice's text.
 */
export function summarizeCollapsedSuperGroup(input: {
  activities: readonly ToolActivity[]
  systemCount: number
  firstSystemPreview: string
}): CollapsedStackSummary {
  const noticeSuffix =
    input.systemCount > 0
      ? `${input.systemCount} system ${input.systemCount === 1 ? 'notice' : 'notices'}`
      : ''
  if (input.activities.length === 0) {
    const parts = [noticeSuffix || 'System notices', input.firstSystemPreview]
      .filter(Boolean)
      .map((text) => ({ text, verb: '', failed: false }))
    return {
      label: parts.map((part) => part.text).join(' · '),
      parts,
      families: [],
      errorCount: 0,
      activityCount: 0,
      diff: null
    }
  }
  const merged = summarizeCollapsedActivityStack(input.activities)
  if (!noticeSuffix) return merged
  return {
    ...merged,
    parts: [...merged.parts, { text: noticeSuffix, verb: '', failed: false }],
    label: `${merged.label} · ${noticeSuffix}`
  }
}

/** A settled stack collapses once the conversation has moved past it: it is
 * not the live streaming row, nothing in it is still running, and at least
 * one later message exists (the freshly-settled tail stack stays open until
 * the next assistant/panel message actually arrives). */
export function shouldAutoCollapseActivityStack(input: {
  activities: readonly ToolActivity[]
  isLiveRow: boolean
  isLastRow: boolean
}): boolean {
  if (input.isLiveRow || input.isLastRow) return false
  // Keep this eligibility test in the same visibility space as the summary.
  // A stack made only of synthetic infrastructure rows has no user-facing
  // activity to fold, and previously produced a collapsed "0 activity steps"
  // control. Hidden work also cannot keep visible settled work expanded.
  const visibleActivities = input.activities.filter(isCollapsedStackPresentationActivity)
  if (visibleActivities.length === 0) return false
  if (visibleActivities.some(isTranscriptPriorityActivity)) return false
  return !activityStackHasLiveWork(visibleActivities)
}
