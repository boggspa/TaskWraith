import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AnimatedDiffNumber } from './AnimatedDiffNumber'

describe('AnimatedDiffNumber', () => {
  it('renders diff stats through the per-digit odometer', () => {
    const html = renderToStaticMarkup(
      <AnimatedDiffNumber value={96} prefix="+" className="composer-diff-add" />
    )

    expect(html).toContain('composer-odometer-number')
    expect(html).toContain('composer-diff-add')
    expect(html).toContain('digit-odometer')
    expect(html).toContain('<span class="sr-only">+96</span>')
  })

  it('keeps strong file counts while using digit slots', () => {
    const html = renderToStaticMarkup(<AnimatedDiffNumber value={8} strong />)

    expect(html).toContain('<strong')
    expect(html).toContain('digit-odometer__slot')
    expect(html).toContain('<span class="sr-only">8</span>')
  })
})
