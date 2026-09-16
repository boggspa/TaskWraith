import type { ToolActivity } from '../../../main/store/types'
import type { ActivityTimelineSegmentKind } from '../components/ActivityStack'
import type { TranscriptView } from './transcriptViewOverride'

/**
 * Which of a turn's surfaces each transcript view renders, and whether what
 * survives can still be opened.
 *
 * Pure on purpose, and landed before any render wiring: the carve-out below is
 * the one rule in this feature that is easy to write correctly and easy to lose
 * in a component, so it is stated once here where a test can reach it directly.
 *
 * The three views:
 *   standard — today's transcript. Nothing is hidden, everything expands.
 *   tools    — thinking viewports are gone. Tool-call and fan-out viewports
 *              render and still expand.
 *   minimal  — assistant messages and collapsed one-liners only. Thinking,
 *              tool-call and fan-out viewports are all gone and nothing
 *              expands. The one-liner still names the work and still updates
 *              as it lands; it just never unfolds.
 *
 * Sub-agent segments (`kind: 'agent'`) survive every view. They are not one of
 * the three surfaces Minimal was asked to hide, and a spawn wave that vanished
 * would leave the reader unable to tell a delegating turn from an idle one.
 */

/** Every view, in the order a picker should offer them — quietest first. */
export const TRANSCRIPT_VIEWS: readonly TranscriptView[] = ['minimal', 'tools', 'standard']

/**
 * A failure is exempt from every fold, in every view.
 *
 * This is the one carve-out in Minimal, and it is not a preference: a failed
 * step folded behind "Used 3 tools" reads like success, so the reader is told
 * the opposite of what happened. Both transcripts already refuse this — the
 * settled-stack fold keeps `ensemble_yield` rows whole for the same reason
 * (`isTranscriptPriorityActivity`, `collapsedActivityStack.ts:47-53`), and iOS
 * states it outright in `TranscriptStackCollapse.swift:47-52`. A view that
 * hides work the user chose to hide is the feature; a view that hides an error
 * is a bug that looks like the feature.
 */
export function activityStackHasFailure(activities: readonly ToolActivity[]): boolean {
  return activities.some((activity) => activity.status === 'error')
}

/**
 * Whether a timeline segment renders at all.
 *
 * `hasFailure` is the caller's answer for the activities inside THIS segment,
 * not the whole stack — a failed shell command must not drag an unrelated
 * thinking viewport back onto the screen.
 */
export function transcriptViewRendersSegment(
  view: TranscriptView,
  kind: ActivityTimelineSegmentKind,
  hasFailure = false
): boolean {
  if (view === 'standard') return true
  if (hasFailure) return true
  if (kind === 'agent') return true
  if (view === 'tools') return kind !== 'thinking'
  return false
}

/**
 * Whether a fan-out lane's result viewport renders its body.
 *
 * Separate from the segment predicate because a lane card is not a timeline
 * segment: it is the only thing attributing a lane to its seat, so a failed
 * lane keeps its body even under Minimal while a succeeded one folds to the
 * one-liner like everything else.
 */
export function transcriptViewRendersFanoutViewport(
  view: TranscriptView,
  hasFailure = false
): boolean {
  return view !== 'minimal' || hasFailure
}

/**
 * Whether a collapsed one-liner can be opened.
 *
 * Minimal's one-liners are inert — not "collapsed by default". The row must
 * therefore render as a non-button with no `aria-expanded` at all, following
 * `ActivityStack.tsx:4146`: a control announced as expandable that does
 * nothing is worse for a screen reader than no control. A failure is exempt
 * from HIDING, not from this — its body is already on screen, so there is
 * nothing left for an expander to reveal.
 */
export function transcriptViewAllowsExpansion(view: TranscriptView): boolean {
  return view !== 'minimal'
}

/**
 * Whether this view folds a stack the transcript would otherwise leave open.
 *
 * Only Minimal does. The caller uses this to re-ask
 * `shouldAutoCollapseActivityStack` with `isLiveRow`/`isLastRow` cleared —
 * never to skip that predicate, whose other three refusals (an all-infrastructure
 * stack, a priority activity, and work still running inside a stack that has
 * something to show) still apply and each fixed a shipped bug.
 */
export function transcriptViewFoldsLiveStacks(view: TranscriptView): boolean {
  return view === 'minimal'
}
