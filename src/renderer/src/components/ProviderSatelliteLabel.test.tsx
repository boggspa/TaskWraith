import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderSatelliteLabel } from './ProviderSatelliteLabel'

describe('ProviderSatelliteLabel', () => {
  it.each([
    ['codex', 'Codex'],
    ['claude', 'Claude'],
    ['cursor', 'Cursor'],
    ['grok', 'Grok'],
    ['kimi', 'Kimi'],
    ['ollama', 'Ollama']
  ] as const)('renders the %s PNG mark and hue-accented name', (provider, label) => {
    const html = renderToStaticMarkup(<ProviderSatelliteLabel provider={provider} />)

    expect(html).toContain(`provider-satellite-label provider-${provider}`)
    expect(html).toContain(`data-provider-logo="${provider}"`)
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain(`provider-glyph-${provider}`)
    expect(html).toContain(`var(--provider-${provider}-color, var(--text-primary))`)
    expect(html).toContain(`>${label}</span>`)
  })

  it('uses the generic glyph when provider metadata is absent', () => {
    const html = renderToStaticMarkup(<ProviderSatelliteLabel />)

    expect(html).toContain('provider-satellite-label provider-unknown')
    expect(html).toContain('provider-glyph-unknown')
    expect(html).not.toContain('provider-glyph-gemini')
    expect(html).not.toContain('data-provider-logo=')
    expect(html).not.toContain('<img')
    expect(html).toContain('>Agent</span>')
  })
})
