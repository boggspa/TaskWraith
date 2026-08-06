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
 * Pairing is per RUN of adjacent lane rows: anything else in the transcript —
 * a tool row, a round header, the Boss's synthesis — ends the run, and the next
 * lane row starts a fresh one at the left column. That keeps reading order
 * honest: a pair is always two lanes that were genuinely adjacent, never two
 * that a scrolled-past row happened to bring together.
 */
import type { ChatMessage } from '../../../main/store/types'
import { isEnsembleFanoutResultMessage } from '../../../shared/fanoutLaneGrouping'

export type FanoutLaneSlot = 'lead' | 'trail' | 'solo'

/** DOM attribute the CSS grid rules and the measurement pass both read. */
export const FANOUT_LANE_SLOT_ATTRIBUTE = 'data-fanout-slot'

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
    if (!isLaneRow(messages[index])) {
      index += 1
      continue
    }
    // Walk to the end of this run of adjacent lane rows, then pair off from its
    // START. Pairing from the start (rather than from wherever we happen to be)
    // is what keeps a run's slots stable as later rows stream in: appending a
    // lane can only ever change the slot of the run's LAST row.
    let end = index
    while (end < messages.length && isLaneRow(messages[end])) end += 1
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

function isLaneRow(message: ChatMessage | undefined): boolean {
  return Boolean(message) && isEnsembleFanoutResultMessage(message as ChatMessage)
}
