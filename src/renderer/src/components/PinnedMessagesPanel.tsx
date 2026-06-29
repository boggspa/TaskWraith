import { useEffect, useRef, useState } from 'react'
import type { BlackboardEntry, ChatRecord, PinnedMessageSummary } from '../../../main/store/types'
import { MarkdownMessage } from './MarkdownMessage'

interface PinnedMessagesPanelProps {
  chat: ChatRecord | null
  blackboardEntries: BlackboardEntry[]
  messages: PinnedMessageSummary[]
  notes: string
  onNotesChange: (value: string) => void
  onCopyMessage: (messageId: string, content: string) => void
  onJumpToMessage: (messageId: string) => void
  onUnpinMessage: (messageId: string) => void
  onAddPinnedMessageToWorkspaceBoard?: (message: PinnedMessageSummary) => void
}

const BLACKBOARD_CATEGORY_ORDER: BlackboardEntry['category'][] = [
  'decision',
  'fact',
  'risk',
  'do-not-repeat',
  'note'
]

const BLACKBOARD_CATEGORY_LABELS: Record<BlackboardEntry['category'], string> = {
  decision: 'Decisions',
  fact: 'Facts',
  risk: 'Risks',
  'do-not-repeat': 'Do not repeat',
  note: 'Notes'
}

function sortBlackboardEntries(a: BlackboardEntry, b: BlackboardEntry): number {
  const categoryRank =
    BLACKBOARD_CATEGORY_ORDER.indexOf(a.category) - BLACKBOARD_CATEGORY_ORDER.indexOf(b.category)
  if (categoryRank !== 0) return categoryRank
  return (b.createdAt || '').localeCompare(a.createdAt || '')
}

function formatPinnedTimestamp(value: number): string {
  if (!Number.isFinite(value)) return ''
  try {
    return new Date(value).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function PinMiniIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5.2 2.4h5.6l-.8 4 2.1 2.1v1.3H8.7L8 13.6l-.7-3.8H3.9V8.5L6 6.4z" />
    </svg>
  )
}

function CopyMiniIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M3 11V3.5C3 2.67 3.67 2 4.5 2H11" />
    </svg>
  )
}

function JumpMiniIcon(): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 3.2h6.8v6.8" />
      <path d="M12.5 3.5 5.2 10.8" />
      <path d="M3.2 6.5v7.3h7.3" />
    </svg>
  )
}

function BlackboardSection({
  chat,
  entries
}: {
  chat: ChatRecord | null
  entries: BlackboardEntry[]
}): React.JSX.Element {
  const visibleEntries = entries
    .filter((entry) => entry.key.trim() && entry.value.trim())
    .sort(sortBlackboardEntries)

  const grouped = BLACKBOARD_CATEGORY_ORDER.map((category) => ({
    category,
    entries: visibleEntries.filter((entry) => entry.category === category)
  })).filter((group) => group.entries.length > 0)

  return (
    <section className="pinned-blackboard-block" aria-label="Blackboard">
      <div className="pinned-section-heading">
        <span>Blackboard</span>
        {visibleEntries.length > 0 && <small>{visibleEntries.length}</small>}
      </div>
      {visibleEntries.length === 0 ? (
        <div className="right-dock-empty pinned-blackboard-empty">No blackboard entries.</div>
      ) : (
        <div className="pinned-blackboard-list">
          {grouped.map((group) => (
            <div key={group.category} className="pinned-blackboard-group">
              <div className="pinned-blackboard-category">
                {BLACKBOARD_CATEGORY_LABELS[group.category]}
              </div>
              {group.entries.map((entry) => (
                <article
                  key={entry.id}
                  className={`pinned-blackboard-entry category-${entry.category}`}
                >
                  <div className="pinned-blackboard-entry-meta">
                    <strong>{entry.key}</strong>
                    <span>{entry.scope}</span>
                  </div>
                  <div className="pinned-blackboard-entry-body">
                    <MarkdownMessage content={entry.value} chat={chat || undefined} />
                  </div>
                  {entry.participantId && (
                    <div className="pinned-blackboard-author">{entry.participantId}</div>
                  )}
                </article>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export function PinnedMessagesPanel({
  chat,
  blackboardEntries,
  messages,
  notes,
  onNotesChange,
  onCopyMessage,
  onJumpToMessage,
  onUnpinMessage,
  onAddPinnedMessageToWorkspaceBoard
}: PinnedMessagesPanelProps): React.JSX.Element {
  const [draftNotes, setDraftNotes] = useState(notes)
  const skipDraftSaveRef = useRef(true)

  useEffect(() => {
    setDraftNotes(notes)
    skipDraftSaveRef.current = true
  }, [chat?.appChatId, notes])

  useEffect(() => {
    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false
      return
    }
    const timeout = window.setTimeout(() => {
      if (draftNotes !== notes) onNotesChange(draftNotes)
    }, 450)
    return () => window.clearTimeout(timeout)
  }, [draftNotes, notes, onNotesChange])

  return (
    <div className="right-dock-pins-panel">
      <header className="right-dock-panel-header pinned-messages-header">
        <div>
          <span className="right-dock-kicker">Notes</span>
          <strong>{chat?.title || 'Pinned messages'}</strong>
        </div>
      </header>

      <BlackboardSection chat={chat} entries={blackboardEntries} />

      <label className="pinned-notes-block">
        <span>Notes</span>
        <textarea
          value={draftNotes}
          onChange={(event) => setDraftNotes(event.target.value)}
          placeholder="Thread notes..."
          rows={5}
        />
      </label>

      {messages.length === 0 ? (
        <div className="right-dock-empty">No pinned messages in this thread.</div>
      ) : (
        <div className="pinned-message-list">
          {messages.map((message) => (
            <article key={message.id} className={`pinned-message-card role-${message.role}`}>
              <div className="pinned-message-card-meta">
                <span className="pinned-message-role">{message.role}</span>
                <span>{formatPinnedTimestamp(message.pinnedAt)}</span>
              </div>
              <div className="pinned-message-card-body">
                <MarkdownMessage content={message.content} chat={chat || undefined} />
              </div>
              <div className="pinned-message-card-actions">
                <button
                  type="button"
                  onClick={() => onCopyMessage(message.id, message.content)}
                  title="Copy pinned message"
                  aria-label="Copy pinned message"
                >
                  <CopyMiniIcon />
                </button>
                <button
                  type="button"
                  onClick={() => onJumpToMessage(message.id)}
                  title="Jump to message"
                  aria-label="Jump to message"
                >
                  <JumpMiniIcon />
                </button>
                <button
                  type="button"
                  onClick={() => onUnpinMessage(message.id)}
                  title="Unpin message"
                  aria-label="Unpin message"
                >
                  <PinMiniIcon />
                </button>
                {onAddPinnedMessageToWorkspaceBoard && chat?.workspaceId && (
                  <button
                    type="button"
                    onClick={() => onAddPinnedMessageToWorkspaceBoard(message)}
                    title="Add pinned message to workspace board"
                    aria-label="Add pinned message to workspace board"
                  >
                    #
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
