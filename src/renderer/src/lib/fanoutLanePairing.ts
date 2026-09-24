/**
 * fanoutLanePairing — which fan-out lane rows sit beside which.
 *
 * The `paired` value of the `fanoutLaneLayout` appearance setting lays
 * consecutive fan-out lane result rows N-across instead of one per line.
 * Placement itself is CSS (`.transcript-inner` becomes an `auto-fit` grid and
 * everything that is NOT a lane cell spans every column), so all this module
 * has to decide is which slot each lane row occupies.
 *
 * Three slots. They are NOT column indices — the grid auto-places, so the
 * browser decides columns — and that is the whole reason they generalise from
 * the two-across model they were minted for without a fourth value. Each
 * answers one yes/no question the two consumers actually ask:
 *
 *  - `lead`  — a cell with a SIBLING AFTER IT ON THE SAME GRID ROW. That
 *              sibling sits at the same `offsetTop`, so the transcript
 *              virtualiser's offsetTop-delta measurement legitimately reads
 *              ZERO for it and the grid row's height lands further along. Every
 *              other row type treats a zero delta as "this row has no layout
 *              box", so this slot is what tells the measurement pass that the
 *              zero is real. Get it wrong and the band is counted twice — the
 *              phantom bottom-spacer height that makes auto-follow lurch. At
 *              two tracks this is the LEFT cell of a pair, which is where the
 *              name comes from; at three it is the left and middle cells.
 *  - `trail` — the cell that CLOSES its grid row. Its delta is the whole band.
 *  - `solo`  — a lane with no neighbours to share a row with, which spans the
 *              full column rather than sitting 1/N wide beside an empty 1/N.
 *              Runs that do not divide by the track count are ordinary (three
 *              scouts, five workers), so this is the common case, not an edge
 *              one, and a lone narrow card with empty space next to it reads as
 *              a rendering fault rather than as a design.
 *
 * A group of k >= 2 cells that does not fill the row keeps its cells: a last
 * grid row that is partly empty is what every grid of cards looks like, and
 * turning those k cards into k full-width ones would throw away the
 * side-by-side reading the setting exists for. Only k === 1 spans. At two
 * tracks the two rules coincide exactly, which is what keeps Medium — where
 * the track count is always 2 — byte-identical to the two-across build.
 *
 * Pairing is per RUN of adjacent same-kind lane rows: anything else in the
 * transcript — a tool row, a round header, the Boss's synthesis, or a lane of
 * the other pairable kind — ends the run, and the next lane row starts a fresh
 * one at the left column. That keeps reading order honest: a pair is always two
 * lanes that were genuinely adjacent and the same kind (fan-out result with
 * fan-out result, sub-thread return with sub-thread return, or Fleet card with
 * Fleet card), never two that a scrolled-past row happened to bring together,
 * and never a heterogeneous couple. Fleet cards add one tighter condition:
 * both must carry the same calling runId, so unrelated adjacent waves never
 * pair. Wave ids never reorder the transcript for pairing.
 */
import type { ChatMessage, FanoutLaneLayout } from '../../../main/store/types'
import { buildTranscriptRowKeys } from './transcriptRowKey'
import { isEnsembleFanoutResultMessage } from '../../../shared/fanoutLaneGrouping'
import { isFleetWaveMessage } from '../components/FleetWaveCardModel'
import { isSubThreadReturnMessage } from '../components/SubThreadReturnCardModel'

export type FanoutLaneSlot = 'lead' | 'trail' | 'solo'

/** Pairable row kinds that may form a two-across run. Runs stay kind-homogeneous. */
type PairableLaneKind = 'fanoutResult' | 'subThreadReturn' | 'fleetWave'

/** DOM attribute the CSS grid rules and the measurement pass both read. */
export const FANOUT_LANE_SLOT_ATTRIBUTE = 'data-fanout-slot'

/**
 * The `dataset` property name for `FANOUT_LANE_SLOT_ATTRIBUTE`, DERIVED from it
 * rather than re-spelled, and the only thing that makes that constant the seam
 * it advertises: the measurement pass reads the slot through this, so a rename
 * of the attribute moves the reader with it instead of leaving a const that
 * typechecks and changes nothing on screen.
 */
export const FANOUT_LANE_SLOT_DATASET_KEY = FANOUT_LANE_SLOT_ATTRIBUTE.slice(
  'data-'.length
).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())

/**
 * The track count the two-across model was: the default for every caller that
 * has no epoch to derive one from, and the value Medium always resolves to.
 */
export const DEFAULT_FANOUT_LANE_TRACKS = 2

/** A slot that occupies ONE grid cell, as opposed to spanning the column. */
export function isFanoutLaneCellSlot(slot: string | null | undefined): boolean {
  return slot === 'lead' || slot === 'trail'
}

/**
 * Whether a pre-paint offsetTop delta is a real measurement of `slot`'s row.
 *
 * Pure, and extracted from the measurement effect, because that effect can
 * never be reached by a renderer test: the suites are `renderToStaticMarkup`
 * with no jsdom, so refs never attach and nothing ever has an `offsetTop`.
 *
 * A POSITIVE delta is always real. A ZERO delta is real only for a `lead` —
 * a row that a sibling FOLLOWS on the same grid row, so the next row's
 * `offsetTop` is this one's and the zero is the layout telling the truth.
 *
 * NOT for a `trail`. A trail CLOSES its grid row, so the next row starts a new
 * one and a real trail can never produce a zero here; a zero on a trail means
 * the row has no layout box at all (a hidden block, an element mid-unmount).
 * Recording it as a measured 0 replaces a usable estimate with a wrong
 * measurement. This rule is byte-identical to the one this seam shipped with
 * (`=== 'lead'`), and it is already correct at EVERY track count because
 * `lead` re-means "a sibling follows me on this grid row" rather than "left
 * cell of a pair" — at three across, ['lead','lead','trail'] with deltas
 * [0, 0, 400] admits all three, exactly as it must.
 *
 * Note what this does NOT read: the track count. "Is there a sibling after me
 * on this grid row" is a fact about the DOM, and the slot is the only honest
 * carrier of it — a column index would have to be compared against N, and a
 * group that spans the full width has column index 0 AND closes its row, so
 * `columnIndex < N - 1` would admit a zero for a row whose delta is real. The
 * predicate stays correct even when the derived track count and the count CSS
 * actually laid out disagree.
 */
export function admitsMeasuredRowDelta(delta: number, slot: string | null | undefined): boolean {
  if (delta > 0) return true
  return delta === 0 && slot === 'lead'
}

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
 * Classify every pairable lane/Fleet row in `messages` into its grid slot,
 * keyed by the transcript's own collision-proof row key (`${id}#${occurrence}`,
 * see `buildTranscriptRowKeys`) so
 * the render loop can look a row up without re-deriving its position. Rows
 * that are not pairable are absent from the map — callers stamp nothing on them
 * and they keep spanning the column.
 *
 * `tracks` is how many lane cards the column fits side by side, derived from
 * the transcript's layout epoch by `transcriptLayoutLaneTracks`. It defaults to
 * the two-across model this started as, which is also what Medium always
 * resolves to.
 *
 * A neighbour-sensitive SLOT is safe where a neighbour-sensitive ESTIMATE is
 * not: this whole map is rebuilt whenever the message list changes identity,
 * and the render signature re-renders any row whose slot moved, whereas
 * `projectRowsAfterSharedPrefix` bakes an estimate onto a row object and reuses
 * it by reference. That is why the slot may look at its run and the estimate
 * may not.
 *
 * Returns an empty map when `enabled` is false so the caller can hold one
 * unconditional `useMemo` rather than branching around it.
 */
export function classifyFanoutLaneSlots(
  messages: readonly ChatMessage[],
  enabled: boolean,
  tracks: number = DEFAULT_FANOUT_LANE_TRACKS
): ReadonlyMap<string, FanoutLaneSlot> {
  const slots = new Map<string, FanoutLaneSlot>()
  if (!enabled || !Array.isArray(messages) || messages.length === 0) return slots
  // One cell per row is the degenerate but ordinary case (a Narrow column, a
  // split Multiview pane): every lane spans, exactly as it renders. Guarding
  // here rather than trusting the caller keeps a corrupt or absent count from
  // making the group walk below stall or run backwards.
  const perRow = Number.isFinite(tracks)
    ? Math.max(1, Math.floor(tracks))
    : DEFAULT_FANOUT_LANE_TRACKS
  // Built in one forward walk, then indexed into: a row key carries how many
  // earlier rows shared its message id, which cannot be derived for a single
  // row in isolation. The render loop looks slots up by the SAME key, so this
  // must stay the shared builder.
  const rowKeys = buildTranscriptRowKeys(messages)
  const keyAt = (index: number): string => rowKeys[index]

  let index = 0
  while (index < messages.length) {
    const groupKey = pairableLaneGroupKey(messages[index])
    if (!groupKey) {
      index += 1
      continue
    }
    // Walk to the end of this run of adjacent same-kind lane rows, then group
    // off from its START in steps of `perRow`. Grouping from the start (rather
    // than from wherever we happen to be) is what keeps a run's slots stable as
    // later rows stream in: appending a lane can only ever change the slot of
    // the run's LAST row, at every track count. The completed groups before it
    // never move, and inside the growing last group an append only ever turns
    // the previous final cell from the one it was into a `lead` — a `solo`
    // becoming a `lead` when the group reaches two, or a `trail` becoming a
    // `lead` when it reaches three or more.
    // A different pairable kind ends the run rather than joining it — fan-out
    // results and sub-thread returns never share a grid row.
    let end = index + 1
    while (end < messages.length && pairableLaneGroupKey(messages[end]) === groupKey) end += 1
    for (let cursor = index; cursor < end; cursor += perRow) {
      const groupEnd = Math.min(cursor + perRow, end)
      if (groupEnd - cursor === 1) {
        slots.set(keyAt(cursor), 'solo')
        continue
      }
      for (let cell = cursor; cell < groupEnd - 1; cell += 1) slots.set(keyAt(cell), 'lead')
      slots.set(keyAt(groupEnd - 1), 'trail')
    }
    index = end
  }
  return slots
}

/**
 * Lane count at which a run of fan-out result rows drops to the compact
 * (half) collapsed band. Below this a round fits on screen at the full band;
 * at six-plus, full-band lanes mean the reader can see at most two rows of a
 * round at once even paired, so the whole run trades resting height for
 * overview. Applies to `fanoutResult` lanes only — sub-thread returns and
 * Fleet cards keep their own sizing.
 */
export const FANOUT_LANE_COMPACT_THRESHOLD = 6

/**
 * Row keys (`${id}#${occurrence}`, see `buildTranscriptRowKeys`) of every
 * fan-out result row that sits in a run of `FANOUT_LANE_COMPACT_THRESHOLD`-or-more
 * adjacent fan-out result rows.
 *
 * Adjacency is the same notion pairing uses: any other row kind ends the run,
 * so a "run" is exactly the block the reader sees as one round's lanes. The
 * threshold crossing is deliberately retroactive — when the sixth lane
 * streams in, the first five join the set too, so the whole block compacts
 * together rather than mixing bands mid-round. That flip re-renders the
 * earlier rows once via the `fanoutLaneCompact` render-signature field; the
 * virtualiser's height estimates are unaffected (they already under-estimate,
 * which is the safe direction).
 */
export function classifyCompactFanoutLaneRows(
  messages: readonly ChatMessage[]
): ReadonlySet<string> {
  const compact = new Set<string>()
  if (!Array.isArray(messages) || messages.length === 0) return compact
  const rowKeys = buildTranscriptRowKeys(messages)
  let index = 0
  while (index < messages.length) {
    if (!isEnsembleFanoutResultMessage(messages[index])) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < messages.length && isEnsembleFanoutResultMessage(messages[end])) end += 1
    if (end - index >= FANOUT_LANE_COMPACT_THRESHOLD) {
      for (let cursor = index; cursor < end; cursor += 1) {
        compact.add(rowKeys[cursor])
      }
    }
    index = end
  }
  return compact
}

function pairableLaneKind(message: ChatMessage | undefined): PairableLaneKind | null {
  if (!message) return null
  if (isEnsembleFanoutResultMessage(message)) return 'fanoutResult'
  if (isSubThreadReturnMessage(message)) return 'subThreadReturn'
  if (isFleetWaveMessage(message)) return 'fleetWave'
  return null
}

function pairableLaneGroupKey(message: ChatMessage | undefined): string | null {
  const kind = pairableLaneKind(message)
  if (!kind) return null
  // Fleet cards pair only when the same parent run called them together.
  // Historical cards without a run id stay full-width, and adjacent cards
  // from separate turns never snap together merely because they touch.
  if (kind === 'fleetWave') return message?.runId ? `${kind}:${message.runId}` : null
  return kind
}
