import type { ToolActivity } from '../../../main/store/types'
import { resolveCanonicalToolName } from '../../../shared/canonicalToolCoalesce'
import type { ActivityTimelineSegmentKind } from '../components/ActivityStack'
import type { VirtualRowType } from './TranscriptVirtualWindow'
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
 * (`isTranscriptPriorityActivity`, defined a few lines below in THIS file —
 * ac32daa78 moved it here from `collapsedActivityStack` so the fold and the
 * segment filter read one fact), and iOS
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
 * Every transcript row type, and whether any view gates it.
 *
 * This table exists because at these sites CORRECT and UNFINISHED are
 * byte-identical. Four row types render with no view prop, and that is a
 * DECISION — but an absence of code cannot say so, and one of them looks
 * actively like an oversight: `SubThreadDelegationCard` mounts with no view
 * prop ten lines above `SubThreadReturnCard transcriptView={transcriptView}`,
 * inside the same ternary. Without this table a later pass "finishes" that
 * asymmetry and silently deletes rows.
 *
 * It is keyed on the full `VirtualRowType` union and pinned against it, so a
 * fourteenth row type cannot be added without recording an answer here.
 *
 * `gated` means some view removes or folds the row's content. `kept` means
 * every view renders it identically. The line between them is that Minimal
 * names exactly three surfaces — thinking viewports, tool-call viewports and
 * fan-out viewports — and all three are `ActivityStack`-shaped. A row that
 * mounts no ActivityStack mounts none of them.
 *
 * MINIMAL IS A TURN-CONTENT VIEW, NOT A ROW-COUNT VIEW. It quietens what an
 * agent DID; it does not thin what was SAID or by whom. Under Minimal a busy
 * ensemble thread still shows its round headers, health cards and one
 * delegation plus one return card per lane. That weight is intended, and it is
 * the reason every `kept` below is a `kept`.
 */
export const TRANSCRIPT_ROW_VIEW_GATING: Record<VirtualRowType, 'gated' | 'kept'> = {
  // Plain conversation. Never had anything to gate.
  user: 'kept',
  assistant: 'kept',
  threadMessage: 'kept',
  // The three surfaces the feature exists for, plus the rows that embed them.
  tool: 'gated',
  fanoutResult: 'gated',
  return: 'gated',
  // Never fold a failure, in any view.
  system: 'kept',
  error: 'kept',
  // The four examined individually below.
  participantHealth: 'kept',
  delegation: 'kept',
  guestReply: 'kept',
  collaborator: 'kept'
}

/* WHY THE FOUR UNGATED ROWS ARE UNGATED. Each was read on its own merits, not
 * lumped, and each failed the test for folding independently. None of them has
 * a collapsed form anywhere in the tree, so a gate would DELETE the row rather
 * than fold it — the same defect the fan-out tombstone above records.
 *
 * participantHealth — when a seat goes unreachable, `markParticipantUnreachable`
 *   is a pure round-state mutation that creates no run and no message, so this
 *   card is the ONLY transcript record that it happened. It is also already
 *   exempt from system-notice compaction beside `providerRunFailure`, so the
 *   repo ruled it preserved once already. Its all-OK state is kept too, by
 *   explicit decision: a gate would make its absence ambiguous between "no
 *   probe ran", "all fine" and "the view ate it". It is written once per NEW
 *   PROMPT and never on a steer — the probe is gated on `!options.skipPreamble`
 *   and steering-boundary passes set that flag.
 *
 * delegation — the outbound half of the pair whose inbound half (the return
 *   card body) is deliberately kept. The pairing is asymmetric in the direction
 *   that matters: a `returnResult: false` child produces a delegation card and
 *   NO return card ever, and a child that fails to dispatch leaves its error
 *   only here. Folding it yields a transcript showing answers to questions it
 *   does not show.
 *
 * guestReply — a peer agent's final assistant message relayed verbatim: the
 *   same object class as the return-card body, with strictly less machinery
 *   since it has no chrome to drop. The remote projector already classifies it
 *   first-class participant conversation. It renders through the literal
 *   assistant branch, so gating it means carving content back out of the one
 *   branch Minimal exists to preserve.
 *
 * collaborator — a named person's typed words, the only transcript content no
 *   model ever reads. The row also carries the "Insert as draft" promote
 *   control and the "Out of position" badge that appears on no other surface,
 *   so hiding it severs a capability and conceals a degraded round.
 *
 * Note KEEP-BUT-INERT was unavailable for all four rather than rejected:
 * `transcriptViewOffersExpandChrome` needs expand chrome to remove, and none of
 * them has any. The controls they do carry are navigation and actions, not
 * disclosure — "nothing expands" must not be read as "no buttons". */

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
