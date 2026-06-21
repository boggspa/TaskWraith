import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OllamaRunProfileId, OllamaToolControlTier } from '../../../main/store/types'
import { OllamaTierPicker, shouldGateOllamaTier4 } from './OllamaTierPicker'

function renderTrigger(
  selectedTier: OllamaToolControlTier,
  selectedRunProfile: OllamaRunProfileId
): string {
  return renderToStaticMarkup(
    <OllamaTierPicker
      provider="ollama"
      composerStyle="codex"
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

  it('flags an ineffective Tier 4 on the chip when the workspace is ungranted', () => {
    const html = renderToStaticMarkup(
      <OllamaTierPicker
        provider="ollama"
        composerStyle="codex"
        selectedTier="provider_parity"
        onSelectTier={() => undefined}
        selectedRunProfile="provider_parity"
        onSelectRunProfile={() => undefined}
        tier4Granted={false}
      />
    )
    expect(html).toContain('data-ollama-tier-ineffective="true"')
    expect(html).toContain('composer-ollama-tier-warning')
  })

  it('does NOT flag Tier 4 when the workspace is explicitly granted', () => {
    const html = renderToStaticMarkup(
      <OllamaTierPicker
        provider="ollama"
        composerStyle="codex"
        selectedTier="provider_parity"
        onSelectTier={() => undefined}
        selectedRunProfile="provider_parity"
        onSelectRunProfile={() => undefined}
        tier4Granted={true}
      />
    )
    expect(html).not.toContain('data-ollama-tier-ineffective')
    expect(html).not.toContain('composer-ollama-tier-warning')
  })
})

describe('shouldGateOllamaTier4 (security gate routing)', () => {
  it('gates Tier 4 when the workspace grant is missing or unknown (fail closed)', () => {
    expect(shouldGateOllamaTier4({ tier: 'provider_parity', tier4Granted: false })).toBe(true)
    // undefined grant state must STILL gate — never write parity by default
    expect(shouldGateOllamaTier4({ tier: 'provider_parity' })).toBe(true)
    expect(shouldGateOllamaTier4({ tier: 'provider_parity', tier4Granted: undefined })).toBe(true)
  })

  it('gates Tier 4 in a global chat even if a grant is somehow present', () => {
    expect(
      shouldGateOllamaTier4({
        tier: 'provider_parity',
        tier4Granted: true,
        tier4Unavailable: true
      })
    ).toBe(true)
  })

  it('lets Tier 4 through ONLY with an explicit live workspace grant', () => {
    expect(
      shouldGateOllamaTier4({ tier: 'provider_parity', tier4Granted: true, tier4Unavailable: false })
    ).toBe(false)
  })

  it('never gates the lower tiers regardless of grant state (downgrade is free)', () => {
    for (const tier of ['read_only', 'approved_edits', 'approved_shell'] as const) {
      expect(shouldGateOllamaTier4({ tier })).toBe(false)
      expect(shouldGateOllamaTier4({ tier, tier4Granted: false, tier4Unavailable: true })).toBe(
        false
      )
    }
  })
})
