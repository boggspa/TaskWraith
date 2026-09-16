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
 *   minimal  — assistant messages and collapsed one-liners only. Thinking and
 *              tool-call viewports are gone and nothing expands. The one-liner
 *              still names the work and still updates as it lands; it just
 *              never unfolds.
 *
 * One deliberate exception to Minimal, recorded where it will be found: a
 * FAN-OUT LANE keeps its result body. The spec called for hiding it, but a
 * lane card has no one-liner of its own and a wave only gains one once it has
 * fully settled, so hiding it would leave an attribution header over empty
 * space on exactly the live waves Minimal is for. The tombstone further down
 * carries the full reasoning. A lane's own tool and thinking segments are
 * still gated like everyone else's — it is only the seat's ANSWER that stays.
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

/* `transcriptViewRendersFanoutViewport` used to live here, gating an
 * `EnsembleFanoutResultCard`'s result body. It is deleted rather than left
 * uncalled, because it encodes a design that was examined and REJECTED, and a
 * plausible-looking helper is how a rejected design gets shipped later by
 * someone who assumes it was merely unfinished.
 *
 * Why it was rejected: a fan-out wave only folds to its "Work · 4 lanes"
 * one-liner once every lane is terminal AND focus has moved to a later turn
 * (`shouldCollapseFanoutGroup`). On a LIVE wave — exactly the case Minimal
 * exists for — there is no header and no lane-level summary of any kind, so
 * hiding the body leaves an attribution header with nothing underneath it.
 * Minimal promises "unexpandable one-liners", not empty ones. Quietening a
 * fan-out wave therefore stays with the settled-wave fold that already exists.
 *
 * A lane's own tool and thinking segments are still gated: the card passes
 * `transcriptView` to its `ActivityStack` like every other site. It is only
 * the lane RESULT — the seat's answer — that no view removes. */

/**
 * Whether a view offers expand/collapse chrome on a relayed message body.
 *
 * Read the tombstone below before assuming this is the same mistake:
 * `transcriptViewAllowsExpansion` asked whether a view permits opening a
 * COLLAPSED row to reveal content that is otherwise not rendered, and that is
 * not a view's business — the answer is whether anything is there. This asks
 * something different and genuinely view-shaped: whether to render the Expand
 * control on a body that is ALREADY COMPLETE either way. Under Minimal the
 * chrome is dropped and the body renders in full, so nothing is concealed and
 * there is nothing to reveal. Losing content is what made the other helper a
 * trap; this one cannot lose any.
 */
export function transcriptViewOffersExpandChrome(view: TranscriptView): boolean {
  return view !== 'minimal'
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
