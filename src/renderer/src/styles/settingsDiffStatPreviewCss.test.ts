import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/04-settings-controls.css'),
  'utf8'
)

function cssBlockStartingAt(selector: string): string {
  const start = css.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const close = css.indexOf('}', start)
  expect(close, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return css.slice(start, close + 1)
}

describe('Settings diff stat preview CSS', () => {
  it('puts a collapsed tool-call example beside the primary diff counts', () => {
    expect(cssBlockStartingAt('.settings-diff-stat-preview {')).toContain(
      "grid-template-areas: 'primary activity'"
    )
    expect(cssBlockStartingAt('.settings-diff-stat-preview-activity {')).toContain(
      'grid-area: activity'
    )
    expect(css).not.toContain('.settings-diff-stat-preview-use-case')
  })

  it('paints the example with the exact selected diff colors', () => {
    expect(cssBlockStartingAt('.settings-diff-stat-preview-activity-failed,')).toContain(
      'color: var(--settings-diff-stat-deletions)'
    )
    expect(cssBlockStartingAt('.settings-diff-stat-preview-activity-additions {')).toContain(
      'color: var(--settings-diff-stat-additions)'
    )
  })
})
