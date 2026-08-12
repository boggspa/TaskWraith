import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE HAZARD THIS FILE GUARDS. The fleet density strip renders one mini
 * TaskWraith ghost per agent from the FULL monoline mark paths, which live in
 * a 128-unit viewBox (FleetWaveCard.tsx, FLEET_WAVE_GHOST_PATHS). Unitless
 * CSS `stroke-width` is USER SPACE, so its on-screen weight scales with the
 * viewBox: effective px = stroke-width × cellPx / viewBoxUnits.
 *
 * The strip shipped with `stroke-width: 1.25` — a value calibrated for a
 * 16-unit mini glyph — against the 128-unit paths. At the 13px cell that is
 * 1.25 × 13 / 128 ≈ 0.13px: every OUTLINE state (queued / working /
 * needs_approval) rendered invisibly, so a running fleet's strip read as
 * empty until agents settled, and the amber needs-approval cell never popped.
 * Filled states (completed / failed) masked the bug because fill ignores
 * stroke.
 *
 * Correct weights for the 128 viewBox at a 13px cell:
 *   base 12 → 12 × 13 / 128 ≈ 1.22px   (matches the intended 1.25px look)
 *   needs_approval 16 → ≈ 1.63px       (the deliberately heavier ask state)
 *
 * If the cell paths ever move to a different viewBox, these numbers must be
 * re-derived together — that is why this file pins BOTH sides of the
 * equation.
 */
const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/07-composer-shells.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const readCardTsx = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/components/FleetWaveCard.tsx'),
    'utf8'
  ).replace(/\r\n/g, '\n')

/** Comments carry the same class names as the rules; drop them before matching. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

const ruleBody = (css: string, selector: string): string => {
  const source = stripComments(css)
  const start = source.indexOf(`${selector} {`)
  expect(start, `selector "${selector}" present`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close)
}

describe('fleet ghost strip stroke scales with the 128-unit mark viewBox', () => {
  it('renders strip cells from the 128-unit monoline paths', () => {
    const tsx = readCardTsx()
    // Both the shared <symbol> and each cell <svg> declare the mark's own box.
    expect(tsx).toContain('viewBox="0 0 128 128"')
  })

  it('weights the base outline for the 128 viewBox (≈1.2px at the 13px cell)', () => {
    const body = ruleBody(readCss(), '.fleet-wave-card-cell')
    expect(body).toContain('width: 13px')
    expect(body).toContain('stroke-width: 12;')
  })

  it('keeps needs_approval visibly heavier than the base outline', () => {
    const body = ruleBody(readCss(), '.fleet-wave-card-cell.status-needs_approval')
    expect(body).toContain('stroke-width: 16;')
  })

  it('never regresses to a sub-viewBox hairline on any cell rule', () => {
    const source = stripComments(readCss())
    const cellRules = source.match(/\.fleet-wave-card-cell[^{]*\{[^}]*\}/g) || []
    expect(cellRules.length).toBeGreaterThanOrEqual(2)
    for (const rule of cellRules) {
      const stroke = rule.match(/stroke-width:\s*([\d.]+)/)
      if (stroke) {
        // Anything under 8 user units renders below ~0.8px at the 13px cell —
        // invisible territory. 12/16 sit comfortably above.
        expect(Number(stroke[1]), rule.split('{')[0].trim()).toBeGreaterThanOrEqual(8)
      }
    }
  })
})
