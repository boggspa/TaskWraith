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
    expect(rowSource).toContain('data-permission-value={view.presetId}')
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

describe('CharOdometer family contract', () => {
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
    expect(block).toContain('background: none !important')
    expect(block).toContain('border: 0 !important')
    expect(block).not.toContain('color:')
  })

  it('nulls the hop and width transitions under reduce-motion', () => {
    expect(cssSource).toContain(
      ':root[data-reduce-motion="true"] .seat-change-message.is-fresh .seat-change-row'
    )
    expect(cssSource).toContain(':root[data-reduce-motion="true"] .char-odometer__slot')
  })
})
