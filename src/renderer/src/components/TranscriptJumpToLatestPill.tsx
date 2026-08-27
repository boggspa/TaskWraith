import { DigitOdometer } from './DigitOdometer'

export interface TranscriptJumpToLatestPillProps {
  visible: boolean
  unreadCount: number
  provider: string
  onJumpToLatest: () => void
}

/**
 * Shared jump-to-latest affordance for every transcript surface. Visibility,
 * unread accounting, and the actual re-lock remain owned by that surface's
 * useTranscriptScrollState instance.
 */
export function TranscriptJumpToLatestPill({
  visible,
  unreadCount,
  provider,
  onJumpToLatest
}: TranscriptJumpToLatestPillProps) {
  if (!visible) return null

  const hasUnreadMessages = unreadCount > 0
  const messageLabel = `${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`

  return (
    <button
      type="button"
      className={`transcript-jump-to-latest-pill provider-${provider}`}
      onClick={onJumpToLatest}
      aria-label={
        hasUnreadMessages
          ? `Jump to latest — ${messageLabel}`
          : 'Jump to latest — response streaming below'
      }
      title={
        hasUnreadMessages
          ? `Jump to latest (End)\n${messageLabel}`
          : 'Jump to latest (End)\nResponse streaming below'
      }
    >
      <span aria-hidden="true" className="transcript-jump-to-latest-arrow">
        ↓
      </span>
      <span className="transcript-jump-to-latest-text">
        {hasUnreadMessages ? (
          <>
            <DigitOdometer
              value={unreadCount}
              ariaLabel={messageLabel}
              className="transcript-jump-to-latest-count"
            />
            <span aria-hidden> new {unreadCount === 1 ? 'message' : 'messages'}</span>
          </>
        ) : (
          'Jump to latest'
        )}
      </span>
    </button>
  )
}
