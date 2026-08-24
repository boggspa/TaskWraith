import type { ToolActivity, ToolActivityStatus, ToolDiffSummary } from '../../../main/store/types'
import { deriveToolDiffSummary, estimateLineChanges, isErroredToolStatus } from './ToolParser'

/**
 * Pure helper that decides what (if anything) the per-row inline odometer
 * should display next to a tool activity label — matching the Codex-style
 * `+46 -23` pattern.
 *
 * The helper coalesces three independent signals in priority order:
 *   1. A normalised `diffSummary` carried by the activity (server-side truth).
 *   2. Pure parameter inspection (old_string/new_string, content, edits[]).
 *   3. A speculative `lineChangesFromContent` fallback for write-style tools.
 *
 * Suppression rules:
 *   - Activities with no concrete additions or deletions stay silent.
 *     `+0 -0` reads as a meaningful edit stat, but in practice it is
 *     usually a placeholder from an edit/write tool that has no hunk
 *     counts to report.
 *   - Activities with neither additions nor deletions defined render nothing.
 */

export type InlineStatStatus = ToolActivityStatus

export interface InlineStatInputs {
  toolName: string
  status: InlineStatStatus
  parameters?: Record<string, unknown>
  resultText?: string
  diffSummary?: ToolDiffSummary
}

export interface InlineStatResult {
  /** When true, the odometer should render. */
  visible: boolean
  additions: number
  deletions: number
  /** Diff confidence — used to surface the `~` "estimated" marker. */
  confidence?: ToolDiffSummary['confidence']
}

const WRITE_LIKE_TOOLS = new Set([
  'replace',
  'write_file',
  'create_file',
  'edit_file',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'strreplaceeditor'
])

function looksWriteLike(toolName: string): boolean {
  const normalised = (toolName || '').toLowerCase()
  if (!normalised) return false
  if (WRITE_LIKE_TOOLS.has(normalised)) return true
  // MCP-prefixed names like `TaskWraith__write_file` or `mcp__server__replace`.
  if (normalised.endsWith('__write_file')) return true
  if (normalised.endsWith('__replace')) return true
  if (normalised.endsWith('__create_file')) return true
  if (normalised.endsWith('__edit_file')) return true
  if (normalised.endsWith('__create_directory')) return true
  if (normalised.endsWith('__delete_path')) return true
  if (normalised.endsWith('__move_path')) return true
  if (normalised.endsWith('__rename_path')) return true
  if (normalised.endsWith('__edit')) return true
  return false
}

/** Stats from a Claude `MultiEdit` parameters payload (`edits: [{old_string, new_string}, ...]`). */
function multiEditLineChanges(parameters: Record<string, unknown>): {
  additions?: number
  deletions?: number
} {
  const edits = parameters.edits
  if (!Array.isArray(edits) || edits.length === 0) return {}
  let additions = 0
  let deletions = 0
  let touched = false
  for (const raw of edits) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const oldString = item.old_string ?? item.oldString ?? item.old_text ?? item.oldText
    const newString = item.new_string ?? item.newString ?? item.new_text ?? item.newText
    if (typeof oldString === 'string' || typeof newString === 'string') {
      additions += typeof newString === 'string' ? newString.split('\n').length : 0
      deletions += typeof oldString === 'string' ? oldString.split('\n').length : 0
      touched = true
    }
  }
  if (!touched) return {}
  return { additions, deletions }
}

function lineChangesFromContent(
  toolName: string,
  parameters: Record<string, unknown>
): { additions?: number; deletions?: number } {
  const content =
    typeof parameters.content === 'string'
      ? parameters.content
      : typeof parameters.contents === 'string'
        ? parameters.contents
        : undefined
  if (content === undefined) return {}
  if (!looksWriteLike(toolName)) return {}
  return { additions: content.split('\n').length, deletions: 0 }
}

export function computeInlineStats(inputs: InlineStatInputs): InlineStatResult {
  // A denied/errored edit (read-only seat auto-deny, tool error, …) changed
  // nothing on disk — never paint a "+N −M" pill for it, even though the
  // tool parameters still carry the old/new strings it WANTED to apply.
  if (isErroredToolStatus(inputs.status)) {
    return { visible: false, additions: 0, deletions: 0 }
  }
  const parameters = inputs.parameters || {}
  const diffSummary =
    inputs.diffSummary || deriveToolDiffSummary(inputs.toolName, parameters, inputs.resultText)
  const paramChanges = estimateLineChanges(parameters)
  const multiEdit = multiEditLineChanges(parameters)
  const fromContent = lineChangesFromContent(inputs.toolName, parameters)

  const additions =
    diffSummary?.additions ?? paramChanges.additions ?? multiEdit.additions ?? fromContent.additions
  const deletions =
    diffSummary?.deletions ?? paramChanges.deletions ?? multiEdit.deletions ?? fromContent.deletions
  const anyDefined = additions !== undefined || deletions !== undefined

  // Suppress entirely when nothing useful is known.
  if (!anyDefined) {
    return { visible: false, additions: 0, deletions: 0, confidence: diffSummary?.confidence }
  }

  const bothZero = (additions || 0) === 0 && (deletions || 0) === 0

  // `+0 -0` is visual noise for write/edit rows. Keep asymmetric zeroes
  // (`+N -0`, `+0 -N`) but suppress the all-zero placeholder regardless of
  // terminal state.
  if (bothZero) {
    return { visible: false, additions: 0, deletions: 0, confidence: diffSummary?.confidence }
  }

  return {
    visible: true,
    additions: additions || 0,
    deletions: deletions || 0,
    confidence: diffSummary?.confidence
  }
}

/** Convenience: derive inline stats directly from a `ToolActivity` record. */
export function inlineStatsForActivity(activity: ToolActivity): InlineStatResult {
  return computeInlineStats({
    toolName: activity.toolName,
    status: activity.status,
    parameters: activity.parameters,
    resultText: activity.resultSummary || activity.outputPreview,
    diffSummary: activity.diffSummary
  })
}

/** Summed `+N −M` for a run of activities — what a one-liner shows once it
 * has folded the individual rows away. */
export interface InlineStatTotals {
  additions: number
  deletions: number
  /** Any contributing activity reported a non-exact diff (the `~` marker). */
  estimated: boolean
}

/**
 * Add up exactly the per-row odometers the expanded rows would paint, so a
 * summary line never loses the diff — it totals it. Returns null when nothing
 * in the run carried one (errored/denied writes changed nothing on disk and
 * are suppressed by `computeInlineStats` itself).
 */
export function sumActivityDiffTotals(
  activities: readonly ToolActivity[]
): InlineStatTotals | null {
  let additions = 0
  let deletions = 0
  let estimated = false
  let seen = false
  for (const activity of activities) {
    const stats = inlineStatsForActivity(activity)
    if (!stats.visible) continue
    seen = true
    additions += stats.additions
    deletions += stats.deletions
    if (stats.confidence && stats.confidence !== 'exact') estimated = true
  }
  return seen ? { additions, deletions, estimated } : null
}
