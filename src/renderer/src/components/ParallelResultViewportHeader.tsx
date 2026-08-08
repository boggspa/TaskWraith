import type { CSSProperties, ReactElement } from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import {
  parallelResultViewportCategoryLabel,
  readParallelResultViewportHeader
} from '../lib/parallelResultViewportGroups'
import { getProviderLabel } from '../lib/providerLabels'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { CollapsedTranscriptRow } from './CollapsedTranscriptRow'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'

const MAX_VISIBLE_PROVIDER_STRINGS = 8

export type {
  ParallelResultViewportCategory,
  ParallelResultViewportHeaderData
} from '../lib/parallelResultViewportGroups'

interface ParallelResultViewportHeaderProps {
  message: ChatMessage
  onSetExpanded: (viewportId: string, expanded: boolean) => void
}

export function ParallelResultViewportHeader({
  message,
  onSetExpanded
}: ParallelResultViewportHeaderProps): ReactElement | null {
  const data = readParallelResultViewportHeader(message)
  if (!data) return null

  const metaLabel = parallelResultViewportCategoryLabel(data.category)
  const laneLabel = `${data.memberCount} ${data.memberCount === 1 ? 'lane' : 'lanes'}`
  const providers = data.attributions.map((attribution) => {
    const provider = attribution.provider as ProviderId
    const hueClass = resolveProviderHueClass(provider) || provider || 'unknown'
    const providerLabel = resolveProviderBrandLabel(provider) || getProviderLabel(provider)
    return { ...attribution, hueClass, providerLabel }
  })
  const visibleProviders = providers.slice(0, MAX_VISIBLE_PROVIDER_STRINGS)
  const hiddenProviderCount = providers.length - visibleProviders.length
  const accessibleProviderLabels = providers
    .map((provider) =>
      provider.title ? `${provider.providerLabel} / ${provider.title}` : provider.providerLabel
    )
    .join(', ')
  // No stage (R2) — same shape as User Fan-Out: lanes · providers only.
  const accessibleLabel = [laneLabel, accessibleProviderLabels].filter(Boolean).join(' · ')

  return (
    <div className="parallel-result-viewport-header" data-parallel-category={data.category}>
      <CollapsedTranscriptRow
        header={null}
        metaLabel={metaLabel}
        label={accessibleLabel}
        labelContent={
          <>
            <span className="ensemble-fanout-viewport-count">{laneLabel}</span>
            {visibleProviders.length > 0 ? (
              <span className="ensemble-fanout-viewport-providers">
                <span aria-hidden="true"> · </span>
                {visibleProviders.map((provider, index) => (
                  <span key={provider.subThreadId || `${provider.provider}:${index}`}>
                    {index > 0 ? <span aria-hidden="true"> / </span> : null}
                    <span
                      className={`ensemble-fanout-viewport-provider provider-${provider.hueClass}`}
                      data-provider={provider.provider}
                      data-provider-hue={provider.hueClass}
                      style={
                        {
                          '--ensemble-fanout-viewport-provider-accent': `var(--provider-${provider.hueClass}-color, var(--accent))`
                        } as CSSProperties
                      }
                      title={[provider.providerLabel, provider.title].filter(Boolean).join(' / ')}
                    >
                      {provider.providerLabel}
                      {provider.title ? ` / ${provider.title}` : ''}
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
        icons={
          <span className="ensemble-fanout-viewport-glyph" aria-hidden="true">
            <ToolFamilyIcon
              family="subthread"
              size={18}
              className="ensemble-fanout-viewport-glyph-icon"
            />
          </span>
        }
        expanded={data.expanded}
        onToggle={(expanded) => onSetExpanded(data.viewportId, expanded)}
        ariaTargetLabel={`${metaLabel} with ${laneLabel}`}
      />
    </div>
  )
}
