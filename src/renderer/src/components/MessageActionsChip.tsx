/**
 * 1.0.4-AQ4 — small message action group. Initially rendered as a
 * hover-only bubble overlay; now used as the inline footer action row
 * under transcript messages too. Icon-only buttons:
 *   • Copy — writes the bubble's content to the clipboard via the
 *     `onCopy` callback (host calls `navigator.clipboard.writeText`).
 *   • Add to prompt — appends the bubble's content to the composer draft via
 *     the `onAddToPrompt` callback.
 *   • Delete — calls the `onDelete` callback (host gates with
 *     `confirm()` before removing the message from the transcript).
 *
 * Kept as a tiny inline component so the bubble render blocks
 * stay readable. Doesn't take the message directly — the parent
 * binds `msg.content` / `msg.id` into the callbacks so this
 * component stays role-agnostic.
 */
function MessageActionsChip({
  onCopy,
  onAddToPrompt,
  onTogglePin,
  onThumbsUp,
  onThumbsDown,
  onDelete,
  onOpenSideChat,
  pinned = false,
  thumbsVote = null,
  copied = false,
  label
}: {
  onCopy: () => void
  onAddToPrompt?: () => void
  onTogglePin?: () => void
  /** Thumbs feedback (assistant messages only — the host gates rendering). */
  onThumbsUp?: () => void
  onThumbsDown?: () => void
  onDelete?: () => void
  onOpenSideChat?: () => void
  pinned?: boolean
  /** Which thumb (if any) the user has set on this message. */
  thumbsVote?: 'up' | 'down' | null
  /** 1.0.8 — when true the copy button shows a transient confirmation
   * (driven by the host's shared `useCopyFeedback`). */
  copied?: boolean
  label: string
}): React.JSX.Element {
  return (
    <div className="message-actions-chip" role="group" aria-label={`Actions for ${label}`}>
      {onThumbsUp && (
        <button
          type="button"
          className={`message-actions-chip-button message-actions-chip-button--thumbs-up${
            thumbsVote === 'up' ? ' is-active' : ''
          }`}
          onClick={onThumbsUp}
          title={thumbsVote === 'up' ? 'Remove good rating' : 'Good response'}
          aria-label={thumbsVote === 'up' ? `Remove good rating on ${label}` : `Rate ${label} good`}
          aria-pressed={thumbsVote === 'up'}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill={thumbsVote === 'up' ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M7 10v12" />
            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
          </svg>
        </button>
      )}
      {onThumbsDown && (
        <button
          type="button"
          className={`message-actions-chip-button message-actions-chip-button--thumbs-down${
            thumbsVote === 'down' ? ' is-active' : ''
          }`}
          onClick={onThumbsDown}
          title={thumbsVote === 'down' ? 'Remove poor rating' : 'Poor response'}
          aria-label={thumbsVote === 'down' ? `Remove poor rating on ${label}` : `Rate ${label} poor`}
          aria-pressed={thumbsVote === 'down'}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill={thumbsVote === 'down' ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M17 14V2" />
            <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={`message-actions-chip-button message-actions-chip-button--copy${
          copied ? ' is-copied' : ''
        }`}
        onClick={onCopy}
        title={copied ? 'Copied' : 'Copy message content to clipboard'}
        aria-label={copied ? `Copied ${label} content` : `Copy ${label} content`}
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M13.5 4.5 6 12 2.5 8.5" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path d="M3 11V3.5C3 2.67 3.67 2 4.5 2H11" />
          </svg>
        )}
      </button>
      {onAddToPrompt && (
        <button
          type="button"
          className="message-actions-chip-button message-actions-chip-button--add-to-prompt"
          onClick={onAddToPrompt}
          title="Add to prompt"
          aria-label={`Add ${label} to prompt`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.45"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 13l3.1-.7 7-7a1.45 1.45 0 0 0 0-2.05l-.35-.35a1.45 1.45 0 0 0-2.05 0l-7 7z" />
            <path d="M9.75 3.85 12.15 6.25" />
            <path d="M3.75 9.8 6.2 12.25" />
          </svg>
        </button>
      )}
      {onTogglePin && (
        <button
          type="button"
          className={`message-actions-chip-button message-actions-chip-button--pin${
            pinned ? ' is-pinned' : ''
          }`}
          onClick={onTogglePin}
          title={pinned ? 'Unpin message' : 'Pin message'}
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
          aria-pressed={pinned}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill={pinned ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M5.2 2.4h5.6l-.8 4 2.1 2.1v1.3H8.7L8 13.6l-.7-3.8H3.9V8.5L6 6.4z" />
          </svg>
        </button>
      )}
      {onOpenSideChat && (
        <button
          type="button"
          className="message-actions-chip-button message-actions-chip-button--side-chat"
          onClick={onOpenSideChat}
          title="Open side chat from this message"
          aria-label={`Open side chat from ${label}`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
            <path d="M8 3.2v9.6" />
            <path d="M4.5 6h2" />
            <path d="M10 8.2h1.8" />
            <path d="M10 10.3h1.2" />
          </svg>
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          className="message-actions-chip-button message-actions-chip-button--delete"
          onClick={onDelete}
          title="Delete message from transcript"
          aria-label={`Delete ${label}`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M3 4h10" />
            <path d="M5.5 4V2.5C5.5 2.22 5.72 2 6 2h4c.28 0 .5.22.5.5V4" />
            <path d="M4.5 4l.5 9c.04.55.5 1 1 1h4c.5 0 .96-.45 1-1l.5-9" />
            <path d="M7 7v5" />
            <path d="M9 7v5" />
          </svg>
        </button>
      )}
    </div>
  )
}

export { MessageActionsChip }
