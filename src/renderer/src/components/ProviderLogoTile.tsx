/*
 * ProviderLogoTile — Phase L6 slice 4 (+ follow-up).
 *
 * Renders first-party provider artwork beside a provider label. The historical
 * component name remains because settings and usage surfaces share this seam.
 */
import type { ReactElement } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { ProviderBrandLogo } from './icons/ProviderBrandLogo'

interface ProviderLogoTileProps {
  provider: ProviderId | undefined
  /** Tile edge in px. Defaults to 22 — sized to sit comfortably
   * next to a ~13px text label in the Model Usage Card header. */
  size?: number
  /** Optional className for layout overrides. */
  className?: string
}

export function ProviderLogoTile({
  provider,
  size = 22,
  className
}: ProviderLogoTileProps): ReactElement {
  const providerKey = provider || 'gemini'
  const tileStyle = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: `${Math.max(4, size * 0.26)}px`
  }
  return (
    <span
      className={['provider-logo-tile', `provider-${providerKey}`, className]
        .filter(Boolean)
        .join(' ')}
      style={tileStyle}
      aria-hidden
    >
      <ProviderBrandLogo provider={providerKey} />
    </span>
  )
}
