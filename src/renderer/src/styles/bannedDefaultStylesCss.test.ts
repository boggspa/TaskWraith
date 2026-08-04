import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(new URL(`../assets/css/${file}`, import.meta.url), 'utf8')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

/* Pins for banned default treatments: all-caps letter-spaced micro-labels and
 * edge-stripe inset callouts. If one of these fails, restyle the surface —
 * don't reintroduce the treatment. */
describe('banned default styles stay out of approval and menu chrome', () => {
  it('renders the elevation caution as a tinted panel without the edge stripe', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const caution = cssBlockStartingAt(css, '.approval-elevation-caution {')

    expect(caution).not.toContain('border-left')
    expect(caution).toContain('background:')
    expect(css).not.toContain('.trusted-session-modal .approval-elevation-caution')
  })

  it('keeps the side-chat menu section header sentence case', () => {
    const css = readCss('11-side-chat.css')
    const section = cssBlockStartingAt(css, '.side-chat-layout-menu-section {')

    expect(section).not.toContain('text-transform')
    expect(section).not.toContain('0.08em')
  })
})
