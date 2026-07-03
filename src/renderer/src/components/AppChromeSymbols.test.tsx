import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextWheel } from './AppChromeSymbols'

describe('ContextWheel', () => {
  it('starts the context arc from top-center', () => {
    const html = renderToStaticMarkup(<ContextWheel percent={25} label="25 / 100 context" />)

    expect(html).toContain('transform="rotate(-90 7 7)"')
    expect(html).not.toContain('stroke-dashoffset')
  })
})
