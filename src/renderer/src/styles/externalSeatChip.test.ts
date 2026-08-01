import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string): string =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')

const STRIP = 'src/renderer/src/components/EnsembleParticipantsAboveRow.tsx'

/**
 * External human seats appear as chips holding a turn position among the AI
 * seats. Three things here fail SILENTLY if broken — no error, no warning,
 * nothing visible in review — so each is pinned.
 */
/** The whole external chip element, from its map opening to its close. */
function externalChipBlock(): string {
  const source = readSource(STRIP)
  const start = source.indexOf('externalSeatChips.map((seat) => {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n        })}', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('external seat chips', () => {
  it('never carries data-participant-id, or it poisons drag-reorder', () => {
    // `resolveReorderDropTarget` hit-tests on that attribute and falls back to
    // the NEAREST match by centre distance. An external carrying it would
    // swallow drops meant for the model seat beside it, and `handleReorder`
    // would then silently do nothing because the id resolves to -1 in the
    // participants array. The drag just dies with no feedback.
    const block = externalChipBlock()
    // The ATTRIBUTE form, not the bare substring — the element's own comment
    // names the attribute to explain why it is absent, and matching that would
    // be a false positive that survives until someone deletes the comment.
    expect(block).not.toContain('data-participant-id={')
    expect(block).toContain('data-seat-kind="external"')
  })

  it('is not selectable', () => {
    // Selection drives the composer's model, reasoning, fast-mode, approval and
    // tool-grant pickers. A null binding there does NOT disable them — it
    // retargets them to write chat-level state — so an external holding
    // selection would leave those controls live and silently editing the chat.
    const block = externalChipBlock()
    expect(block).not.toContain('onSelectParticipant')
    expect(block).not.toContain('onClick')
  })

  it('positions both kinds by the merged roster order', () => {
    // The model chips keep their own map; both kinds are placed with CSS
    // `order` instead. Without an explicit order on the MODEL chip they all
    // collapse to 0 and the external floats to the front of the strip.
    const source = readSource(STRIP)
    expect(source).toContain('style={{ order: turnOrder,')
    expect(source).toContain('const seatPosition = seatPositionById.get(seat.seatId)')
    expect(externalChipBlock()).toContain('order: seatPosition,')
    // Turn numbers come from the merged roster too, or a panel with an external
    // second would number its model seats 1, 2, 3 instead of 1, 3, 4.
    expect(source).toContain(
      'turnOrder={seatPositionById.get(participant.id) ?? participantIndex + 1}'
    )
  })

  it('spans both kinds from the merged seat count, or the strip collapses', () => {
    // The wrapped grid is 60 tracks and a chip with no `grid-column` takes ONE
    // of them. The class that turns the grid on is chosen from the MERGED seat
    // count, so the spans have to be too — computing them from `participants`
    // meant 5 models + 1 human wrapped with no spans at all and every chip,
    // models included, became a sliver.
    const source = readSource(STRIP)
    expect(source).toContain('computeEnsembleChipGridSpans(totalSeatCount)')
    // Indexed by merged seat POSITION — an interleaved external shifts every
    // later model's placement slot.
    expect(source).toContain(
      'gridSpan={chipGridSpans?.[(seatPositionById.get(participant.id) ?? participantIndex + 1) - 1]}'
    )
    // …and the external chip carries one of its own.
    expect(externalChipBlock()).toContain('gridColumn: `span ${chipGridSpans[seatPosition - 1]}`')
    // The control rail stacks on the same count, or it falls out of step with
    // the strip it exists to stay aligned with.
    expect(source).toContain("totalSeatCount >= ENSEMBLE_CHIPS_WRAP_THRESHOLD ? ' is-stacked' : ''")
  })

  it('counts externals toward the collapse floor', () => {
    const source = readSource(STRIP)
    expect(source).toContain('externalSeatChips.length')
  })

  it('derives seats from the share the composer already holds', () => {
    // No new IPC, and no App.tsx change — so neither Multiview pane-context
    // lane is touched and each pane resolves its own chat's share.
    const composer = readSource('src/renderer/src/components/Composer.tsx')
    expect(composer).toContain('externalSeatsForShare(humanCollaborationShare)')
    // Resolved from shared, never from main — see guard:architecture.
    expect(composer).toContain(
      "import { externalSeatsForShare } from '../../../shared/effectiveEnsembleRoster'"
    )
    expect(composer).toContain('externalSeats={externalSeatsForChat}')
  })
})
