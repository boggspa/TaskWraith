import type { CSSProperties, ReactElement } from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import {
  ensembleFanoutViewportStageLabel,
  readEnsembleFanoutViewportHeader
} from '../lib/ensembleFanoutViewportGroups'
import { getProviderLabel } from '../lib/providerLabels'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { CollapsedTranscriptRow } from './CollapsedTranscriptRow'

const MAX_VISIBLE_PROVIDER_STRINGS = 8

interface EnsembleFanoutViewportHeaderProps {
  message: ChatMessage
  onSetExpanded: (viewportId: string, expanded: boolean) => void
}

export function EnsembleFanoutViewportHeader({
  message,
  onSetExpanded
}: EnsembleFanoutViewportHeaderProps): ReactElement | null {
  const data = readEnsembleFanoutViewportHeader(message)
  if (!data) return null

  const stageLabel = ensembleFanoutViewportStageLabel(data.stage)
  const laneLabel = `${data.laneCount} ${data.laneCount === 1 ? 'lane' : 'lanes'}`
  const providers = data.attributions.map((attribution) => {
    const provider = attribution.provider as ProviderId
    const hueClass = resolveProviderHueClass(provider, attribution.model) || provider || 'unknown'
    const providerLabel =
      resolveProviderBrandLabel(provider, attribution.model) || getProviderLabel(provider)
    return { ...attribution, hueClass, providerLabel }
  })
  const visibleProviders = providers.slice(0, MAX_VISIBLE_PROVIDER_STRINGS)
  const hiddenProviderCount = providers.length - visibleProviders.length
  const accessibleProviderLabels = providers
    .map((provider) =>
      provider.role ? `${provider.providerLabel} / ${provider.role}` : provider.providerLabel
    )
    .join(', ')
  const accessibleLabel = [stageLabel, laneLabel, accessibleProviderLabels]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className={`ensemble-fanout-viewport-header is-${data.stage}`}
      data-fanout-stage={data.stage}
    >
      <CollapsedTranscriptRow
        header={null}
        metaLabel="Fan-Out"
        label={accessibleLabel}
        labelContent={
          <>
            <span
              className={`ensemble-fanout-viewport-stage is-${data.stage}`}
              title={data.dispatchLabel || `${stageLabel} fan-out`}
            >
              {stageLabel}
            </span>
            <span className="ensemble-fanout-viewport-count"> · {laneLabel}</span>
            {visibleProviders.length > 0 ? (
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
                  <span className="ensemble-fanout-viewport-provider-overflow">
                    {' '}
                    +{hiddenProviderCount}
                  </span>
                ) : null}
              </span>
            ) : null}
          </>
        }
        compact
        expanded={data.expanded}
        onToggle={(expanded) => onSetExpanded(data.viewportId, expanded)}
        ariaTargetLabel={`${stageLabel} fan-out with ${laneLabel}`}
      />
    </div>
  )
}
