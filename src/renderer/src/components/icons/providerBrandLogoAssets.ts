import type { ProviderId } from '../../../../main/store/types'
import antigravityLogo from '../../assets/provider-logos/provider-logo-antigravity.png'
import cerebrasLogoOnDark from '../../assets/provider-logos/provider-logo-cerebras-on-dark.png'
import cerebrasLogoOnLight from '../../assets/provider-logos/provider-logo-cerebras-on-light.png'
import claudeLogo from '../../assets/provider-logos/provider-logo-claude.png'
import codexLogo from '../../assets/provider-logos/provider-logo-codex-cloud.png'
import cursorLogoOnDark from '../../assets/provider-logos/provider-logo-cursor-on-dark.png'
import cursorLogoOnLight from '../../assets/provider-logos/provider-logo-cursor-on-light.png'
import deepseekLogo from '../../assets/provider-logos/provider-logo-deepseek.png'
import devinLogoOnDark from '../../assets/provider-logos/provider-logo-devin-on-dark.png'
import devinLogoOnLight from '../../assets/provider-logos/provider-logo-devin-on-light.png'
import geminiLogo from '../../assets/provider-logos/provider-logo-gemini.png'
import grokLogoOnDark from '../../assets/provider-logos/provider-logo-grok-on-dark.png'
import grokLogoOnLight from '../../assets/provider-logos/provider-logo-grok-on-light.png'
import kimiLogo from '../../assets/provider-logos/provider-logo-kimi.png'
import mistralLogo from '../../assets/provider-logos/provider-logo-mistral.png'
import ollamaLogoOnDark from '../../assets/provider-logos/provider-logo-ollama-on-dark.png'
import ollamaLogoOnLight from '../../assets/provider-logos/provider-logo-ollama.png'
import piLogoOnDark from '../../assets/provider-logos/provider-logo-pi-on-dark.png'
import piLogoOnLight from '../../assets/provider-logos/provider-logo-pi-on-light.png'

/**
 * Upstream marks can appear beside their own billing/usage rows without
 * becoming TaskWraith runtime providers. Keep this list separate from
 * `ProviderId` so rendering an identity mark never changes provider admission.
 */
export type SupplementalProviderBrandLogoId = 'deepseek' | 'cerebras'
export type ProviderBrandLogoAssetId = ProviderId | SupplementalProviderBrandLogoId
export type ProviderBrandLogoId = ProviderBrandLogoAssetId | string | undefined

export interface ProviderBrandLogoSource {
  light: string
  dark?: string
  /** Optical balance inside a fixed 1em slot; source pixels stay untouched. */
  scale?: number
}

// Intentionally `Partial`: Ensemble and future/unknown provider ids retain the
// TaskWraith mnemonic fallback. Every current ProviderId with sourced artwork,
// plus the user-approved DeepSeek and Cerebras upstream marks that surface in
// model usage, is mapped below; provenance and byte-integrity live in
// design-assets/provider-logos/provider-logos.manifest.json.
export const PROVIDER_BRAND_LOGO_SOURCES: Readonly<
  Partial<Record<ProviderBrandLogoAssetId, ProviderBrandLogoSource>>
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
  pi: { light: piLogoOnLight, dark: piLogoOnDark, scale: 1.32 },
  mistral: { light: mistralLogo, scale: 1.08 },
  // Monochrome three-hexagon mark: the official black favicon on light
  // surfaces and its recorded RGB-inverted derivative on dark ones.
  devin: { light: devinLogoOnLight, dark: devinLogoOnDark },
  // Pi upstream/model-usage identity only — neither widens ProviderId nor
  // grants a separate runtime seat.
  deepseek: { light: deepseekLogo },
  cerebras: { light: cerebrasLogoOnLight, dark: cerebrasLogoOnDark }
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
  return PROVIDER_BRAND_LOGO_SOURCES[key as ProviderBrandLogoAssetId]
}
