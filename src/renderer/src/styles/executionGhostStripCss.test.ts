import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * THE HAZARD THIS FILE GUARDS. The execution graph strip draws the same
 * 128-unit monoline mark as the fleet wave strip, at the same 20px cell, so it
 * needs the same user-space stroke weights (12 → ≈1.88px, 16 → 2.5px). It
 * cannot simply join `.fleet-wave-card-cell` in a grouped selector, because
 * `fleetWaveGhostStripCss.test.ts` matches that selector EXACTLY and grouping
 * would red the pin that stops the fleet strip regressing to a hairline.
 *
 * So the geometry is duplicated on purpose — and duplication that nothing
 * checks is duplication that drifts. This file asserts the two rule sets agree
 * on every number that matters, and that every status the TS model can emit
 * has somewhere to land.
 */
const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/07-composer-shells.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const readModel = (): string =>
  readFileSync(join(process.cwd(), 'src/shared/executionGraphGhost.ts'), 'utf8')

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

const declaration = (body: string, property: string): string | undefined =>
  body.match(new RegExp(`${property}:\\s*([^;]+);`))?.[1].trim()

describe('execution ghost strip matches the fleet strip it is derived from', () => {
  it('draws the base outline at the same weight and size as the fleet cell', () => {
    const css = readCss()
    const execution = ruleBody(css, '.execution-ghost-cell')
    const fleet = ruleBody(css, '.fleet-wave-card-cell')
    for (const property of ['width', 'height', 'stroke-width', 'stroke-linejoin', 'fill']) {
      expect(declaration(execution, property), property).toBe(declaration(fleet, property))
    }
    expect(execution).toContain('drop-shadow')
  })

  // The ask state is deliberately heavier than the base outline on both strips.
  it('keeps the ask state heavier, at the fleet strip’s weight', () => {
    const css = readCss()
    expect(
      declaration(ruleBody(css, '.execution-ghost-cell.status-needs_action'), 'stroke-width')
    ).toBe(declaration(ruleBody(css, '.fleet-wave-card-cell.status-needs_approval'), 'stroke-width'))
  })

  it('never regresses to a sub-viewBox hairline on any execution cell rule', () => {
    const source = stripComments(readCss())
    const rules = source.match(/\.execution-ghost-cell[^{]*\{[^}]*\}/g) || []
    expect(rules.length).toBeGreaterThanOrEqual(2)
    for (const rule of rules) {
      const stroke = rule.match(/stroke-width:\s*([\d.]+)/)
      if (stroke) {
        expect(Number(stroke[1]), rule.split('{')[0].trim()).toBeGreaterThanOrEqual(8)
      }
    }
  })

  // The TS union and the stylesheet are hand-maintained against each other and
  // neither compiles the other. Without this, a new status renders as the base
  // muted outline — indistinguishable from "proposed", so a failed or finished
  // step would read as one that never started.
  it('gives every status the model can emit a home in the stylesheet', () => {
    const union = readModel().match(
      /export type ExecutionGhostStatus =([\s\S]*?)\n\nexport interface/
    )?.[1]
    expect(union, 'ExecutionGhostStatus union found').toBeTruthy()
    const statuses = Array.from((union as string).matchAll(/'([a-z_]+)'/g), (m) => m[1]).sort()
    expect(statuses.length).toBeGreaterThan(0)

    const source = stripComments(readCss())
    const styled = new Set(
      Array.from(source.matchAll(/\.execution-ghost-cell\.status-([a-z_]+)/g), (m) => m[1])
    )
    // `proposed` is the documented exception: it IS the base rule, because the
    // strip's filled proportion is the progress read and an unstarted step must
    // stay the muted outline.
    styled.add('proposed')
    expect(statuses.filter((status) => !styled.has(status))).toEqual([])
  })
})
