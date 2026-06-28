/**
 * 1.0.4-AQ4 — small message action group. Initially rendered as a
 * hover-only bubble overlay; now used as the inline footer action row
 * under transcript messages too. Icon-only buttons:
 *   • Copy — writes the bubble's content to the clipboard via the
 *     `onCopy` callback (host calls `navigator.clipboard.writeText`).
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
  onTogglePin,
  onDelete,
  onOpenSideChat,
  pinned = false,
  copied = false,
  label
}: {
  onCopy: () => void
  onTogglePin?: () => void
  onDelete?: () => void
  onOpenSideChat?: () => void
  pinned?: boolean
  /** 1.0.8 — when true the copy button shows a transient confirmation
   * (driven by the host's shared `useCopyFeedback`). */
  copied?: boolean
  label: string
}): React.JSX.Element {
  return (
    <div className="message-actions-chip" role="group" aria-label={`Actions for ${label}`}>
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
