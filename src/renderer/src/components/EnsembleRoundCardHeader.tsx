import React from 'react'
import type { CSSProperties } from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import { readEnsembleRoundHeader } from '../lib/ensembleRoundCards'
import { resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
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
 * Collapsed: "Round N / M", participant provider pills, body message count,
 * and a one-line summary (synthesizer summary when available, else the round's
 * prompt preview). The row stays visually satellite; `aria-expanded` carries
 * the disclosure state without a decorative leading marker.
 *
 * Expanded: the same slim row anchors the round and offers a way to collapse
 * it again; the round's body messages render below it.
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
  const attributions =
    data.attributions && data.attributions.length > 0
      ? data.attributions
      : providers.map((provider, index) => ({
          participantId: null,
          provider,
          role: roles[index] || null,
          model: null
        }))
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
        <span className="ensemble-round-card-index">
          Round {roundIndex}
          {roundCount > 1 && (
            <span className="ensemble-round-card-index-total"> / {roundCount}</span>
          )}
        </span>
        {attributions.length > 0 && (
          <span className="ensemble-round-card-providers" aria-hidden="true">
            {attributions.map((attribution, index) => {
              const provider = attribution.provider as ProviderId
              const hueClass = resolveProviderHueClass(provider, attribution.model)
              return (
                <span
                  key={
                    attribution.participantId ||
                    `${attribution.provider}:${attribution.model || ''}:${index}`
                  }
                  className={`ensemble-round-card-provider provider-${hueClass}`}
                  data-provider={attribution.provider}
                  data-provider-hue={hueClass}
                  data-model={attribution.model || undefined}
                  style={
                    {
                      '--ensemble-round-provider-accent': `var(--provider-${hueClass}-color, var(--accent))`
                    } as CSSProperties
                  }
                  title={
                    attribution.role
                      ? `${getProviderName(provider)} / ${attribution.role}`
                      : getProviderName(provider)
                  }
                >
                  <ProviderBadgeIcon provider={provider} />
                </span>
              )
            })}
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
