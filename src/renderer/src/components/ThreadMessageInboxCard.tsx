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

import type { CSSProperties } from 'react'
import {
  threadMessageCardModel,
  threadMessageIndicatorModel,
  type ThreadMessageCardInput,
  type ThreadMessageIndicatorModel
} from './ThreadMessageInboxModel'
import type { ThreadMessageInboxSummary } from '../../../shared/threadMessage'
import { assignAgentIdentityFromSeed } from '../lib/agentIdentitySeed'
import { AgentIdentityIcon } from './icons/AgentIdentityIcon'
import { LiveActivityViewport } from './LiveActivityViewport'
import { SeatStateChips, seatAccentVar } from './SeatChangeRow'

interface ThreadMessageInboxCardProps {
  message: ThreadMessageCardInput
  /**
   * Open the sending thread. Optional: where it is absent the name renders as
   * plain text rather than a dead affordance — a control that looks clickable
   * and is not is the same defect as a chevron promising a disclosure that does
   * not exist.
   */
  onOpenSenderThread?: (chatId: string) => void
}

export function ThreadMessageInboxCard({
  message,
  onOpenSenderThread
}: ThreadMessageInboxCardProps) {
  const model = threadMessageCardModel(message)
  // A peer thread keeps one visual identity everywhere this inbox is rendered.
  // The chat id is stable and display-only here; routing still uses the durable
  // message record in main, never anything rendered into this card.
  const peerIdentity = assignAgentIdentityFromSeed(message.fromChatId)
  // The seat's own hue, so line 1's lead matches the chips beneath it. Taken
  // from `seatAccentVar` rather than re-derived: the hue resolves from the
  // HUMANISED model label, so re-deriving it silently diverges for Ollama and
  // Pi seats, which wear their upstream brand's colour.
  const leadAccent = model.seat ? seatAccentVar(model.seat) : undefined
  const canOpenSender = Boolean(onOpenSenderThread && message.fromChatId)
  return (
    <article
      className="thread-message-card"
      data-attribution={model.attribution}
      data-wake={model.requestsWake ? 'true' : 'false'}
      aria-label={model.headerText}
      style={{ ['--peer-rim']: peerIdentity.accent } as CSSProperties}
    >
      <header className="thread-message-card-header">
        <div className="thread-message-card-heading">
          <span className="thread-message-card-identity">
            <AgentIdentityIcon
              name={peerIdentity.key}
              color={peerIdentity.accent}
              size={22}
              className="thread-message-card-identity-icon"
              title={`Peer thread “${model.senderLabel}”`}
            />
          </span>
          <div className="thread-message-card-heading-stack">
            <div className="thread-message-card-heading-lead">
              <span className="thread-message-card-lead" style={{ color: leadAccent }}>
                {model.leadLabel}
              </span>
              <span className="thread-message-card-from">from</span>
              {canOpenSender ? (
                <button
                  type="button"
                  className="thread-message-card-sender is-interactive"
                  title={`Open “${model.senderLabel}”`}
                  onClick={() => onOpenSenderThread?.(message.fromChatId)}
                >
                  {model.senderLabel}
                </button>
              ) : (
                <span className="thread-message-card-sender">{model.senderLabel}</span>
              )}
            </div>
            {model.seat ? (
              <div className="thread-message-card-heading-config">
                <SeatStateChips seat={model.seat} className="thread-message-seat" />
              </div>
            ) : null}
          </div>
        </div>
        {model.requestsWake ? (
          <span className="thread-message-card-badge" title="This sender asked to start a turn now">
            asks to run now
          </span>
        ) : null}
      </header>
      <div className="thread-message-card-content">
        <LiveActivityViewport
          className="thread-message-card-viewport"
          revision={`${model.id}:${model.body.length}:${model.truncated ? 'truncated' : 'complete'}`}
          collapsedMaxHeight={220}
          label={`Peer message from ${model.senderLabel}`}
          expandLabel="Expand peer message"
          collapseLabel="Collapse peer message"
          jumpLabel="Jump to latest peer message"
        >
          <div className="thread-message-card-body-inner">
            {/* Plain text on purpose — see the module comment. */}
            <div className="thread-message-card-body">{model.body}</div>
            {model.truncated ? (
              <div className="thread-message-card-note">
                This message was longer than the limit and was cut short.
              </div>
            ) : null}
          </div>
        </LiveActivityViewport>
      </div>
    </article>
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
