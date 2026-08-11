import { useEffect, useRef, useState } from 'react'
import type {
  BlackboardEntry,
  ChatRecord,
  PinnedMessageSummary
} from '../../../main/store/types'
import { BlackboardGroupedList, buildBlackboardGroups } from './BlackboardEntryCard'
import { BlackboardImageAttachmentPicker } from './BlackboardImageAttachmentPicker'
import { MarkdownMessage } from './MarkdownMessage'

// Grouping/order/sort helpers moved to the shared BlackboardEntryCard module
// (the composer popover renders the same cards); re-exported for compat.
export {
  BLACKBOARD_CATEGORY_LABELS,
  BLACKBOARD_CATEGORY_ORDER,
  sortBlackboardEntries
} from './BlackboardEntryCard'

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

function TrashMiniIcon(): React.JSX.Element {
  return (
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
  )
}

function BlackboardSection({
  chat,
  entries
}: {
  chat: ChatRecord | null
  entries: BlackboardEntry[]
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [imagePaths, setImagePaths] = useState<string[]>([])
  const [posting, setPosting] = useState(false)
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null)
  const [clearingAll, setClearingAll] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const canPost = Boolean(chat?.appChatId && chat?.ensemble)
  const grouped = buildBlackboardGroups(entries)
  const visibleCount = grouped.reduce((total, group) => total + group.entries.length, 0)
  const draftValue = draft.trim()
  useEffect(() => {
    setImagePaths([])
    setActionError(null)
  }, [chat?.appChatId])
  const submitPost = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!chat?.appChatId || !draftValue || posting) return
    setPosting(true)
    setActionError(null)
    try {
      await window.api.postBlackboardEntry({
        chatId: chat.appChatId,
        value: draftValue,
        category: 'note',
        scope: 'session',
        ...(imagePaths.length > 0 ? { imagePaths } : {})
      })
      setDraft('')
      setImagePaths([])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPosting(false)
    }
  }
  const deleteEntry = async (entry: BlackboardEntry) => {
    if (!chat?.appChatId || deletingEntryId || clearingAll) return
    const confirmed = window.confirm(`Delete "${entry.key}" from the Blackboard?`)
    if (!confirmed) return
    setDeletingEntryId(entry.id)
    setActionError(null)
    try {
      await window.api.deleteBlackboardEntry({
        chatId: chat.appChatId,
        entryId: entry.id
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingEntryId(null)
    }
  }
  const clearAllEntries = async () => {
    if (!chat?.appChatId || visibleCount === 0 || deletingEntryId || clearingAll) return
    const confirmed = window.confirm(
      `Delete all ${visibleCount} Blackboard ${visibleCount === 1 ? 'entry' : 'entries'}? This cannot be undone.`
    )
    if (!confirmed) return
    setClearingAll(true)
    setActionError(null)
    try {
      await window.api.clearBlackboardEntries({ chatId: chat.appChatId })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setClearingAll(false)
    }
  }

  return (
    <section className="pinned-blackboard-block" aria-label="Blackboard">
      <div className="pinned-section-heading">
        <span>Blackboard</span>
        {visibleCount > 0 && <small>{visibleCount}</small>}
        {canPost && visibleCount > 0 && (
          <button
            type="button"
            className="pinned-blackboard-clear-all"
            onClick={clearAllEntries}
            disabled={deletingEntryId !== null || clearingAll}
            title={clearingAll ? 'Deleting all entries...' : 'Delete all Blackboard entries'}
          >
            {clearingAll ? 'Deleting...' : 'Delete all'}
          </button>
        )}
      </div>
      {canPost && (
        <form className="pinned-blackboard-compose" onSubmit={submitPost}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Post to blackboard..."
            rows={2}
          />
          <BlackboardImageAttachmentPicker
            paths={imagePaths}
            disabled={posting}
            onChange={setImagePaths}
            onError={setActionError}
          />
          <button type="submit" disabled={!draftValue || posting}>
            {posting ? 'Posting' : 'Post'}
          </button>
          {actionError && <small className="pinned-blackboard-post-error">{actionError}</small>}
        </form>
      )}
      {!canPost && actionError && (
        <small className="pinned-blackboard-post-error">{actionError}</small>
      )}
      {visibleCount === 0 ? (
        <div className="right-dock-empty pinned-blackboard-empty">No blackboard entries.</div>
      ) : (
        <div className="pinned-blackboard-list">
          <BlackboardGroupedList
            chat={chat}
            groups={grouped}
            variant="panel"
            showSeenBy
            renderEntryActions={(entry) =>
              canPost ? (
                <button
                  type="button"
                  className="pinned-blackboard-entry-delete"
                  onClick={() => deleteEntry(entry)}
                  disabled={deletingEntryId !== null || clearingAll}
                  title={deletingEntryId === entry.id ? 'Deleting...' : 'Delete blackboard entry'}
                  aria-label={`Delete blackboard entry ${entry.key}`}
                >
                  <TrashMiniIcon />
                </button>
              ) : null
            }
          />
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
