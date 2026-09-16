import type { ToolActivity } from '../../../main/store/types'
import { resolveCanonicalToolName } from '../../../shared/canonicalToolCoalesce'
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

/** Lifecycle-routing actions have the same transcript standing as seat and
 * handoff-turn changes. Their full attributed row is conversation structure,
 * not tool noise, so no settled-stack or super-group fold may hide it behind
 * a generic "Used N tools" summary.
 *
 * It lives HERE, next to the failure twin, because the fold and the segment
 * filter must read one fact. They used to read two, and that is exactly why
 * the carve-out protecting a yield from being FOLDED was what got it DELETED:
 * the fold refused it, so it fell through to the full stack, where the filter
 * dropped it as ordinary tool noise and the row rendered nothing at all. */
export function isTranscriptPriorityActivity(activity: ToolActivity): boolean {
  return resolveCanonicalToolName(activity.toolName || '') === 'ensemble_yield'
}

export function activityStackHasPriorityActivity(activities: readonly ToolActivity[]): boolean {
  return activities.some(isTranscriptPriorityActivity)
}

/**
 * Whether a timeline segment renders at all.
 *
 * `hasFailure` and `hasPriorityActivity` are the caller's answers for the
 * activities inside THIS segment, not the whole stack — a failed shell command
 * must not drag an unrelated thinking viewport back onto the screen.
 *
 * A priority activity is exempt for the same reason a failure is: it is
 * conversation structure, and the fold already refuses to swallow it. Without
 * the exemption here the two protections cancel out and the row disappears.
 */
export function transcriptViewRendersSegment(
  view: TranscriptView,
  kind: ActivityTimelineSegmentKind,
  hasFailure = false,
  hasPriorityActivity = false
): boolean {
  if (view === 'standard') return true
  if (hasFailure || hasPriorityActivity) return true
  if (kind === 'agent') return true
  if (view === 'tools') return kind !== 'thinking'
  return false
}

/**
 * The shape both of ActivityStack's render trees agree on.
 *
 * Structural rather than the concrete `ActivityTimelineSegment` so these stay
 * pure functions a test can call with a literal, in a suite that has no DOM.
 */
interface FoldableSegment<TItem> {
  kind: ActivityTimelineSegmentKind
  items: TItem[]
  activities: readonly ToolActivity[]
}

/**
 * The segments a view renders, filtered once for BOTH of ActivityStack's
 * render trees.
 *
 * ActivityStack renders two independent trees — a per-segment one when the
 * live activity viewport is on, and a flat per-ITEM one when it is off, which
 * is also the only tree `SubThreadReturnCard` ever reaches because it does not
 * pass `liveActivityViewport` at all. Filtering each tree separately is how
 * this feature ships half-working: the same transcript would hide different
 * things depending on an unrelated setting. So the filter runs once, on
 * segments, and the item tree consumes the survivors through
 * `visibleTimelineItems` below.
 *
 * `standard` returns the input array by reference, so the default install
 * renders through today's exact code path with no copy.
 */
export function visibleTimelineSegments<TItem, S extends FoldableSegment<TItem>>(
  segments: S[],
  view: TranscriptView
): S[] {
  if (view === 'standard') return segments
  return segments.filter((segment) =>
    transcriptViewRendersSegment(
      view,
      segment.kind,
      activityStackHasFailure(segment.activities),
      activityStackHasPriorityActivity(segment.activities)
    )
  )
}

/**
 * The timeline items a view renders, taken from the already-filtered segments
 * so the flat tree cannot disagree with the segmented one.
 */
export function visibleTimelineItems<TItem, S extends FoldableSegment<TItem>>(
  segments: S[],
  view: TranscriptView,
  allItems: TItem[]
): TItem[] {
  if (view === 'standard') return allItems
  return visibleTimelineSegments(segments, view).flatMap((segment) => segment.items)
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

/* `transcriptViewAllowsExpansion` used to live here. It was deleted, not
 * moved: a helper named "does this VIEW allow expansion" is a trap, because
 * views do not decide that. A row is expandable iff OPENING IT WOULD SHOW
 * SOMETHING — see `activityStackHasVisibleContent` in `components/ActivityStack`.
 * Asking the view instead produced two shipped defects: a thinking-only stack
 * under Tools folded to a one-liner that opened onto nothing, and a settled
 * sub-agent spawn wave under Minimal became unreachable even though its
 * segment survives the filter by design. */

/**
 * Whether this view folds a stack the transcript would otherwise leave open.
 *
 * Only Minimal does, and it clears TWO of `shouldAutoCollapseActivityStack`'s
 * four refusals, not one. Clearing `isLiveRow`/`isLastRow` alone provably does
 * nothing for a running stack — the liveness refusal is evaluated afterwards
 * and unconditionally — so Minimal would fold nothing in exactly the case it
 * exists for. The all-infrastructure and priority-activity refusals are kept.
 *
 * Read it through `shouldAutoCollapseActivityStackForView` in
 * `collapsedActivityStack`, which owns that arithmetic; this predicate only
 * answers whether the view asks for it at all.
 */
export function transcriptViewFoldsLiveStacks(view: TranscriptView): boolean {
  return view === 'minimal'
}
