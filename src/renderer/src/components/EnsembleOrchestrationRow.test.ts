import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/*
 * Orchestration-row text weight (no jsdom in this repo, so pin the CSS).
 *
 * The row's controls are satellite text buttons, and they have to read as one
 * set: `Turn` / `Continuous` are pinned to --text-primary, but the fan-out
 * isolation toggle sat on --text-muted, so "Shared" looked disabled rather than
 * simply un-toggled. A state the user can act on must not be styled like one
 * they can't.
 */
const css = readFileSync(
  new URL('../assets/css/09-ensemble-work-session.css', import.meta.url),
  'utf8'
)

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('orchestration row control text', () => {
  it('rests the fan-out isolation toggle at full text strength, like its neighbours', () => {
    const toggle = rule('.composer-fanout-isolation-toggle')
    expect(toggle).toMatch(/color:\s*var\(--text-primary\)/)
    expect(toggle).not.toMatch(/color:\s*var\(--text-muted\)/)
  })

  it('keeps the accent on the active state so the toggle still signals on/off', () => {
    // Raising the resting colour must not cost the ON cue — otherwise the two
    // states become indistinguishable.
    const active = rule(".composer-fanout-isolation-toggle[data-active='true']")
    expect(active).toMatch(/color:\s*var\(--accent-color\)/)
  })

  it('references only colour tokens the themes actually define', () => {
    // `--text-color` is defined nowhere; a declaration using it is dropped as
    // invalid, which is exactly how the dead hover rule hid this for so long.
    const defined = (token: string): boolean =>
      new RegExp(`--${token}:`).test(
        readFileSync(
          new URL('../assets/css/08-theme-picker-overrides.css', import.meta.url),
          'utf8'
        )
      )
    expect(defined('text-primary')).toBe(true)
    expect(defined('text-muted')).toBe(true)
    expect(defined('text-color')).toBe(false)
    // Comments stripped first — the rule that removed the dead declaration
    // NAMES the token to explain itself, and a mention is not a use.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).not.toContain('var(--text-color)')
  })
})
