import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
  'utf8'
)
const theme = readFileSync(join(process.cwd(), 'src/renderer/src/styles/theme.css'), 'utf8')

function classesFrom(pattern: RegExp): string[] {
  return Array.from(css.matchAll(pattern), (match) => match[1]).sort()
}

/** Provider hue classes that tint the meta row above a message bubble. */
const labelClasses = classesFrom(/\.message-meta\.provider-([a-z0-9-]+)\s*\{/g)
/** The same hue classes, projected onto the working indicator's accent. */
const accentClasses = classesFrom(
  /\.message-group:has\(\.message-meta\.provider-([a-z0-9-]+)\)\s*\{/g
)

describe('working indicator provider accent', () => {
  // These two enumerations are hand-maintained and neither compiles, so nothing
  // but this test stops one from gaining a provider the other never learns —
  // which reads in the app as a seat whose label is tinted while its working
  // indicator stays on the ambient app accent.
  it('tints the meta label and the working accent for exactly the same hue classes', () => {
    expect(labelClasses.length).toBeGreaterThan(0)
    expect(accentClasses).toEqual(labelClasses)
  })

  it('backs every hue class with a defined palette token', () => {
    const undefinedTokens = labelClasses.filter(
      (hue) => !theme.includes(`--provider-${hue}-color:`)
    )
    expect(undefinedTokens).toEqual([])
  })

  // The interval between two seats is round-owned: `turnTransitionPresentation`
  // emits no `provider`, and when neither side of the transition resolves to a
  // seat it falls back to this hue. Without the rules it would inherit
  // `var(--accent)` — the user-configurable APP accent, gray under
  // graphite/obsidian — so the handoff colour would track the theme rather than
  // the ensemble.
  it('gives the round-owned ensemble fallback its own hue rather than the app accent', () => {
    expect(labelClasses).toContain('ensemble')
    expect(css).toContain('.message-meta.provider-ensemble {')
    expect(css).toContain('color: var(--provider-ensemble-color) !important;')
    expect(css).toContain('.message-group:has(.message-meta.provider-ensemble) {')
    expect(css).toContain('--message-working-accent: var(--provider-ensemble-color);')
  })
})
