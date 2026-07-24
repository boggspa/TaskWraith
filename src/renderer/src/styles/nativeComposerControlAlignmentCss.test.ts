import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readComposerCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('native composer control alignment CSS', () => {
  it('keeps context, voice, and send controls on one baseline during active rounds', () => {
    const css = readComposerCss()
    const pickerBlock = cssBlockStartingAt(
      css,
      '[data-composer-style="default"] .composer-inline-pickers {'
    )
    const actionBlock = cssBlockStartingAt(
      css,
      '[data-composer-style="default"] .composer-inline-actions {'
    )

    expect(pickerBlock).toContain('flex-wrap: nowrap')
    expect(actionBlock).toContain('width: auto')
    expect(actionBlock).toContain('order: 0')
    expect(css).not.toContain(
      '.composer-inline-pickers:has(.composer-inline-actions .stop-btn)'
    )
  })
})
