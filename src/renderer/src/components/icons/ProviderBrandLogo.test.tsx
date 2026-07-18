import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderBrandLogo } from './ProviderBrandLogo'
import {
  PROVIDER_BRAND_LOGO_SOURCES,
  resolveProviderBrandLogoSource
} from './providerBrandLogoAssets'

const STATIC_PROVIDERS = ['gemini', 'codex', 'claude', 'kimi'] as const
const THEMED_PROVIDERS = ['cursor', 'grok', 'ollama'] as const
const KNOWN_PROVIDERS = [...STATIC_PROVIDERS, ...THEMED_PROVIDERS] as const

describe('ProviderBrandLogo', () => {
  it('renders official raster artwork for all seven known providers', () => {
    for (const provider of KNOWN_PROVIDERS) {
      const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

      expect(html).toContain(`data-provider-logo="${provider}"`)
      expect(html).toContain(`provider-brand-logo-${provider}`)
      expect(html).toContain(`src="${PROVIDER_BRAND_LOGO_SOURCES[provider].light}"`)
      expect(html).not.toContain('data-provider-glyph="true"')
      expect(html).not.toContain('<svg')
    }
  })

  it('uses one static image for marks that do not need a theme variant', () => {
    for (const provider of STATIC_PROVIDERS) {
      const source = resolveProviderBrandLogoSource(provider)
      const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

      expect(source).toEqual({ light: PROVIDER_BRAND_LOGO_SOURCES[provider].light })
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

      expect(source.dark).toBeDefined()
      expect(html).toContain('has-theme-pair')
      expect(html).not.toContain('is-static')
      expect(html.match(/<img/g)).toHaveLength(2)
      expect(html).toContain(`src="${source.light}"`)
      expect(html).toContain(`src="${source.dark}"`)
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

  it.each([
    ['Ensemble', 'ensemble', 'ensemble'],
    ['unknown provider', 'future-provider', 'future-provider'],
    ['missing provider', undefined, 'unknown']
  ])('falls back to the legacy glyph for %s', (_label, provider, providerKey) => {
    const html = renderToStaticMarkup(<ProviderBrandLogo provider={provider} />)

    expect(html).toContain('<svg')
    expect(html).toContain(`provider-glyph-${providerKey}`)
    expect(html).not.toContain('data-provider-logo=')
    expect(html).not.toContain('<img')
  })
})
