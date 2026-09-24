import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const composerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/Composer.tsx'),
  'utf8'
)
const goalStart = composerSource.indexOf('className={`composer-goal-popover shell-')
const goalEnd = composerSource.indexOf('<ComposerPlanPopoverButton', goalStart)
const goalMarkup = composerSource.slice(goalStart, goalEnd)
const goalCss = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
  'utf8'
)

function occurrences(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length || 0
}

/** Body of the first top-level `selector { ... }` rule, without nesting. */
function ruleBlock(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start === -1) throw new Error(`missing rule: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  return css.slice(open + 1, close)
}

describe('composer goal button chrome', () => {
  it('uses shared compact PillButton variants for every goal action', () => {
    expect(goalStart).toBeGreaterThan(-1)
    expect(goalEnd).toBeGreaterThan(goalStart)
    expect(occurrences(goalMarkup, /<PillButton\b/g)).toBe(8)
    expect(occurrences(goalMarkup, /size="compact"/g)).toBe(8)
    expect(occurrences(goalMarkup, /variant="primary"/g)).toBe(2)
    expect(occurrences(goalMarkup, /variant="secondary"/g)).toBe(5)
    expect(occurrences(goalMarkup, /variant="danger"/g)).toBe(1)
    expect(goalMarkup).not.toContain('composer-goal-action')
  })

  it('keeps goal action layout without reviving bespoke button chrome', () => {
    expect(goalCss).toContain('.composer-goal-popover-actions')
    expect(goalCss).toMatch(
      /\.composer-goal-popover \.segmented-control-action--primary\s*\{[\s\S]*?var\(--accent\) 38%[\s\S]*?var\(--accent\) 10%[\s\S]*?var\(--accent\) 18%/
    )
    expect(goalCss).not.toMatch(/\.composer-goal-action(?:[\s.{:#]|$)/)
  })
})

// The goal and plan popovers were capped at 360px/400px, so a long goal or a
// 30-step plan was clipped inside a popover with acres of empty window above
// it. Both now grow with the viewport; these assertions keep a fixed px ceiling
// from creeping back in.
describe('composer goal and plan popover height', () => {
  it('lets the goal popover grow with the window instead of a fixed cap', () => {
    const block = ruleBlock(goalCss, '.composer-goal-popover')
    expect(block).toMatch(/max-height:\s*calc\(100vh - 96px\)/)
    expect(block).not.toMatch(/max-height:[^;]*\b360px\b/)
  })

  it('gives the goal draft textarea six rows of room', () => {
    expect(goalMarkup).toContain('rows={6}')
    const block = ruleBlock(goalCss, '.composer-goal-textarea')
    const minHeight = Number(/min-height:\s*(\d+)px/.exec(block)?.[1])
    expect(minHeight).toBeGreaterThanOrEqual(124)
    // The taller popover is wasted if the textarea keeps the old 180px ceiling.
    expect(block).toMatch(/max-height:\s*min\(360px, calc\(100vh - 260px\)\)/)
  })

  it('lets the plan popover grow with the window and scroll its lane list', () => {
    const popover = ruleBlock(goalCss, '.composer-plan-popover')
    expect(popover).toMatch(/max-height:\s*calc\(100vh - 96px\)/)
    expect(popover).not.toMatch(/max-height:[^;]*\b400px\b/)
    // Column layout is what makes the lane list, not the popover, the scroller.
    expect(popover).toMatch(/flex-direction:\s*column/)

    const lanes = ruleBlock(goalCss, '.composer-plan-lanes')
    expect(lanes).not.toMatch(/max-height:/)
    expect(lanes).toMatch(/min-height:\s*0/)
    expect(lanes).toMatch(/overflow-y:\s*auto/)
  })
})
