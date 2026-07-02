import React from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import type {
  ContextCompactionSignalKind,
  ContextCompactionTelemetry
} from '../../../shared/contextCompaction'
import { CONTEXT_COMPACTION_MESSAGE_KIND } from '../../../shared/contextCompaction'
import { formatContextTokens } from '../../../shared/contextWindows'
import { getProviderName, ProviderBadgeIcon } from './Sidebar'

/**
 * Context-compaction card — the transcript record of a provider (or the host)
 * shrinking a session's live context. Follows the ParticipantHealthCard
 * conventions: inline glass card, provider-tinted chip, and FROZEN
 * presentation — participant labels are stamped on the message when the card
 * is written (`displayParticipantLabel`) and never re-derived from the live
 * roster.
 *
 * Data contract: `message.metadata.kind === 'contextCompaction'` with
 * `metadata.contextCompaction = { kind, telemetry }` (src/shared/contextCompaction.ts).
 */

interface ContextCompactionCardProps {
  message: ChatMessage
}

function compactionIcon(failed: boolean): React.JSX.Element {
  if (failed) {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M7 1.5L13 12H1L7 1.5Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M7 5.5V8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="7" cy="10" r="0.6" fill="currentColor" />
      </svg>
    )
  }
  // Arrows folding inward — same glyph language as the slash menu's compact icon.
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M5.5 1.5V5.5H1.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 12.5V8.5H12.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5.5 5.5L1.8 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8.5 8.5L12.2 12.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function ContextCompactionCard({
  message
}: ContextCompactionCardProps): React.JSX.Element | null {
  const metadata = message.metadata
  if (!metadata || metadata.kind !== CONTEXT_COMPACTION_MESSAGE_KIND) return null
  const record =
    metadata.contextCompaction && typeof metadata.contextCompaction === 'object'
      ? (metadata.contextCompaction as {
          kind?: ContextCompactionSignalKind
          telemetry?: ContextCompactionTelemetry
        })
      : null
  const kind: ContextCompactionSignalKind = record?.kind === 'failed' ? 'failed' : 'completed'
  const telemetry = record?.telemetry || {}
  const failed = kind === 'failed'
  const provider = (telemetry.provider || metadata.provider) as ProviderId | undefined
  // Frozen at write time (ensemble cards) — never recomputed from the roster.
  const participantLabel =
    typeof metadata.displayParticipantLabel === 'string' ? metadata.displayParticipantLabel : ''

  const detailParts: string[] = []
  if (telemetry.preTokens !== undefined && telemetry.postTokens !== undefined) {
    detailParts.push(
      `${formatContextTokens(telemetry.preTokens)} → ${formatContextTokens(telemetry.postTokens)} tokens`
    )
  } else if (telemetry.postTokens !== undefined) {
    detailParts.push(`now ${formatContextTokens(telemetry.postTokens)} tokens`)
  } else if (telemetry.preTokens !== undefined) {
    detailParts.push(`from ${formatContextTokens(telemetry.preTokens)} tokens`)
  }
  if (telemetry.trigger) detailParts.push(telemetry.trigger === 'auto' ? 'automatic' : 'manual')
  if (typeof telemetry.durationMs === 'number' && telemetry.durationMs >= 1000) {
    detailParts.push(`${Math.round(telemetry.durationMs / 1000)}s`)
  }

  const title = failed ? 'Context compaction failed' : 'Context compacted'
  const ariaLabel = [title, detailParts.join(' · ')].filter(Boolean).join(' — ')

  return (
    <div
      className={`context-compaction-card ${failed ? 'is-failed' : 'is-completed'}`}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="context-compaction-card-header">
        <span className="context-compaction-card-icon" aria-hidden="true">
          {compactionIcon(failed)}
        </span>
        <span className="context-compaction-card-title">{title}</span>
        {detailParts.length > 0 && (
          <span className="context-compaction-card-detail">{detailParts.join(' · ')}</span>
        )}
        {provider && (
          <span className={`context-compaction-card-provider provider-${provider}`}>
            <ProviderBadgeIcon provider={provider} />
            <span className="context-compaction-card-provider-label">
              {participantLabel || getProviderName(provider)}
            </span>
          </span>
        )}
      </div>
      {failed && telemetry.error && (
        <div className="context-compaction-card-error">{telemetry.error}</div>
      )}
    </div>
  )
}
