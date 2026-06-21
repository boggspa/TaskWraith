import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OllamaRunProfileId, OllamaToolControlTier } from '../../../main/store/types'
import { OllamaTierPicker } from './OllamaTierPicker'

function renderTrigger(
  selectedTier: OllamaToolControlTier,
  selectedRunProfile: OllamaRunProfileId
): string {
  return renderToStaticMarkup(
    <OllamaTierPicker
      provider="ollama"
      composerStyle="ollama"
      selectedTier={selectedTier}
      onSelectTier={() => undefined}
      selectedRunProfile={selectedRunProfile}
      onSelectRunProfile={() => undefined}
    />
  )
}

describe('OllamaTierPicker', () => {
  it('renders the selected tier as a compact primary/suffix chip', () => {
    const html = renderTrigger('approved_shell', 'verify_with_shell')
    expect(html).toContain('composer-ollama-tier-trigger')
    expect(html).toContain('data-ollama-tier="approved_shell"')
    // "Tier 3 · Approved shell" splits into primary + muted suffix
    expect(html).toContain('Tier 3')
    expect(html).toContain('composer-combined-picker-trigger-suffix')
    expect(html).toContain('Approved shell')
  })

  it('labels Tier 1 read-only without crashing on the default profile', () => {
    const html = renderTrigger('read_only', 'local_scout')
    expect(html).toContain('data-ollama-tier="read_only"')
    expect(html).toContain('Tier 1')
    expect(html).toContain('Read-only')
  })

  it('exposes the ollama-tier composer control hook for footer styling', () => {
    const html = renderTrigger('provider_parity', 'provider_parity')
    expect(html).toContain('data-composer-control="ollama-tier"')
    expect(html).toContain('Tier 4')
  })
})
