import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/09-ensemble-work-session.css'),
  'utf8'
)

describe('ensemble working stack grid', () => {
  it('keeps multi-participant working rows in two columns', () => {
    expect(css).toContain('.message-working-stack {')
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));')
    expect(css).toContain('column-gap: clamp(var(--space-md), 3vw, var(--space-xl));')
    expect(css).toContain('row-gap: var(--space-md);')
    expect(css).toContain('.message-working-stack-row .message-meta {')
    expect(css).toContain('flex-wrap: wrap;')
  })

  it('returns to one column on narrow transcript panes', () => {
    const mobileRules = css.slice(css.indexOf('@media (max-width: 620px)'))
    expect(mobileRules).toContain('.message-working-stack {')
    expect(mobileRules).toContain('grid-template-columns: minmax(0, 1fr);')
  })
})
