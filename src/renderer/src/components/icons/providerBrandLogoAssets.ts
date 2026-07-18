import type { ProviderId } from '../../../../main/store/types'
import claudeLogo from '../../assets/provider-logos/provider-logo-claude.png'
import codexLogo from '../../assets/provider-logos/provider-logo-codex-cloud.png'
import cursorLogoOnDark from '../../assets/provider-logos/provider-logo-cursor-on-dark.png'
import cursorLogoOnLight from '../../assets/provider-logos/provider-logo-cursor-on-light.png'
import geminiLogo from '../../assets/provider-logos/provider-logo-gemini.png'
import grokLogoOnDark from '../../assets/provider-logos/provider-logo-grok-on-dark.png'
import grokLogoOnLight from '../../assets/provider-logos/provider-logo-grok-on-light.png'
import kimiLogo from '../../assets/provider-logos/provider-logo-kimi.png'
import ollamaLogoOnDark from '../../assets/provider-logos/provider-logo-ollama-on-dark.png'
import ollamaLogoOnLight from '../../assets/provider-logos/provider-logo-ollama.png'

export type ProviderBrandLogoId = ProviderId | string | undefined

export interface ProviderBrandLogoSource {
  light: string
  dark?: string
}

export const PROVIDER_BRAND_LOGO_SOURCES: Readonly<Record<ProviderId, ProviderBrandLogoSource>> = {
  gemini: { light: geminiLogo },
  codex: { light: codexLogo },
  claude: { light: claudeLogo },
  kimi: { light: kimiLogo },
  grok: { light: grokLogoOnLight, dark: grokLogoOnDark },
  cursor: { light: cursorLogoOnLight, dark: cursorLogoOnDark },
  ollama: { light: ollamaLogoOnLight, dark: ollamaLogoOnDark }
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
