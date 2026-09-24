import type { CSSProperties, ReactElement } from 'react'
import type { ProviderId } from '../../../main/store/types'
import type { EnsembleFanoutViewportAttribution } from '../lib/ensembleFanoutViewportGroups'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { getProviderLabel } from '../lib/providerLabels'

const MAX_VISIBLE_PROVIDER_STRINGS = 8

export interface EnsembleFanoutProviderPresentation extends EnsembleFanoutViewportAttribution {
  hueClass: string
  providerLabel: string
}

export function resolveEnsembleFanoutProviderPresentations(
  attributions: readonly EnsembleFanoutViewportAttribution[]
): EnsembleFanoutProviderPresentation[] {
  return attributions.map((attribution) => {
    const provider = attribution.provider as ProviderId
    const hueClass = resolveProviderHueClass(provider, attribution.model) || provider || 'unknown'
    const providerLabel =
      resolveProviderBrandLabel(provider, attribution.model) || getProviderLabel(provider)
    return { ...attribution, hueClass, providerLabel }
  })
}

export function ensembleFanoutProviderAccessibleLabels(
  providers: readonly EnsembleFanoutProviderPresentation[]
): string {
  return providers
    .map((provider) =>
      provider.role ? `${provider.providerLabel} / ${provider.role}` : provider.providerLabel
    )
    .join(', ')
}

export function EnsembleFanoutProviderStrip({
  providers
}: {
  providers: readonly EnsembleFanoutProviderPresentation[]
}): ReactElement | null {
  const visibleProviders = providers.slice(0, MAX_VISIBLE_PROVIDER_STRINGS)
  const hiddenProviderCount = providers.length - visibleProviders.length
  if (visibleProviders.length === 0) return null

  return (
    <span className="ensemble-fanout-viewport-providers">
      <span aria-hidden="true"> · </span>
      {visibleProviders.map((provider, index) => (
        <span key={provider.participantId || `${provider.provider}:${index}`}>
          {index > 0 ? <span aria-hidden="true"> / </span> : null}
          <span
            className={`ensemble-fanout-viewport-provider provider-${provider.hueClass}`}
            data-provider={provider.provider}
            data-provider-hue={provider.hueClass}
            data-model={provider.model || undefined}
            style={
              {
                '--ensemble-fanout-viewport-provider-accent': `var(--provider-${provider.hueClass}-color, var(--accent))`
              } as CSSProperties
            }
            title={[provider.providerLabel, provider.role, provider.model]
              .filter(Boolean)
              .join(' / ')}
          >
            {provider.providerLabel}
            {provider.role ? ` / ${provider.role}` : ''}
          </span>
        </span>
      ))}
      {hiddenProviderCount > 0 ? (
        <span className="ensemble-fanout-viewport-provider-overflow"> +{hiddenProviderCount}</span>
      ) : null}
    </span>
  )
}
