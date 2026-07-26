import type { ProviderId } from '../../../../main/store/types'
import antigravityLogo from '../../assets/provider-logos/provider-logo-antigravity.png'
import claudeLogo from '../../assets/provider-logos/provider-logo-claude.png'
import codexLogo from '../../assets/provider-logos/provider-logo-codex-cloud.png'
import cursorLogoOnDark from '../../assets/provider-logos/provider-logo-cursor-on-dark.png'
import cursorLogoOnLight from '../../assets/provider-logos/provider-logo-cursor-on-light.png'
import geminiLogo from '../../assets/provider-logos/provider-logo-gemini.png'
import grokLogoOnDark from '../../assets/provider-logos/provider-logo-grok-on-dark.png'
import grokLogoOnLight from '../../assets/provider-logos/provider-logo-grok-on-light.png'
import kimiLogo from '../../assets/provider-logos/provider-logo-kimi.png'
import ollamaLogoOnDark from '../../assets/provider-logos/provider-logo-ollama-on-dark.png'
import piLogo from '../../assets/provider-logos/provider-logo-pi.svg'
import ollamaLogoOnLight from '../../assets/provider-logos/provider-logo-ollama.png'

export type ProviderBrandLogoId = ProviderId | string | undefined

export interface ProviderBrandLogoSource {
  light: string
  dark?: string
}

// NOTE: intentionally `Partial` — unlike every other Record<ProviderId, ...> in
// this codebase, this one must NOT be widened to force a `mistral` entry with
// a fabricated import. No first-party Mistral brand asset has been sourced
// yet (checked both this runtime folder and the source catalogue at
// design-assets/provider-logos/, which still documents only nine tracked
// provider identities). Until one is sourced through that same pipeline —
// official brand pack, transparent PNG, entry in
// design-assets/provider-logos/provider-logos.manifest.json, byte-identical
// copy vendored here as `provider-logo-mistral.png` (or `.svg`, matching
// Pi's treatment) — omitting the `mistral` key is correct: consumers
// (`resolveProviderBrandLogoSource`, `ProviderBrandLogo`) already treat a
// missing entry as "fall back to the generic `ProviderGlyph` mnemonic," which
// already tints correctly via the existing `--provider-mistral-color` token.
export const PROVIDER_BRAND_LOGO_SOURCES: Readonly<
  Partial<Record<ProviderId, ProviderBrandLogoSource>>
> = {
  gemini: { light: geminiLogo },
  codex: { light: codexLogo },
  claude: { light: claudeLogo },
  kimi: { light: kimiLogo },
  grok: { light: grokLogoOnLight, dark: grokLogoOnDark },
  cursor: { light: cursorLogoOnLight, dark: cursorLogoOnDark },
  ollama: { light: ollamaLogoOnLight, dark: ollamaLogoOnDark },
  // An official runtime copy; this remains unreachable until the user's opt-in
  // and successful connection expose the provider.
  antigravity: { light: antigravityLogo },
  pi: { light: piLogo }
  // mistral: intentionally absent — see the file-level note above.
}

export function providerBrandLogoKey(provider?: ProviderBrandLogoId): string {
  const raw = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  return (
    raw
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  )
}

export function resolveProviderBrandLogoSource(
  provider?: ProviderBrandLogoId
): ProviderBrandLogoSource | undefined {
  const key = providerBrandLogoKey(provider)
  return PROVIDER_BRAND_LOGO_SOURCES[key as ProviderId]
}
