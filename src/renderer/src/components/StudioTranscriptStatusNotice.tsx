import React, { useEffect, useState } from 'react'
import type { StudioTranscriptStatus } from '../../../shared/studioTranscriptStatus'

export function latestStudioTranscriptStatus(
  current: StudioTranscriptStatus | null,
  incoming: StudioTranscriptStatus
): StudioTranscriptStatus {
  return current && current.updatedAt > incoming.updatedAt ? current : incoming
}

export function StudioTranscriptStatusCard({
  status
}: {
  status: StudioTranscriptStatus
}): React.JSX.Element {
  const unavailable = status.state === 'unavailable'
  const title =
    status.state === 'pending'
      ? 'Studio transcript'
      : status.state === 'available'
        ? 'Studio transcript ready'
        : 'Studio transcript unavailable'
  return (
    <div
      className={
        'notification-card studio-transcript-status ' +
        (unavailable ? 'notification-card--danger' : 'notification-card--default')
      }
      data-studio-transcript-state={status.state}
      data-studio-transcript-code={status.code ?? ''}
      data-studio-transcript-asset-id={status.assetId}
      role="status"
      aria-live={unavailable ? 'assertive' : 'polite'}
    >
      <span className="notification-card-icon" aria-hidden>
        {unavailable ? 'ⓘ' : '✦'}
      </span>
      <p className="notification-card-text">
        <strong>{title}</strong> {status.message}
      </p>
    </div>
  )
}

export function StudioTranscriptStatusNotice(): React.JSX.Element | null {
  const [status, setStatus] = useState<StudioTranscriptStatus | null>(null)

  useEffect(() => {
    const subscribe = window.api?.onStudioTranscriptStatus
    if (!subscribe) return
    return subscribe((incoming) =>
      setStatus((current) => latestStudioTranscriptStatus(current, incoming))
    )
  }, [])

  return status ? <StudioTranscriptStatusCard status={status} /> : null
}
