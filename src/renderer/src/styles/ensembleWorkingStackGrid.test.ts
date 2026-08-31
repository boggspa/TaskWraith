import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/09-ensemble-work-session.css'),
  'utf8'
)

describe('unified Ensemble working seat grid', () => {
  it('uses theme-contrast ink for the shared signal instead of a participant hue', () => {
    const unifiedRule = css.slice(
      css.indexOf('.message-working-unified {'),
      css.indexOf('.message-working-unified > .message-working')
    )
    expect(unifiedRule).toContain('--message-working-accent: var(--text-primary);')
    expect(unifiedRule).not.toContain('var(--provider-ensemble-color')
  })

  it('uses four bare close-out-style seat columns below one Working signal', () => {
    expect(css).toContain('.message-working-unified {')
    expect(css).toContain('container: working-indicator / inline-size;')
    expect(css).toContain('padding: var(--space-xs) 0;')
    expect(css).toContain('.message-working-seat-grid {')
    expect(css).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));')
    expect(css).toContain('padding-inline-start: 34px;')
    expect(css).toContain('.message-working-seat {')
    expect(css).toContain('border: 0;')
    expect(css).toContain('background: none;')
    expect(css).toContain('font-size: calc(var(--font-size-xs) + 1px);')
    expect(css).toContain('font-weight: 500;')
  })

  it('returns to two columns and then one on narrow transcript panes', () => {
    const tabletRules = css.slice(
      css.indexOf('@container working-indicator (max-width: 720px)'),
      css.indexOf('@container working-indicator (max-width: 420px)')
    )
    const mobileRules = css.slice(css.indexOf('@container working-indicator (max-width: 420px)'))
    expect(tabletRules).toContain('.message-working-seat-grid {')
    expect(tabletRules).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(mobileRules).toContain('.message-working-seat-grid {')
    expect(mobileRules).toContain('grid-template-columns: minmax(0, 1fr);')
  })
})
