import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderBadgeIcon } from './Sidebar'

describe('ProviderBadgeIcon', () => {
  it('renders a distinct Cursor glyph instead of falling through to Kimi', () => {
    const cursor = renderToStaticMarkup(<ProviderBadgeIcon provider="cursor" />)
    const kimi = renderToStaticMarkup(<ProviderBadgeIcon provider="kimi" />)

    expect(cursor).toContain('provider-cursor')
    expect(kimi).toContain('provider-kimi')
    expect(cursor).toContain('provider-glyph-cursor')
    expect(kimi).toContain('provider-glyph-kimi')
    expect(cursor).toContain('M5.7 3.8 18.8 12l-6.1 1.3-2.7 5.8Z')
    expect(cursor).not.toContain('M15.6 4.7a7.9 7.9')
    expect(cursor).not.toEqual(kimi)
  })

  it('renders the Ollama llama glyph in sidebar provider badges', () => {
    const ollama = renderToStaticMarkup(<ProviderBadgeIcon provider="ollama" />)

    expect(ollama).toContain('provider-ollama')
    expect(ollama).toContain('provider-glyph-ollama')
    expect(ollama).toContain('M15.2 11.5V6.6')
    expect(ollama).not.toContain('M4.6 6.2h14.8v11.6H4.6Z')
  })

  it('renders the Ensemble glyph in sidebar provider badges', () => {
    const ensemble = renderToStaticMarkup(<ProviderBadgeIcon provider="ensemble" />)

    expect(ensemble).toContain('provider-ensemble')
    expect(ensemble).toContain('provider-glyph-ensemble')
    expect(ensemble).toContain('provider-glyph-ensemble-spectrum-')
    expect(ensemble).toContain('data-brand="antigravity"')
    expect(ensemble).not.toContain('M6.6 19.8c.25-3.45')
  })
})
