import React from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import type {
  ContextCompactionSignalKind,
  ContextCompactionTelemetry
} from '../../../shared/contextCompaction'
import { CONTEXT_COMPACTION_MESSAGE_KIND } from '../../../shared/contextCompaction'
import { formatContextTokens } from '../../../shared/contextWindows'
import { getProviderName } from './Sidebar'

/**
 * Context-compaction transcript row — the durable record of a provider (or the
 * host) shrinking a session's live context.
 *
 * Rendered in the TOOL-CALL idiom (one flowing line: glyph · speaker meta ·
 * title · tabular detail), NOT as a bordered banner card, so compaction reads
 * as part of the transcript's activity language at the same preserved
 * hierarchy as seat and handoff changes. Presentation stays FROZEN —
 * participant labels are stamped on the message when the row is written
 * (`displayParticipantLabel`) and never re-derived from the live roster.
 *
 * Data contract: `message.metadata.kind === 'contextCompaction'` with
 * `metadata.contextCompaction = { kind, telemetry }` (src/shared/contextCompaction.ts).
 */

interface ContextCompactionCardProps {
  message: ChatMessage
}

interface ContextCompactionRecordShape {
  kind: ContextCompactionSignalKind
  telemetry: ContextCompactionTelemetry
}

function contextCompactionRecord(message: ChatMessage): ContextCompactionRecordShape | null {
  const metadata = message.metadata
  if (!metadata || metadata.kind !== CONTEXT_COMPACTION_MESSAGE_KIND) return null
  const record =
    metadata.contextCompaction && typeof metadata.contextCompaction === 'object'
      ? (metadata.contextCompaction as {
          kind?: ContextCompactionSignalKind
          telemetry?: ContextCompactionTelemetry
        })
      : null
  return {
    kind: record?.kind === 'failed' ? 'failed' : 'completed',
    telemetry: record?.telemetry || {}
  }
}

/** True when a transcript message is a FAILED compaction record — drives the
 * warning tint on both the full row and its collapsed one-liner. */
export function contextCompactionMessageFailed(message: ChatMessage): boolean {
  return contextCompactionRecord(message)?.kind === 'failed'
}

/** Collapsed one-liner meta prefix: the frozen participant label when the row
 * belongs to an ensemble seat, else the provider name, else "System". */
export function contextCompactionMessageMetaLabel(message: ChatMessage): string {
  const metadata = message.metadata
  if (typeof metadata?.displayParticipantLabel === 'string' && metadata.displayParticipantLabel) {
    return metadata.displayParticipantLabel
  }
  const record = contextCompactionRecord(message)
  const provider = (record?.telemetry.provider || metadata?.provider) as ProviderId | undefined
  return provider ? getProviderName(provider) : 'System'
}

export function ContextCompactionGlyph({ failed }: { failed: boolean }): React.JSX.Element {
  if (failed) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
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
  const record = contextCompactionRecord(message)
  if (!record) return null
  const { telemetry } = record
  const failed = record.kind === 'failed'
  const provider = (telemetry.provider || message.metadata?.provider) as ProviderId | undefined
  const providerClass =
    typeof message.metadata?.displayHueClass === 'string' && message.metadata.displayHueClass
      ? message.metadata.displayHueClass
      : provider
  const metaLabel = contextCompactionMessageMetaLabel(message)

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

  const title = failed ? 'Context compaction failed' : 'Compacted context'
  const ariaLabel = [
    metaLabel,
    title,
    detailParts.join(' · '),
    failed ? telemetry.error : undefined
  ]
    .filter(Boolean)
    .join(' — ')

  return (
    <div
      className={`context-compaction-row ${failed ? 'is-failed' : 'is-completed'}${
        providerClass ? ` provider-${providerClass}` : ''
      }`}
      role="group"
      aria-label={ariaLabel}
    >
      <div className="context-compaction-row-line">
        <span className="context-compaction-row-icon" aria-hidden="true">
          <ContextCompactionGlyph failed={failed} />
        </span>
        <span className="context-compaction-row-meta">{metaLabel}</span>
        <span className="context-compaction-row-title">{title}</span>
        {detailParts.length > 0 && (
          <span className="context-compaction-row-detail">{detailParts.join(' · ')}</span>
        )}
      </div>
      {failed && telemetry.error && (
        <div className="context-compaction-row-error">{telemetry.error}</div>
      )}
    </div>
  )
}
