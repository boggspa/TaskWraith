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

  it('keeps the shared approval-modal eyebrow sentence case', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const eyebrow = cssBlockStartingAt(css, '.creative-approval-modal-eyebrow {')

    expect(eyebrow).not.toContain('text-transform')
    expect(eyebrow).not.toContain('0.12em')
  })

  it('keeps the provider-install subheads sentence case', () => {
    const css = readCss('08-theme-picker-overrides.css')
    const subhead = cssBlockStartingAt(css, '.provider-install-subhead {')

    expect(subhead).not.toContain('text-transform')
  })

  it('keeps the side-chat menu section header sentence case', () => {
    const css = readCss('11-side-chat.css')
    const section = cssBlockStartingAt(css, '.side-chat-layout-menu-section {')

    expect(section).not.toContain('text-transform')
    expect(section).not.toContain('0.08em')
  })

  /* The 2026-08 approval-modal redraft shed this surface's remaining caps-
   * spaced micro-labels (source badge, "Requested by", preview header). */
  it('keeps the approval source badge sentence case', () => {
    const css = readCss('03-composer-welcome-activity.css')
    const source = cssBlockStartingAt(css, '.composer-permission-source {')

    expect(source).not.toContain('text-transform')
    expect(source).not.toContain('letter-spacing')
  })

  it('keeps the approval attribution label sentence case', () => {
    const css = readCss('03-composer-welcome-activity.css')
    const label = cssBlockStartingAt(css, '.composer-permission-attribution-label {')

    expect(label).not.toContain('text-transform')
    expect(label).not.toContain('letter-spacing')
  })

  it('keeps the approval preview header sentence case', () => {
    const css = readCss('04-settings-controls.css')
    const header = cssBlockStartingAt(css, '.agent-approval-preview-header {')

    expect(header).not.toContain('text-transform')
    expect(header).not.toContain('letter-spacing')
  })
})
