import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RefractionFilterDefs } from './FxLayers'

// Project convention: render via renderToStaticMarkup and assert on the output
// string (no jsdom, no @testing-library), mirroring ChatViewPane.test.tsx.
describe('RefractionFilterDefs', () => {
  const html = renderToStaticMarkup(<RefractionFilterDefs />)

  it('exposes the fixed filter id the CSS references by url()', () => {
    // The CSS agent does `filter: url(#tw-glass-refract)`, so this id is a hard
    // contract and must NOT be namespaced/per-instance.
    expect(html).toContain('id="tw-glass-refract"')
  })

  it('is a refractive displacement filter in sRGB', () => {
    expect(html).toContain('feDisplacementMap')
    // React serializes the camelCase prop to the kebab-case SVG attribute.
    expect(html).toContain('color-interpolation-filters="sRGB"')
  })

  it('uses a subtle, tasteful displacement scale', () => {
    expect(html).toContain('scale="16"')
  })

  it('drives displacement from static, fixed-seed turbulence (animation-free)', () => {
    // A fixed seed keeps the synthetic noise static — no animated primitive,
    // which would re-run the whole filter every frame.
    expect(html).toContain('feTurbulence')
    expect(html).toContain('seed="7"')
  })
})
