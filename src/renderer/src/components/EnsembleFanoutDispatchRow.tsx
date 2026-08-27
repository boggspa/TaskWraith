import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import {
  ensembleFanoutDispatchIntentCounts,
  isEnsembleFanoutDispatchPayload
} from '../../../shared/ensembleFanoutDispatch'
import { CollapsedTranscriptRow } from './CollapsedTranscriptRow'
import {
  EnsembleFanoutProviderStrip,
  ensembleFanoutProviderAccessibleLabels,
  resolveEnsembleFanoutProviderPresentations
} from './EnsembleFanoutProviderStrip'
import { ToolFamilyIcon } from './icons/ToolFamilyIcon'

/** Immediate dispatch receipt for a fan-out wave. Once lane results settle,
 * the existing viewport fold replaces this carrier with its durable disclosure. */
export function EnsembleFanoutDispatchRow({
  message
}: {
  message: ChatMessage
}): ReactElement | null {
  const candidate = message.metadata?.ensembleFanoutDispatch
  const payload = isEnsembleFanoutDispatchPayload(candidate) ? candidate : null
  const [expanded, setExpanded] = useState(false)
  const providers = useMemo(
    () =>
      resolveEnsembleFanoutProviderPresentations(
        (payload?.participants || []).map((participant) => ({
          participantId: participant.participantId,
          provider: participant.provider,
          role: participant.role,
          model: participant.model || null
        }))
      ),
    [payload]
  )

  if (!payload) return null

  const counts = ensembleFanoutDispatchIntentCounts(payload)
  const laneLabel = `${payload.participants.length} ${
    payload.participants.length === 1 ? 'lane' : 'lanes'
  }`
  const originLabel = payload.category === 'user' ? 'User-directed' : 'Orchestrated'
  const providerLabels = ensembleFanoutProviderAccessibleLabels(providers)
  const accessibleLabel = [payload.label, laneLabel, providerLabels].filter(Boolean).join(' · ')

  return (
    <div
      className={`ensemble-fanout-viewport-header ensemble-fanout-dispatch-message is-${payload.category}`}
      data-fanout-category={payload.category}
    >
      <CollapsedTranscriptRow
        header={null}
        metaLabel="Ensemble Fanout"
        label={accessibleLabel}
        labelContent={
          <>
            <span className="ensemble-fanout-dispatch-origin" title={payload.label}>
              {originLabel}
            </span>
            <span className="ensemble-fanout-viewport-count"> · {laneLabel}</span>
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
        expanded={expanded}
        onToggle={setExpanded}
        ariaTargetLabel={`Ensemble Fanout with ${laneLabel}`}
      >
        <div className="ensemble-fanout-dispatch-details">
          <div className="ensemble-fanout-dispatch-summary">
            {payload.label} · Dispatched concurrently · {counts.read} read · {counts.write}{' '}
            write-intent
          </div>
          {providers.map((provider, index) => {
            const participant = payload.participants[index]
            return (
              <div className="ensemble-fanout-dispatch-participant" key={participant.participantId}>
                <span
                  className={`ensemble-fanout-viewport-provider provider-${provider.hueClass}`}
                  style={
                    {
                      '--ensemble-fanout-viewport-provider-accent': `var(--provider-${provider.hueClass}-color, var(--accent))`
                    } as CSSProperties
                  }
                >
                  {provider.providerLabel} / {participant.role}
                </span>
                {participant.model ? (
                  <span className="ensemble-fanout-dispatch-model">{participant.model}</span>
                ) : null}
                <span className={`ensemble-fanout-dispatch-intent is-${participant.intent}`}>
                  {participant.intent === 'write' ? 'Write intent' : 'Read intent'}
                </span>
              </div>
            )
          })}
        </div>
      </CollapsedTranscriptRow>
    </div>
  )
}
