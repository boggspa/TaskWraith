import type { ReactElement } from 'react'
import {
  providerBrandLogoKey,
  resolveProviderBrandLogoSource,
  type ProviderBrandLogoId
} from './providerBrandLogoAssets'
import { ProviderGlyph } from './ProviderGlyph'

interface ProviderBrandLogoProps {
  provider?: ProviderBrandLogoId
  accentProvider?: ProviderBrandLogoId
  className?: string
}

interface ProviderBrandLogoIconProps extends ProviderBrandLogoProps {
  wrapperClassName?: string
}

/**
 * Official/first-party provider artwork for identity contexts beside a
 * provider or model name. Ensemble and unknown providers intentionally fall
 * back to TaskWraith's provider mnemonic; those glyphs also remain available
 * in the generic Identity Icon Picker. Ensemble's mnemonic is full colour.
 */
export function ProviderBrandLogo({
  provider,
  accentProvider,
  className
}: ProviderBrandLogoProps): ReactElement {
  const providerKey = providerBrandLogoKey(provider)
  const source = resolveProviderBrandLogoSource(providerKey)

  if (!source) {
    return (
      <ProviderGlyph provider={providerKey} accentProvider={accentProvider} className={className} />
    )
  }

  const hasThemePair = Boolean(source.dark)
  return (
    <span
      className={[
        'provider-brand-logo',
        `provider-brand-logo-${providerKey}`,
        hasThemePair ? 'has-theme-pair' : 'is-static',
        className
      ]
        .filter(Boolean)
        .join(' ')}
      data-provider-logo={providerKey}
      aria-hidden="true"
    >
      <img
        className="provider-brand-logo-image provider-brand-logo-image-light"
        src={source.light}
        alt=""
        draggable={false}
      />
      {source.dark && (
        <img
          className="provider-brand-logo-image provider-brand-logo-image-dark"
          src={source.dark}
          alt=""
          draggable={false}
        />
      )}
    </span>
  )
}

/** Compact wrapper matching the established provider-badge sizing seam. */
export function ProviderBrandLogoIcon({
  provider,
  accentProvider,
  className,
  wrapperClassName
}: ProviderBrandLogoIconProps): ReactElement {
  const providerKey = providerBrandLogoKey(provider)
  return (
    <span
      className={[
        'sidebar-provider-icon',
        'provider-brand-logo-icon',
        `provider-${providerKey}`,
        wrapperClassName
      ]
        .filter(Boolean)
        .join(' ')}
      aria-hidden="true"
    >
      <ProviderBrandLogo
        provider={providerKey}
        accentProvider={accentProvider}
        className={className}
      />
    </span>
  )
}
