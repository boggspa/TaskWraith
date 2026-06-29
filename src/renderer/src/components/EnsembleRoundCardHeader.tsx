import React from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import { readEnsembleRoundHeader } from '../lib/ensembleRoundCards'
import { getProviderName, ProviderBadgeIcon } from './Sidebar'

/**
 * 1.0.5 — Ensemble round-card header.
 *
 * Renders the collapsible header bar for one COMPLETED ensemble round
 * (the data-layer + render-plan live in `lib/ensembleRoundGrouping.ts`
 * and `lib/ensembleRoundCards.ts`). The header is itself a synthetic
 * transcript row, so it participates in virtualization like any other
 * message block; this component only owns the bar's markup + the
 * expand/collapse affordance.
 *
 * Collapsed: chevron ▸, "Round N / M", participant provider pills, body
 * message count, and a one-line summary (synthesizer summary when
 * available, else the round's prompt preview).
 *
 * Expanded: a slim ▾ bar that anchors the round and offers a way to
 * collapse it again; the round's body messages render below it.
 */

interface EnsembleRoundCardHeaderProps {
  message: ChatMessage
  /** Sets the round's expanded state (true = show body). */
  onSetExpanded: (roundId: string, expanded: boolean) => void
}

export function EnsembleRoundCardHeader({
  message,
  onSetExpanded
}: EnsembleRoundCardHeaderProps): React.JSX.Element | null {
  const data = readEnsembleRoundHeader(message)
  if (!data) return null

  const { roundId, roundIndex, roundCount, expanded, providers, roles, bodyMessageCount } = data
  const summaryLine = data.summary || data.promptPreview || null

  const countLabel = `${bodyMessageCount} ${bodyMessageCount === 1 ? 'message' : 'messages'}`
  const ariaLabel = `Round ${roundIndex} of ${roundCount}, ${countLabel}. ${
    expanded ? 'Collapse round.' : 'Expand round.'
  }`

  return (
    <div
      className={`ensemble-round-card-header ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      role="group"
    >
      <button
        type="button"
        className="ensemble-round-card-toggle"
        onClick={() => onSetExpanded(roundId, !expanded)}
        aria-expanded={expanded}
        aria-label={ariaLabel}
        title={expanded ? 'Collapse round' : 'Expand round'}
      >
        <span className="ensemble-round-card-chevron" aria-hidden="true">
          {expanded ? '\u25BE' : '\u25B8'}
        </span>
        <span className="ensemble-round-card-index">
          Round {roundIndex}
          {roundCount > 1 && (
            <span className="ensemble-round-card-index-total"> / {roundCount}</span>
          )}
        </span>
        {providers.length > 0 && (
          <span className="ensemble-round-card-providers" aria-hidden="true">
            {providers.map((provider, i) => (
              <span
                key={provider}
                className={`ensemble-round-card-provider provider-${provider}`}
                title={
                  roles[i]
                    ? `${getProviderName(provider as ProviderId)} / ${roles[i]}`
                    : getProviderName(provider as ProviderId)
                }
              >
                <ProviderBadgeIcon provider={provider as ProviderId} />
              </span>
            ))}
          </span>
        )}
        <span className="ensemble-round-card-count">{countLabel}</span>
        {!expanded && summaryLine && (
          <span className="ensemble-round-card-summary">{summaryLine}</span>
        )}
      </button>
    </div>
  )
}
