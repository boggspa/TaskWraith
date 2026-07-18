import type { CSSProperties } from 'react'
import type { ProviderId } from '../../../main/store/types'
import { providerDisplayName } from '../lib/AgentInvocationPresentation'
import { ProviderBrandLogo } from './icons/ProviderBrandLogo'

interface ProviderSatelliteLabelProps {
  provider?: ProviderId | string
  className?: string
}

function providerClass(provider?: ProviderId | string): string {
  const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  return (
    normalized
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unknown'
  )
}

/** First-party provider mark + hue-accented name, without badge chrome. */
export function ProviderSatelliteLabel({
  provider,
  className
}: ProviderSatelliteLabelProps): React.JSX.Element {
  const providerKey = providerClass(provider)
  const style = {
    color: `var(--provider-${providerKey}-color, var(--text-primary))`
  } as CSSProperties

  return (
    <span
      className={['provider-satellite-label', `provider-${providerKey}`, className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <ProviderBrandLogo provider={providerKey} className="provider-satellite-label-glyph" />
      <span className="provider-satellite-label-name">{providerDisplayName(provider)}</span>
    </span>
  )
}
