import type { ReactElement } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  ensembleFanoutViewportStageLabel,
  readEnsembleFanoutViewportHeader
} from '../lib/ensembleFanoutViewportGroups'
import { CollapsedTranscriptRow } from './CollapsedTranscriptRow'
import {
  EnsembleFanoutProviderStrip,
  ensembleFanoutProviderAccessibleLabels,
  resolveEnsembleFanoutProviderPresentations
} from './EnsembleFanoutProviderStrip'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'

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
  const isUserFanout =
    data.category === 'user' || data.dispatchLabel?.trim().toLowerCase() === 'user fan-out'
  const metaLabel = isUserFanout ? 'User Fan-Out' : 'Fan-Out'
  const laneLabel = `${data.laneCount} ${data.laneCount === 1 ? 'lane' : 'lanes'}`
  const providers = resolveEnsembleFanoutProviderPresentations(data.attributions)
  const accessibleProviderLabels = ensembleFanoutProviderAccessibleLabels(providers)
  const accessibleLabel = [isUserFanout ? null : stageLabel, laneLabel, accessibleProviderLabels]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className={`ensemble-fanout-viewport-header is-${data.stage}`}
      data-fanout-stage={data.stage}
      data-fanout-category={isUserFanout ? 'user' : 'orchestrated'}
    >
      <CollapsedTranscriptRow
        header={null}
        metaLabel={metaLabel}
        label={accessibleLabel}
        labelContent={
          <>
            {!isUserFanout ? (
              <span
                className={`ensemble-fanout-viewport-stage is-${data.stage}`}
                title={data.dispatchLabel || `${stageLabel} fan-out`}
              >
                {stageLabel}
              </span>
            ) : null}
            <span className="ensemble-fanout-viewport-count">
              {isUserFanout ? laneLabel : ` · ${laneLabel}`}
            </span>
            <EnsembleFanoutProviderStrip providers={providers} />
          </>
        }
        compact
        icons={
          <span className="ensemble-fanout-viewport-glyph" aria-hidden="true">
            <ToolFamilyIcon
              family="fanout"
              size={18}
              className="ensemble-fanout-viewport-glyph-icon"
            />
          </span>
        }
        expanded={data.expanded}
        onToggle={(expanded) => onSetExpanded(data.viewportId, expanded)}
        ariaTargetLabel={
          isUserFanout
            ? `User Fan-Out with ${laneLabel}`
            : `${stageLabel} fan-out with ${laneLabel}`
        }
      />
    </div>
  )
}
