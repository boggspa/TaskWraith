import type { ToolActivity } from '../../../main/store/types'
import { isReasoningToolName } from './ToolParser'

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

export interface CollapsedStackSummary {
  /** "Thought for 12s · Searched ×8 · Read 5 files · Edited 2 files" */
  label: string
  /** Count of error-status activities, surfaced on the summary row. */
  errorCount: number
  /** Total activities folded away (for the a11y label / tooltip). */
  activityCount: number
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

function thinkingDurationLabel(totalMs: number): string {
  if (totalMs < 1000) return 'Thought'
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
  activities: readonly ToolActivity[]
): CollapsedStackSummary {
  let thinkingCount = 0
  let thinkingMs = 0
  let errorCount = 0
  const familyOrder: string[] = []
  const familyCounts = new Map<string, number>()
  const familyFiles = new Map<string, Set<string>>()

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
    if (activity.status === 'error') errorCount += 1
    if (isThinkingStackActivity(activity)) {
      thinkingCount += 1
      thinkingMs += Math.max(0, activity.durationMs || 0)
      continue
    }
    bump(activity.category === 'unknown' ? 'task' : activity.category, activity.filePath)
  }

  const parts: string[] = []
  if (thinkingCount > 0) parts.push(thinkingDurationLabel(thinkingMs))
  for (const family of familyOrder) {
    const count = familyCounts.get(family) || 0
    const files = familyFiles.get(family)?.size || 0
    switch (family) {
      case 'read':
        parts.push(files > 0 ? `Read ${pluralize(files, 'file')}` : `Read ×${count}`)
        break
      case 'write':
        parts.push(files > 0 ? `Edited ${pluralize(files, 'file')}` : `Edited ×${count}`)
        break
      case 'search':
        parts.push(count === 1 ? 'Searched once' : `Searched ×${count}`)
        break
      case 'shell':
        parts.push(`Ran ${pluralize(count, 'command')}`)
        break
      default:
        parts.push(count === 1 ? 'Used 1 tool' : `Used ${count} tools`)
        break
    }
  }
  if (parts.length === 0) parts.push('Activity')
  if (errorCount > 0) parts.push(pluralize(errorCount, 'error'))

  return {
    label: parts.join(' · '),
    errorCount,
    activityCount: activities.length
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
  if (input.activities.length === 0) return false
  return !activityStackHasLiveWork(input.activities)
}
