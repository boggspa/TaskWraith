import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readMultiviewCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css/14-multiview.css'), 'utf8')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('Multiview shared-surface CSS', () => {
  it('sets the composer cap on the actual pane root', () => {
    const css = readMultiviewCss()
    const paneRootBlock = cssBlockStartingAt(css, '.multiview-pane-transcript {')

    expect(paneRootBlock).toContain(
      '--composer-content-max-width: min(850px, calc(100% - 28px))'
    )
  })

  it('does not retain selectors from the removed hand-written pane composer', () => {
    const css = readMultiviewCss()
    const removedSelectors = [
      '.multiview-pane-composer-area',
      '.multiview-pane-composer',
      '.multiview-pane-bottom-controls',
      '.multiview-pane-textarea',
      '.multiview-pane-inline-pickers',
      '.multiview-pane-inline-actions',
      '.multiview-pane-telemetry-row',
      '.multiview-pane-welcome-spacer'
    ]

    for (const selector of removedSelectors) expect(css).not.toContain(selector)
  })
})
