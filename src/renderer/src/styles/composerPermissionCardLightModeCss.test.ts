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

const LIGHT_NOT_CHAIN = ':not([data-theme="light"]):not([data-theme="mist"]):not([data-theme="sage"])'

/*
 * The codex/claude composer shells paint the approval + discovery cards
 * charcoal (#151515) as part of their dark chrome. That treatment MUST be
 * scoped to dark themes: the cards' light-theme treatments live in
 * 03-composer-welcome-activity.css / 04-settings-controls.css, which load
 * BEFORE 07-composer-shells.css, so an unscoped (0,2,0) shell rule wins the
 * specificity tie on source order and turns the approval card into a
 * dark-on-dark modal in light mode (its text vars resolve dark, and the
 * translucent countdown / note-field / button fills composite against the
 * forced near-black surface). run-complete-card does NOT need this scoping
 * because its light overrides live in 08-theme-picker-overrides.css, which
 * loads after 07 and wins the tie the other way.
 */
describe('composer approval/discovery card light-mode CSS', () => {
  it('scopes the codex/claude shell charcoal card fill to dark themes only', () => {
    const css = readCss('07-composer-shells.css')
    for (const shell of ['codex', 'claude']) {
      for (const card of ['permission', 'discovery']) {
        expect(css).toContain(
          `[data-interface-style="${shell}"]${LIGHT_NOT_CHAIN} .composer-${card}-card`
        )
      }
    }
    // The pre-fix unscoped selectors must not return (each sat at the start
    // of its own line in the shared dark-fill rule).
    expect(css).not.toMatch(
      /^\[data-interface-style="(?:codex|claude)"\] \.composer-(?:permission|discovery)-card/m
    )
  })

  it('keeps the charcoal shell treatment for dark themes', () => {
    const css = readCss('07-composer-shells.css')
    const darkBlock = cssBlockStartingAt(
      css,
      `[data-interface-style="codex"]${LIGHT_NOT_CHAIN} .composer-discovery-card,`
    )
    expect(darkBlock).toContain('background: color-mix(in srgb, #151515 96%, transparent)')
    expect(darkBlock).toContain('border-color: color-mix(in srgb, #ffffff 12%, transparent)')
  })

  it('keeps the light-theme approval-card treatments the shells now fall through to', () => {
    const css = readCss('03-composer-welcome-activity.css')
    const lightBase = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .composer-permission-card {'
    )
    expect(lightBase).toContain('background: rgba(255, 213, 130, 0.22)')
    const lightCodex = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .composer-permission-card.provider-codex {'
    )
    expect(lightCodex).toContain(
      'background: color-mix(in srgb, var(--provider-codex-color) 18%, transparent)'
    )
  })
})
