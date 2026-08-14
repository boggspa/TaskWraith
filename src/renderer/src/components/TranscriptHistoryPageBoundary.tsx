import type { ReactElement } from 'react'
import type { ChatMessage } from '../../../main/store/types'
import type { ChatTranscriptPayload } from '../lib/chatTranscriptStore'

export type TranscriptHistoryPageDirection = 'older' | 'newer'

export interface TranscriptHistoryPageBoundaryData {
  direction: TranscriptHistoryPageDirection
  hiddenCount: number
}

export function readTranscriptHistoryPageBoundary(
  message: ChatMessage
): TranscriptHistoryPageBoundaryData | null {
  if (message.metadata?.kind !== 'transcriptHistoryPageBoundary') return null
  const direction = message.metadata.transcriptHistoryDirection
  const hiddenCount = message.metadata.transcriptHistoryHiddenCount
  if (
    (direction !== 'older' && direction !== 'newer') ||
    typeof hiddenCount !== 'number' ||
    !Number.isFinite(hiddenCount) ||
    hiddenCount <= 0
  ) {
    return null
  }
  return { direction, hiddenCount: Math.floor(hiddenCount) }
}

export function buildTranscriptHistoryPageBoundaryMessages(
  payload: Pick<
    ChatTranscriptPayload,
    'hasOlder' | 'hasNewer' | 'windowStart' | 'windowEnd' | 'totalMessageCount'
  >
): { older: ChatMessage | null; newer: ChatMessage | null } {
  const boundary = (
    direction: TranscriptHistoryPageDirection,
    hiddenCount: number,
    edge: number
  ): ChatMessage => ({
    id: `transcript-history-${direction}-${edge}`,
    role: 'system',
    content: '',
    timestamp: '1970-01-01T00:00:00.000Z',
    metadata: {
      kind: 'transcriptHistoryPageBoundary',
      transcriptHistoryDirection: direction,
      transcriptHistoryHiddenCount: hiddenCount
    }
  })
  return {
    older: payload.hasOlder ? boundary('older', payload.windowStart, payload.windowStart) : null,
    newer: payload.hasNewer
      ? boundary(
          'newer',
          Math.max(0, payload.totalMessageCount - payload.windowEnd),
          payload.windowEnd
        )
      : null
  }
}

export function TranscriptHistoryPageBoundary({
  data,
  onOlder,
  onNewer,
  onLatest
}: {
  data: TranscriptHistoryPageBoundaryData
  onOlder: () => void
  onNewer: () => void
  onLatest: () => void
}): ReactElement {
  const eventLabel = data.hiddenCount === 1 ? 'event' : 'events'
  return (
    <div className="transcript-history-page-card" role="status">
      <span>
        {data.hiddenCount.toLocaleString()} {data.direction} {eventLabel} kept outside this page
      </span>
      <div className="transcript-history-page-actions">
        {data.direction === 'older' ? (
          <button type="button" onClick={onOlder}>
            Load previous page
          </button>
        ) : (
          <>
            <button type="button" onClick={onNewer}>
              Load next page
            </button>
            <button type="button" onClick={onLatest}>
              Return to latest
            </button>
          </>
        )}
      </div>
    </div>
  )
}
