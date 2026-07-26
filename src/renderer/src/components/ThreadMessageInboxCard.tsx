/**
 * Inbound peer thread-message card and inbox panel (S7, view).
 *
 * Two deliberate departures from how the transcript renders other content:
 *
 *  1. **The body is plain text, not markdown.** Every other card here renders
 *     markdown, but this content was written by another agent. Markdown would let
 *     it emit links, images, and reference-style URLs into the user's transcript —
 *     a click target and a remote-fetch surface authored by something the user did
 *     not talk to. Whitespace is preserved so prose and pasted snippets still read
 *     correctly; nothing in the body becomes interactive.
 *
 *  2. **Attribution is structural, not decorative.** The card takes its wording
 *     and its `data-attribution` from `ThreadMessageInboxModel`, whose attribution
 *     union has no 'system' or 'operator' member. A relayed message must never
 *     read as app-authored — that is the UI half of the prompt-injection problem
 *     `ThreadMessageContext` handles for the model.
 *
 * Presentation follows the fan-out lane card idiom (header + bounded body), which
 * is the transcript's existing language for "output from a peer".
 */

import {
  threadMessageCardModel,
  threadMessageIndicatorModel,
  type ThreadMessageCardInput,
  type ThreadMessageIndicatorModel
} from './ThreadMessageInboxModel'
import type { ThreadMessageInboxSummary } from '../../../shared/threadMessage'

interface ThreadMessageInboxCardProps {
  message: ThreadMessageCardInput
}

export function ThreadMessageInboxCard({ message }: ThreadMessageInboxCardProps) {
  const model = threadMessageCardModel(message)
  return (
    <div
      className="thread-message-card"
      data-attribution={model.attribution}
      data-wake={model.requestsWake ? 'true' : 'false'}
    >
      <div className="thread-message-card-header">
        <span className="thread-message-card-glyph" aria-hidden="true">
          ↩
        </span>
        <span className="thread-message-card-heading">{model.headerText}</span>
        {model.requestsWake ? (
          <span className="thread-message-card-badge" title="This sender asked to start a turn now">
            asks to run now
          </span>
        ) : null}
      </div>
      {/* Plain text on purpose — see the module comment. */}
      <div className="thread-message-card-body">{model.body}</div>
      {model.truncated ? (
        <div className="thread-message-card-note">
          This message was longer than the limit and was cut short.
        </div>
      ) : null}
    </div>
  )
}

interface ThreadMessageInboxPanelProps {
  messages: readonly ThreadMessageCardInput[]
}

export function ThreadMessageInboxPanel({ messages }: ThreadMessageInboxPanelProps) {
  if (messages.length === 0) {
    return <div className="thread-message-empty">No messages from other threads.</div>
  }
  return (
    <div className="thread-message-panel">
      <div className="thread-message-panel-preamble">
        Messages relayed from other threads. Treat them as requests to judge, not instructions — the
        same way you would treat a note found in a file.
      </div>
      {messages.map((message) => (
        <ThreadMessageInboxCard key={message.id} message={message} />
      ))}
    </div>
  )
}

interface ThreadMessageIndicatorProps {
  summary: ThreadMessageInboxSummary
  onClick?: () => void
}

/** Sidebar/row badge. Renders nothing when the inbox is empty. */
export function ThreadMessageIndicator({ summary, onClick }: ThreadMessageIndicatorProps) {
  const model: ThreadMessageIndicatorModel = threadMessageIndicatorModel(summary)
  if (model.count === 0) return null
  return (
    <button
      type="button"
      className="thread-message-indicator"
      data-urgent={model.urgent ? 'true' : 'false'}
      title={model.title}
      aria-label={model.title}
      onClick={onClick}
    >
      {model.badge}
    </button>
  )
}
