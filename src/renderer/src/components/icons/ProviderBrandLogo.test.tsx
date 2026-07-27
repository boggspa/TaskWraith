import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderBrandLogo } from './ProviderBrandLogo'
import {
  PROVIDER_BRAND_LOGO_SOURCES,
  resolveProviderBrandLogoSource
} from './providerBrandLogoAssets'

const STATIC_PROVIDERS = ['gemini', 'codex', 'claude', 'kimi', 'antigravity', 'mistral'] as const
const THEMED_PROVIDERS = ['cursor', 'grok', 'ollama', 'pi'] as const
const KNOWN_PROVIDERS = [...STATIC_PROVIDERS, ...THEMED_PROVIDERS] as const

describe('ProviderBrandLogo', () => {
  it('renders official raster artwork for all ten tracked providers', () => {
    for (const provider of KNOWN_PROVIDERS) {
      const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

      // The source map stays Partial so Ensemble and future providers can use
      // ProviderGlyph. Every current provider with sourced artwork belongs in
      // this list, so a missing entry here is a real regression.
      const bundled = PROVIDER_BRAND_LOGO_SOURCES[provider]
      expect(bundled, `${provider} is listed as known but has no bundled logo`).toBeDefined()

      expect(html).toContain(`data-provider-logo="${provider}"`)
      expect(html).toContain(`provider-brand-logo-${provider}`)
      expect(html).toContain(`src="${bundled?.light}"`)
      expect(html).not.toContain('data-provider-glyph="true"')
      expect(html).not.toContain('<svg')
    }
  })

  it('uses one static image for marks that do not need a theme variant', () => {
    for (const provider of STATIC_PROVIDERS) {
      const source = resolveProviderBrandLogoSource(provider)
      const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

      expect(source?.light).toBe(PROVIDER_BRAND_LOGO_SOURCES[provider]?.light)
      expect(source?.dark).toBeUndefined()
      expect(html).toContain('is-static')
      expect(html).not.toContain('has-theme-pair')
      expect(html.match(/<img/g)).toHaveLength(1)
      expect(html).toContain('provider-brand-logo-image-light')
      expect(html).not.toContain('provider-brand-logo-image-dark')
    }
  })

  it('renders paired light- and dark-surface artwork for theme-sensitive marks', () => {
    for (const provider of THEMED_PROVIDERS) {
      const source = PROVIDER_BRAND_LOGO_SOURCES[provider]
      const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

      expect(source, `${provider} is listed as themed but has no bundled logo`).toBeDefined()
      expect(source?.dark).toBeDefined()
      expect(html).toContain('has-theme-pair')
      expect(html).not.toContain('is-static')
      expect(html.match(/<img/g)).toHaveLength(2)
      expect(html).toContain(`src="${source?.light}"`)
      expect(html).toContain(`src="${source?.dark}"`)
      expect(html).toContain('provider-brand-logo-image-light')
      expect(html).toContain('provider-brand-logo-image-dark')
    }
  })

  it('keeps provider artwork decorative for an adjacent text label', () => {
    const html = renderToStaticMarkup(<ProviderBrandLogo provider="cursor" />)

    expect(html).toContain('aria-hidden="true"')
    expect(html.match(/alt=""/g)).toHaveLength(2)
    expect(html.match(/draggable="false"/g)).toHaveLength(2)
  })

  it('balances new source canvases optically without changing their pixels', () => {
    const piHtml = renderToStaticMarkup(<ProviderBrandLogo provider="pi" />)
    const mistralHtml = renderToStaticMarkup(<ProviderBrandLogo provider="mistral" />)

    expect(piHtml).toContain('--provider-brand-logo-scale:1.32')
    expect(mistralHtml).toContain('--provider-brand-logo-scale:1.08')
  })

  it('keeps every desktop and iOS PNG byte-identical to its design asset', () => {
    const copies = [
      ['provider-logo-gemini.png', 'provider-logo-gemini.png', 'provider-logo-gemini.png'],
      ['provider-logo-codex-cloud.png', 'provider-logo-codex-cloud.png', 'provider-logo-codex.png'],
      ['provider-logo-claude.png', 'provider-logo-claude.png', 'provider-logo-claude.png'],
      ['provider-logo-kimi.png', 'provider-logo-kimi.png', 'provider-logo-kimi.png'],
      [
        'provider-logo-antigravity.png',
        'provider-logo-antigravity.png',
        'provider-logo-antigravity.png'
      ],
      [
        'provider-logo-cursor-on-light.png',
        'provider-logo-cursor-on-light.png',
        'provider-logo-cursor-on-light.png'
      ],
      [
        'provider-logo-cursor-on-dark.png',
        'provider-logo-cursor-on-dark.png',
        'provider-logo-cursor-on-dark.png'
      ],
      [
        'provider-logo-grok-on-light.png',
        'provider-logo-grok-on-light.png',
        'provider-logo-grok-on-light.png'
      ],
      [
        'provider-logo-grok-on-dark.png',
        'provider-logo-grok-on-dark.png',
        'provider-logo-grok-on-dark.png'
      ],
      ['provider-logo-ollama.png', 'provider-logo-ollama.png', 'provider-logo-ollama-on-light.png'],
      [
        'provider-logo-ollama-on-dark.png',
        'provider-logo-ollama-on-dark.png',
        'provider-logo-ollama-on-dark.png'
      ],
      [
        'provider-logo-pi-on-light.png',
        'provider-logo-pi-on-light.png',
        'provider-logo-pi-on-light.png'
      ],
      [
        'provider-logo-pi-on-dark.png',
        'provider-logo-pi-on-dark.png',
        'provider-logo-pi-on-dark.png'
      ],
      ['provider-logo-mistral.png', 'provider-logo-mistral.png', 'provider-logo-mistral.png']
    ] as const

    for (const [designName, desktopName, iosName] of copies) {
      const designAsset = readFileSync(resolve('design-assets/provider-logos/png', designName))
      const runtimeCopies = [
        resolve('src/renderer/src/assets/provider-logos', desktopName),
        resolve('ios/TaskWraithKit/Sources/TaskWraithUI/Resources', iosName)
      ]

      for (const runtimeCopy of runtimeCopies) {
        // `toEqual` on Buffers walks vitest's structural differ byte by byte,
        // which costs ~2s for this set on fast hardware and timed the test out
        // at 5s on the slower macOS Intel runner — and the asset list grows
        // with every provider. `equals` is a native memcmp asserting the same
        // byte-identity; the path stays in the message so a mismatch still
        // names the offending copy.
        expect(readFileSync(runtimeCopy).equals(designAsset), runtimeCopy).toBe(true)
      }
    }
  })

  it('keeps external brand mimicry out of the provider-glyph asset trees', () => {
    const designGlyphs = readdirSync(resolve('design-assets/provider-glyphs/glyphs'))
      .filter((name) => name.endsWith('.svg'))
      .sort()
    const designPngs = readdirSync(resolve('design-assets/provider-glyphs/png'))
      .filter((name) => name.endsWith('.png'))
      .sort()
    const iosGlyphs = readdirSync(resolve('ios/TaskWraithKit/Sources/TaskWraithUI/Resources'))
      .filter((name) => name.startsWith('provider-glyph-'))
      .sort()

    expect(designGlyphs).toEqual(['ensemble.svg'])
    expect(designPngs).toEqual(['provider-glyph-ensemble.png'])
    expect(iosGlyphs).toEqual(['provider-glyph-ensemble.png'])
  })

  it.each([
    ['Ensemble', 'ensemble', 'ensemble'],
    ['unknown provider', 'future-provider', 'future-provider'],
    ['missing provider', undefined, 'unknown']
  ])('uses TaskWraith-owned fallback artwork for %s', (_label, provider, providerKey) => {
    const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

    expect(html).toContain('<svg')
    expect(html).toContain(`provider-glyph-${providerKey}`)
    expect(html).not.toContain('data-provider-logo=')
    expect(html).not.toContain('<img')
  })
})
