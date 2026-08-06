import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Source-region pins for the authoritative seat-change transcript row (no DOM
 * test env in this repo — these assert the load-bearing wiring a render test
 * would otherwise cover).
 */
const rowSource = readFileSync(new URL('./SeatChangeRow.tsx', import.meta.url), 'utf8')
const odometerSource = readFileSync(new URL('./CharOdometer.tsx', import.meta.url), 'utf8')
const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(
  new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
  'utf8'
)

describe('SeatChangeRow composer-parity contract', () => {
  it('renders both chips with the REAL composer trigger class plus the chrome strip', () => {
    // Owner spec: "use exact elements identical to in the composer". The row
    // must ride the real class so fonts/hues/tints apply verbatim — a copied
    // style block would drift.
    const occurrences =
      rowSource.split('"composer-combined-picker-trigger seat-change-chip"').length - 1
    expect(occurrences).toBe(2)
  })

  it('keeps the composer tint/hue seams: permission value, reasoning token, provider hue accent', () => {
    // `|| undefined` so an unknown tier emits no attribute at all — the
    // composer's tint rules key on the value, and an empty one is not a tier.
    expect(rowSource).toContain('data-permission-value={view.presetId || undefined}')
    expect(rowSource).toContain('data-selected-reasoning={view.reasoningToken}')
    expect(rowSource).toContain('data-composer-control="permission"')
    expect(rowSource).toContain('`var(--provider-${view.hue}-color, var(--accent))`')
  })

  it('renders the role right-aligned in the provider accent, with the #N seat number', () => {
    expect(rowSource).toContain('className="seat-change-role"')
    expect(rowSource).toContain('`var(--provider-${current.hue}-color, var(--accent))`')
    // Approval-modal vocabulary: "#N Role" (1-based roster order).
    expect(rowSource).toContain('`#${state.seatNumber} ${state.role}`')
  })

  it('gates freshness on the SHARED coalescing window, captured once at mount', () => {
    // Same constant main coalesces with — a magic number here would let the
    // renderer keep rolling rows main already tombstoned (or vice versa).
    expect(rowSource).toContain(
      "import { SEAT_CHANGE_COALESCE_WINDOW_MS } from '../../../shared/seatChange'"
    )
    expect(rowSource).toContain('useState(() =>')
    expect(rowSource).toContain('< SEAT_CHANGE_COALESCE_WINDOW_MS')
    // guard:architecture — the renderer must not value-import from main.
    expect(rowSource).not.toContain("from '../../../main/services")
  })

  it('always mounts on BEFORE, holds the 2 s pre-wait, then rolls; expands to a static "was" line', () => {
    // Owner call 2026-08-05: the roll replays on every mount (scroll-back and
    // virtualisation remounts included) after a 2 s read-the-old-seat wait.
    expect(rowSource).toContain("useState<'before' | 'after'>('before')")
    expect(rowSource).toContain("setPhase('after'), 2000")
    expect(rowSource).toContain('className="seat-change-was"')
    expect(rowSource).toContain('<SeatClusterChip view={before} animate={false} />')
  })
})

describe('brief-only seat changes say so', () => {
  it('trails the after side with the note, ahead of the timestamp', () => {
    // Every other seat field has a chip; the brief has none, so a brief-only
    // edit rolled a row whose two sides were identical. Owner call 2026-08-06:
    // the note lands at the right end of the AFTER row, with the timestamp
    // staying the row's last element as it is on every other transcript row.
    const start = rowSource.indexOf('function SeatStrip(')
    const region = rowSource.slice(start, rowSource.indexOf('export function seatAccentVar'))
    expect(region).toContain('className="seat-change-brief-note"')
    expect(region).toContain('(Brief updated)')
    const note = region.indexOf('className="seat-change-brief-note"')
    expect(note).toBeGreaterThan(region.indexOf('{inline ? null : role}'))
    expect(note).toBeLessThan(region.indexOf('className="seat-change-time"'))
  })

  it('shows it WITH the after state, never during the before pre-wait', () => {
    // The row opens on the before seat for 2 s. A note that is already there
    // describes a change that, at that instant, has not been shown yet — and on
    // a brief-only change it is the ONLY thing that moves, so it is the roll.
    const start = rowSource.indexOf('function SeatStrip(')
    const region = rowSource.slice(start, rowSource.indexOf('export function seatAccentVar'))
    expect(region).toContain("briefUpdated && phase === 'after'")
  })

  it('reads the flag off the payload, so a close-out cell can never claim one', () => {
    // SeatStrip is shared with the close-out table, which feeds it a
    // SeatChangeLink. A link has no brief field — the `in` check is what keeps
    // an unrelated truthy key from turning a RECORD into a change claim.
    expect(rowSource).toContain("'briefUpdated' in seatChange")
  })

  it('styles the note as row chrome, not as a chip', () => {
    // Owner: "the same tool call font/style" — it rides the row's own trailing
    // treatment beside the timestamp. A chip would read as a seat VALUE, and
    // there is no brief value here to show.
    const start = cssSource.indexOf('.seat-change-brief-note {')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = cssSource.slice(start, cssSource.indexOf('}', start))
    expect(block).toContain('var(--font-size-xs)')
    expect(block).not.toContain('background:')
    expect(block).not.toContain('border:')
  })
})

describe('CharOdometer family contract', () => {
  it('omits the permission chip when the tier is unknown, rather than claiming default', () => {
    // An absent preset is not the default preset. Rows predating the seat
    // snapshot carry provider/model/role but no tier; defaulting there would
    // have the chip assert "Accept Edits" for a lane that may have run
    // read-only.
    expect(rowSource).toContain("const presetId = state.permissionPresetId || ''")
    expect(rowSource).toContain('if (!view.tierLabel && !view.grantsLabel) return null')
    expect(rowSource).not.toContain("state.permissionPresetId || 'default'")
  })

  it('collapses a slot the new text does not reach, instead of leaving it undefined', () => {
    // Rolling "Extra High" -> "Max" leaves 7 slots with an empty target. An
    // undefined width falls back to `width: auto`, and their content is still
    // the OUTGOING character sitting in the roll frame above — so the box kept
    // the width of letters nobody can see (measured: an 85px box to show
    // "Max", 55px of it dead). Zero is what makes a rolled row the same width
    // as a freshly rendered one.
    expect(odometerSource).toContain('if (!char) return 0')
    // The empty check must NOT be folded back into the font guard, which is
    // where it was and what returned undefined.
    expect(odometerSource).not.toContain('if (!char || !font')
  })

  it('reuses the digit-odometer CSS family verbatim', () => {
    expect(odometerSource).toContain('"digit-odometer__visual"')
    expect(odometerSource).toContain('digit-odometer__slot char-odometer__slot')
    expect(odometerSource).toContain("'--digit-odometer-target'")
    expect(odometerSource).toContain('is-rolling')
  })
})

describe('TranscriptPanel seat-change wiring', () => {
  it('excludes seat-change rows from the system one-liner sweep', () => {
    // The row collapses with its ROUND, but must never fold into
    // "System · N system notices" (owner spec, hierarchy rule 1).
    const start = panelSource.indexOf('function plainSystemNoticeMessage(')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = panelSource.indexOf('function superGroupParticipantKey(', start)
    expect(end).toBeGreaterThan(start)
    expect(panelSource.slice(start, end)).toContain('!msg.metadata?.seatChange &&')
  })

  it('dispatches seat-change messages to SeatChangeRow before the collapse branch', () => {
    const dispatch = panelSource.indexOf('msg.metadata?.seatChange ? (')
    expect(dispatch).toBeGreaterThanOrEqual(0)
    // The collapse branch must be the ternary arm AFTER the dispatch — a
    // seat-change message must reach SeatChangeRow, not CollapsedTranscriptRow.
    const collapseAfterDispatch = panelSource.indexOf('systemAutoCollapsible ? (', dispatch)
    expect(collapseAfterDispatch).toBeGreaterThan(dispatch)
    const between = panelSource.slice(dispatch, collapseAfterDispatch)
    expect(between).toContain('<SeatChangeRow key={msg.id} message={msg} />')
  })
})

describe('seat-change chrome strip CSS', () => {
  it('strips only box chrome — never text color, so composer tints keep flowing', () => {
    const start = cssSource.indexOf('.composer-combined-picker-trigger.seat-change-chip {')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = cssSource.indexOf('}', start)
    const block = cssSource.slice(start, end)
    // Composer parity includes SPACING — and it has to WIN. The composer shell
    // overrides use `!important`: `[data-composer-style="claude"]` sets
    // `gap: 0 !important` (right for its own chip, which separates segments
    // with nbsp text), which collapsed the provider and model into one word for
    // everyone on that shell. This strip lives in the transcript; its
    // appearance must not follow the composer shell.
    expect(block).toContain('gap: 9px !important')
    expect(block).toContain('background: none !important')
    expect(block).toContain('border: 0 !important')
    expect(block).not.toContain('color:')
  })

  it('repaints the shimmer for EVERY swept reasoning tier, at cell level', () => {
    // `background-clip: text` on the suffix span cannot composite through the
    // odometer's clipped, translated cells — the label renders as an invisible
    // gap. Any tier the composer sweeps must therefore be repainted on the
    // CELLS; a tier present in the composer rules but missing here is a
    // silently blank reasoning label (xhigh was exactly that).
    const sweptTiers = new Set(
      [...cssSource.matchAll(
        /\.composer-combined-picker-trigger\[data-selected-reasoning="([a-z]+)"\]\s*\n\s*\.composer-combined-picker-trigger-suffix[^{]*\{([^}]*)\}/g
      )]
        .filter(([, , body]) => body.includes('background-clip'))
        .map(([, tier]) => tier)
    )
    const repainted = new Set(
      [...cssSource.matchAll(
        /\.composer-combined-picker-trigger\.seat-change-chip\[data-selected-reasoning="([a-z]+)"\]\s*\n\s*\.composer-combined-picker-trigger-suffix\s*\n\s*\.digit-odometer__cell/g
      )].map(([, tier]) => tier)
    )
    expect(sweptTiers.size).toBeGreaterThan(0)
    for (const tier of sweptTiers) expect(repainted).toContain(tier)
  })

  it('nulls the hop and width transitions under reduce-motion', () => {
    expect(cssSource).toContain(
      ':root[data-reduce-motion="true"] .seat-change-message.is-fresh .seat-change-row'
    )
    expect(cssSource).toContain(':root[data-reduce-motion="true"] .char-odometer__slot')
  })
})

describe('close-out table reuses the seat element', () => {
  const closeoutSource = readFileSync(
    new URL('../lib/taskWraithCloseoutMessage.ts', import.meta.url),
    'utf8'
  )
  const markdownSource = readFileSync(
    new URL('./StableMarkdownBlock.tsx', import.meta.url),
    'utf8'
  )

  it('drops the chair glyph in the table but keeps it in the transcript', () => {
    // The chair marks a seat CHANGE. Every close-out row is a seat, so there it
    // says nothing per-row and only costs the left edge the #N and role occupy.
    expect(rowSource).toContain('{inline ? null : (')
    const start = rowSource.indexOf('function SeatStrip(')
    const region = rowSource.slice(start, rowSource.indexOf('export function seatAccentVar'))
    expect(region).toContain('<SeatChairIcon />')
    expect(region.indexOf('{inline ? null : (')).toBeLessThan(region.indexOf('<SeatChairIcon />'))
  })

  it('renders the inline strip from the link, with no timestamp and no expand button', () => {
    expect(rowSource).toContain('export function SeatChangeInlineStrip')
    // Spans only — a `<div>` is invalid inside the `<td>` this lands in.
    expect(rowSource).toContain('<span className="seat-change-message is-inline">')
    const start = rowSource.indexOf('export function SeatChangeInlineStrip')
    const region = rowSource.slice(start, rowSource.indexOf('export function SeatChangeRow'))
    expect(region).not.toContain('<button')
    expect(region).not.toContain('onClick')
  })

  it('leads with the role in the table and trails with it in the transcript', () => {
    // A table is read down its first column, so the seat's name is what the
    // eye must land on; a transcript row is read along its length and is
    // already anchored by the chair glyph. Ordered by DOM position, never by
    // flex `order` — reading order and visual order must not disagree.
    const start = rowSource.indexOf('function SeatStrip(')
    const region = rowSource.slice(start, rowSource.indexOf('export function seatAccentVar'))
    const leading = region.indexOf('{inline ? role : null}')
    const cluster = region.indexOf('<SeatClusterChip')
    const trailing = region.indexOf('{inline ? null : role}')
    expect(leading).toBeGreaterThanOrEqual(0)
    expect(cluster).toBeGreaterThan(leading)
    expect(trailing).toBeGreaterThan(cluster)
    expect(region).not.toContain('order:')
  })

  it('both surfaces share one strip, so the chips can never drift apart', () => {
    expect(rowSource).toContain('function SeatStrip(')
    expect(rowSource.split('<SeatStrip ').length - 1).toBe(2)
  })

  it('markdown intercepts the seat and status schemes, and the sanitizer allows them', () => {
    expect(markdownSource).toContain('decodeSeatChangeLink(href)')
    expect(markdownSource).toContain('<SeatChangeInlineStrip link={link} />')
    expect(markdownSource).toContain("'ensemble-seat'")
    // Status rides the work cell, drawn with the roster chip's OWN icon and
    // colour class so the two surfaces cannot drift into lookalikes.
    expect(markdownSource).toContain("'ensemble-status'")
    expect(markdownSource).toContain('<EnsembleStatusGlyph status={status} />')
    expect(markdownSource).toContain('`ensemble-above-chip-status status-${slug}')
    expect(markdownSource).toContain(
      "import { ParticipantStatusIcon } from './icons/ParticipantStatusIcon'"
    )
    // urlTransform strips unknown schemes before `components.a` ever sees the
    // href — both new schemes must be listed there too, not just in the
    // sanitizer, or the cells render as inert text.
    const transformStart = markdownSource.indexOf('function markdownUrlTransform')
    const transform = markdownSource.slice(transformStart, transformStart + 400)
    expect(transform).toContain('SEAT_CHANGE_LINK_PREFIX')
  })

  it('collapses five seat columns into one and merges turns with tokens', () => {
    expect(closeoutSource).toContain("'| Seat | Turns & Tokens |'")
    expect(closeoutSource).not.toContain('✅')
    expect(closeoutSource).toContain("`${turns} ${turns === 1 ? 'Turn' : 'Turns'}`")
    expect(closeoutSource).toContain('Tks`')
  })

  it('derives the element sides and the link text from ONE compaction', () => {
    // The href and the link text beside it are two renderings of the same row.
    // Deriving them separately is how they drift (a turn that captured no
    // permission preset reading as a tier change the text never showed).
    expect(closeoutSource).toContain('function seatFieldSequence<T>(')
    const start = closeoutSource.indexOf('function participantSeatChangeLink(')
    const region = closeoutSource.slice(start, start + 900)
    expect(region).toContain("fields.provider[which]")
    expect(region).toContain("fields.model[which]")
    expect(region).toContain('fields.permission[which]')
  })
})

describe('SeatStateChips — a seat as a state, for third-party hosts', () => {
  it('omits the chair glyph, the roll, and the role', () => {
    const start = rowSource.indexOf('export function SeatStateChips')
    expect(start).toBeGreaterThanOrEqual(0)
    const region = rowSource.slice(start, rowSource.indexOf('export function SeatChangeInlineStrip'))
    // The chair glyph CLAIMS a seat was reconfigured — rendering it where
    // nothing changed asserts something false to a reader who has learned it.
    expect(region).not.toContain('SeatChairIcon')
    expect(region).not.toContain('seat-change-role')
    // Static: no odometer slots to measure when every slot would be unchanged.
    expect(region).toContain('animate={false}')
    expect(region).not.toContain('animate />')
  })

  it('still rides the composer chips, so tints and hues match the change variants', () => {
    const start = rowSource.indexOf('export function SeatStateChips')
    const region = rowSource.slice(start, rowSource.indexOf('export function SeatChangeInlineStrip'))
    expect(region).toContain('<SeatClusterChip')
    expect(region).toContain('<SeatPermissionChip')
  })

  it('exports the resolved accent so a host tinting its own role cannot drift', () => {
    expect(rowSource).toContain('export function seatAccentVar')
    expect(rowSource).toContain('`var(--provider-${seatSideView(seat).hue}-color, var(--accent))`')
  })

  it('gives the wrapper layout only — the chips carry their own chrome strip', () => {
    const start = cssSource.indexOf('.seat-state-chips {')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = cssSource.slice(start, cssSource.indexOf('}', start))
    expect(block).toContain('inline-flex')
    // No composer ancestor required, and no colour: both would fight the chips.
    expect(block).not.toContain('color:')
  })
})
