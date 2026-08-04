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

describe('pane-bottom timecode bar typography', () => {
  it('keeps the timecodes on the mono face while the PR/edits satellites share the SF Pro stack', () => {
    const css = readComposerCss()
    // The bar itself is timecode typography — mono, tabular. Owner call
    // 2026-08-05: "timecode is fine as-is".
    const bar = cssBlockStartingAt(css, '.composer-thread-timecodes {')
    expect(bar).toContain('font-family: var(--font-mono);')
    // The centre satellite cluster (GitHub PR/CI + active-edits pill) reads as
    // UI chrome, not timecode: both satellites share the app sans face
    // (--font-sans = the SF Pro stack). The lock pill's `font: inherit`
    // trigger picks this up, so one container rule covers both.
    const satellites = cssBlockStartingAt(css, '.composer-thread-timecode-satellites {')
    expect(satellites).toContain('font-family: var(--font-sans);')
  })
})
