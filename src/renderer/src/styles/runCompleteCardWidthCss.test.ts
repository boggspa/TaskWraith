import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

/*
 * Close-out Task Complete mounts `.run-complete-card` under `.message-group`,
 * which is `align-items: flex-start`. Without an explicit stretch, the card
 * shrink-wraps to content and sits short of the transcript column — often
 * after a brief full-width paint while the footer lane still hosts it.
 * Same class of fix as `.run-complete-epic-stack` (align-self: stretch).
 */
describe('run-complete-card transcript width CSS', () => {
  it('stretches .run-complete-card so close-out mounts stay full column width', () => {
    const css = readCss('04-settings-controls.css')
    const card = cssBlockStartingAt(css, '.run-complete-card {')
    expect(card).toContain('align-self: stretch')
    expect(card).toMatch(/width:\s*100%/)
  })

  it('keeps the epic-stack stretch that already covered the nested tombstone lane', () => {
    const css = readCss('04-settings-controls.css')
    const stack = cssBlockStartingAt(css, '.run-complete-epic-stack {')
    expect(stack).toContain('align-self: stretch')
  })

  it('keeps .message-group on flex-start so ordinary bubbles still shrink-wrap', () => {
    const css = readCss('02-transcript-messages-fx.css')
    const group = cssBlockStartingAt(css, '.message-group {')
    expect(group).toContain('align-items: flex-start')
  })
})
