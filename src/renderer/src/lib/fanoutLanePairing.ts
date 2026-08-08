/**
 * fanoutLanePairing — which fan-out lane rows sit beside which.
 *
 * The `paired` value of the `fanoutLaneLayout` appearance setting lays
 * consecutive fan-out lane result rows two-across instead of one per line.
 * Placement itself is CSS (`.transcript-inner` becomes a two-column grid and
 * everything that is NOT a paired lane spans both columns), so all this module
 * has to decide is which slot each lane row occupies.
 *
 * Three slots, and the distinction between them is load-bearing in two places:
 *
 *  - `lead`  — the LEFT cell of a pair. Its sibling sits at the same
 *              `offsetTop`, so the transcript virtualiser's offsetTop-delta
 *              measurement legitimately reads ZERO for it and the whole pair's
 *              height lands on the `trail` row. Every other row type treats a
 *              zero delta as "this row has no layout box", so the lead slot is
 *              what tells the measurement pass that this particular zero is
 *              real. Get this wrong and the pair is counted twice — the phantom
 *              bottom-spacer height that makes auto-follow lurch.
 *  - `trail` — the RIGHT cell of a pair.
 *  - `solo`  — an unpaired lane, which spans the full column rather than
 *              sitting half-width beside a hole. Odd lane counts are ordinary
 *              (three scouts, five workers), so this is the common case, not an
 *              edge case, and a half-width card with empty space next to it
 *              reads as a rendering fault rather than as a design.
 *
 * Pairing is per RUN of adjacent same-kind lane rows: anything else in the
 * transcript — a tool row, a round header, the Boss's synthesis, or a lane of
 * the other pairable kind — ends the run, and the next lane row starts a fresh
 * one at the left column. That keeps reading order honest: a pair is always two
 * lanes that were genuinely adjacent and the same kind (fan-out result with
 * fan-out result, or sub-thread return with sub-thread return), never two that
 * a scrolled-past row happened to bring together, and never a heterogeneous
 * fan-out/return couple. Wave ids never reorder the transcript for pairing.
 */
import type { ChatMessage, FanoutLaneLayout } from '../../../main/store/types'
import { isEnsembleFanoutResultMessage } from '../../../shared/fanoutLaneGrouping'
import { isSubThreadReturnMessage } from '../components/SubThreadReturnCardModel'

export type FanoutLaneSlot = 'lead' | 'trail' | 'solo'

/** Pairable row kinds that may form a two-across run. Runs stay kind-homogeneous. */
type PairableLaneKind = 'fanoutResult' | 'subThreadReturn'

/** DOM attribute the CSS grid rules and the measurement pass both read. */
export const FANOUT_LANE_SLOT_ATTRIBUTE = 'data-fanout-slot'

/**
 * The layout a transcript uses when the user has not chosen one.
 *
 * Two-across, because a fan-out that the reader can only scroll through one
 * lane at a time has thrown away the thing it was run for. It shipped opt-in
 * (15aa51e37) and the control sits far enough down Appearance that in practice
 * nobody found it, so the honest default is the one that shows the work.
 *
 * Read it through `resolveFanoutLaneLayout` rather than comparing against
 * `'paired'` directly: every seam that hard-codes the other value keeps
 * serving the old layout without failing to compile or to render.
 */
export const DEFAULT_FANOUT_LANE_LAYOUT: FanoutLaneLayout = 'paired'

/**
 * Narrow a persisted (or absent) setting to a layout the DOM can carry.
 *
 * Absence is the COMMON case, not an edge one: the setting shipped optional, so
 * every upgraded install and every fresh one reaches here with `undefined`, and
 * that has to mean the default rather than the historical layout. An explicit
 * `'stacked'` is a choice and is honoured; anything else — a hand-edited file,
 * or a value from a build that grew a third layout — falls to the default,
 * because `:root[data-fanout-lane-layout]` is stamped unconditionally and a
 * value outside the set matches no rule at all.
 */
export function resolveFanoutLaneLayout(value: unknown): FanoutLaneLayout {
  return value === 'stacked' || value === 'paired' ? value : DEFAULT_FANOUT_LANE_LAYOUT
}

/**
 * Classify every fan-out lane row in `messages` into its two-across slot,
 * keyed by the transcript's own collision-proof row key (`${id}#${index}`) so
 * the render loop can look a row up without re-deriving its position. Rows
 * that are not fan-out lanes are absent from the map — callers stamp nothing on
 * them and they keep spanning the column.
 *
 * Returns an empty map when `enabled` is false so the caller can hold one
 * unconditional `useMemo` rather than branching around it.
 */
export function classifyFanoutLaneSlots(
  messages: readonly ChatMessage[],
  enabled: boolean
): ReadonlyMap<string, FanoutLaneSlot> {
  const slots = new Map<string, FanoutLaneSlot>()
  const keyAt = (index: number): string => `${messages[index].id}#${index}`
  if (!enabled || !Array.isArray(messages) || messages.length === 0) return slots

  let index = 0
  while (index < messages.length) {
    const kind = pairableLaneKind(messages[index])
    if (!kind) {
      index += 1
      continue
    }
    // Walk to the end of this run of adjacent same-kind lane rows, then pair
    // off from its START. Pairing from the start (rather than from wherever we
    // happen to be) is what keeps a run's slots stable as later rows stream in:
    // appending a lane can only ever change the slot of the run's LAST row.
    // A different pairable kind ends the run rather than joining it — fan-out
    // results and sub-thread returns never share a pair.
    let end = index + 1
    while (end < messages.length && pairableLaneKind(messages[end]) === kind) end += 1
    for (let cursor = index; cursor < end; cursor += 2) {
      if (cursor + 1 < end) {
        slots.set(keyAt(cursor), 'lead')
        slots.set(keyAt(cursor + 1), 'trail')
      } else {
        slots.set(keyAt(cursor), 'solo')
      }
    }
    index = end
  }
  return slots
}

function pairableLaneKind(message: ChatMessage | undefined): PairableLaneKind | null {
  if (!message) return null
  if (isEnsembleFanoutResultMessage(message)) return 'fanoutResult'
  if (isSubThreadReturnMessage(message)) return 'subThreadReturn'
  return null
}
