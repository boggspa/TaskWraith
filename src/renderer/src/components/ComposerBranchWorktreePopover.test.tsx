import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computeComposerBranchPopoverPosition } from './ComposerBranchWorktreePopover'

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('ComposerBranchWorktreePopover positioning', () => {
  it('matches the composer width and left edge', () => {
    expect(
      computeComposerBranchPopoverPosition(
        { left: 320, top: 620, bottom: 640 },
        { width: 1000, height: 800 },
        { width: 320, height: 300 },
        { left: 120, width: 760 }
      )
    ).toEqual({ left: 120, top: 612, width: 760, placement: 'above' })
  })

  it('clamps a wide composer to the viewport gutters', () => {
    const position = computeComposerBranchPopoverPosition(
      { left: 20, top: 200, bottom: 220 },
      { width: 600, height: 700 },
      { width: 320, height: 300 },
      { left: -40, width: 900 }
    )

    expect(position.left).toBe(8)
    expect(position.width).toBe(584)
  })

  it('allows the inline composer width without defining a new popover background', () => {
    const css = readFileSync(
      'src/renderer/src/components/ComposerBranchWorktreePopover.css',
      'utf8'
    )
    const popover = cssBlockStartingAt(
      css,
      '.composer-combined-picker-popover.composer-branch-popover {'
    )

    expect(popover).toContain('max-width: calc(100vw - 1rem)')
    expect(popover).toContain('box-sizing: border-box')
    expect(popover).not.toMatch(/\n\s*background\s*:/)
  })
})
