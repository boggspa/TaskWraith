import React from 'react'
import type { ChatMessage, ProviderId } from '../../../main/store/types'
import { getProviderName, ProviderBadgeIcon } from './Sidebar'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'

/**
 * 1.0.5-EW29 — Participant-health card.
 *
 * Replaces the pre-EW29 plain-text system-message rendering of
 * the per-round health pre-flight summary. Pre-EW29 the
 * orchestrator emitted a `\n`-joined string and the transcript
 * showed it as a muted "System" bubble — visually identical to
 * other system chrome, easy to skim past, and out of step with
 * the more deliberate visual treatment we give tool calls,
 * sub-thread cards, and ensemble parallel passes.
 *
 * EW29 keeps the same data (provider, role, status, optional
 * failure reason) but presents it as a compact card with a
 * one-line header and a chip strip — provider-tinted dots,
 * provider/role labels, and per-chip status icons. Failures
 * surface their underlying code + reason in the tooltip so the
 * user can hover to see "ECONNREFUSED — Codex app-server
 * socket unreachable" without leaving the transcript.
 *
 * The card stays inline in the transcript flow (no portal, no
 * floating positioning) so it scrolls with the conversation and
 * archives cleanly when the chat is exported.
 */

interface ParticipantHealthEntry {
  participantId: string
  provider: ProviderId
  model?: string
  role: string
  status: 'ok' | 'unreachable'
  reason?: string
  underlyingCode?: string
}

interface ParticipantHealthCardProps {
  message: ChatMessage
}

export function ParticipantHealthCard({
  message
}: ParticipantHealthCardProps): React.JSX.Element | null {
  const metadata = message.metadata
  if (!metadata || metadata.kind !== 'ensembleParticipantHealth') return null

  const entries = Array.isArray(metadata.entries)
    ? (metadata.entries as ParticipantHealthEntry[])
    : []
  if (entries.length === 0) return null

  const okCount = typeof metadata.okCount === 'number' ? metadata.okCount : 0
  const totalCount = typeof metadata.totalCount === 'number' ? metadata.totalCount : entries.length
  const allOk = okCount === totalCount

  return (
    <div
      className={`participant-health-card ${allOk ? 'all-ok' : 'has-failures'}`}
      role="group"
      aria-label={`Participant health: ${okCount} of ${totalCount} reachable`}
    >
      <div className="participant-health-card-header">
        <span className="participant-health-card-icon" aria-hidden="true">
          {allOk ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.4" />
              <path
                d="M4.5 7.2L6.2 8.9L9.5 5.4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
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
          )}
        </span>
        <span className="participant-health-card-title">
          {allOk ? 'Participants reachable' : 'Participant health'}
        </span>
        <span className="participant-health-card-count">
          {okCount}/{totalCount}
        </span>
      </div>
      <div className="participant-health-card-chips">
        {entries.map((entry) => {
          // Ollama-backed display brands spoof their upstream name + hue on
          // the chip (e.g. Alibaba / Planner in Alibaba purple), matching the
          // transcript header, run cards, and @-mention chips.
          const providerName =
            resolveProviderBrandLabel(entry.provider, entry.model) || getProviderName(entry.provider)
          const providerClass = resolveProviderHueClass(entry.provider, entry.model)
          const label = entry.role ? `${providerName} / ${entry.role}` : providerName
          const tooltip =
            entry.status === 'ok'
              ? `${label}: reachable`
              : `${label}: unreachable${entry.underlyingCode ? ` (${entry.underlyingCode})` : ''}${
                  entry.reason ? ` — ${entry.reason}` : ''
                }`
          // Surface the failure reason inline (not just in the
          // tooltip) for unreachable participants, so the user sees
          // WHY a participant is down without hovering. Prefer the
          // human-readable reason; fall back to the underlying code.
          const inlineReason =
            entry.status === 'unreachable' ? entry.reason || entry.underlyingCode || '' : ''
          return (
            <span
              key={entry.participantId}
              className={`participant-health-chip provider-${providerClass} status-${entry.status}`}
              title={tooltip}
              aria-label={tooltip}
            >
              <ProviderBadgeIcon provider={entry.provider} />
              <span className="participant-health-chip-label">{label}</span>
              {inlineReason && (
                <span
                  className="participant-health-chip-reason"
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    opacity: 0.75,
                    maxWidth: '22ch',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {inlineReason}
                </span>
              )}
              <span
                className={`participant-health-chip-status status-${entry.status}`}
                aria-hidden="true"
              >
                {entry.status === 'ok' ? '·' : '⚠'}
              </span>
            </span>
          )
        })}
      </div>
    </div>
  )
}
