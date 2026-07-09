import { useEffect, useRef, useState } from 'react'
import type {
  BlackboardEntry,
  ChatRecord,
  EnsembleParticipant,
  PinnedMessageSummary
} from '../../../main/store/types'
import { resolveProviderBrandLabel, resolveProviderHueClass } from '../lib/ollamaDisplayBrand'
import { ProviderGlyph } from './icons/ProviderGlyph'
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

export const BLACKBOARD_CATEGORY_ORDER: BlackboardEntry['category'][] = [
  'decision',
  'fact',
  'risk',
  'do-not-repeat',
  'note'
]

export const BLACKBOARD_CATEGORY_LABELS: Record<BlackboardEntry['category'], string> = {
  decision: 'Decisions',
  fact: 'Facts',
  risk: 'Risks',
  'do-not-repeat': 'Do not repeat',
  note: 'Notes'
}

export function sortBlackboardEntries(a: BlackboardEntry, b: BlackboardEntry): number {
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

function BossmanCrownIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden focusable="false">
      <path
        d="M4.7 17.8h14.6l1.2-9.1-4.8 3.4-3.7-6-3.7 6-4.8-3.4 1.2 9.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M5.4 20h13.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

function CaptainHatIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden focusable="false">
      <path
        d="M5.2 15.8c2.3 1.2 11.3 1.2 13.6 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M6.8 14.8 8 9.7c.3-1.1 1.2-1.8 2.3-1.8h3.4c1.1 0 2 .7 2.3 1.8l1.2 5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M9.3 8c.7-1.2 1.6-1.9 2.7-1.9s2 .7 2.7 1.9M10.1 11.4h3.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M4 16.4c1.9 1.3 4.6 2 8 2s6.1-.7 8-2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

function participantLabel(participant: EnsembleParticipant | undefined, participantId: string): string {
  if (participantId === 'user') return 'You'
  if (!participant) return participantId
  return (
    participant.role ||
    resolveProviderBrandLabel(participant.provider, participant.model) ||
    participant.provider
  )
}

function SeenByRail({
  chat,
  entry
}: {
  chat: ChatRecord | null
  entry: BlackboardEntry
}): React.JSX.Element | null {
  const seenBy = entry.seenBy || []
  if (seenBy.length === 0) return null
  const participants = chat?.ensemble?.participants || []
  const bossmanId = chat?.ensemble?.bossmanParticipantId
  const captainId = chat?.ensemble?.secondInCommandParticipantId
  const byId = new Map(participants.map((participant) => [participant.id, participant]))

  return (
    <div className="pinned-blackboard-seen-rail" aria-label="Seen by">
      {seenBy.slice(0, 12).map((participantId) => {
        const participant = byId.get(participantId)
        const providerClass = participant
          ? resolveProviderHueClass(participant.provider, participant.model)
          : participantId === 'user'
            ? 'user'
            : 'ensemble'
        const label = participantLabel(participant, participantId)
        const isBossman = participantId === bossmanId
        const isCaptain = participantId === captainId && !isBossman
        return (
          <span
            key={participantId}
            className={`pinned-blackboard-seen-chip provider-${providerClass}${
              participantId === 'user' ? ' is-user' : ''
            }`}
            style={{
              '--blackboard-seen-color': `var(--provider-${providerClass}-color, var(--accent))`
            } as React.CSSProperties}
            title={`${label} has seen this entry`}
            aria-label={`${label} has seen this entry`}
          >
            {participant ? (
              <ProviderGlyph
                provider={participant.provider}
                className="pinned-blackboard-seen-glyph"
              />
            ) : (
              <span className="pinned-blackboard-seen-initial" aria-hidden>
                {label.slice(0, 1).toUpperCase()}
              </span>
            )}
            <span>{label}</span>
            {isBossman && <BossmanCrownIcon />}
            {isCaptain && <CaptainHatIcon />}
          </span>
        )
      })}
      {seenBy.length > 12 && <span className="pinned-blackboard-seen-more">+{seenBy.length - 12}</span>}
    </div>
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
  const [posting, setPosting] = useState(false)
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const canPost = Boolean(chat?.appChatId && chat?.ensemble)
  const visibleEntries = entries
    .filter((entry) => entry.key.trim() && entry.value.trim())
    .sort(sortBlackboardEntries)

  const grouped = BLACKBOARD_CATEGORY_ORDER.map((category) => ({
    category,
    entries: visibleEntries.filter((entry) => entry.category === category)
  })).filter((group) => group.entries.length > 0)
  const draftValue = draft.trim()
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
        scope: 'session'
      })
      setDraft('')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPosting(false)
    }
  }
  const deleteEntry = async (entry: BlackboardEntry) => {
    if (!chat?.appChatId || deletingEntryId) return
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

  return (
    <section className="pinned-blackboard-block" aria-label="Blackboard">
      <div className="pinned-section-heading">
        <span>Blackboard</span>
        {visibleEntries.length > 0 && <small>{visibleEntries.length}</small>}
      </div>
      {canPost && (
        <form className="pinned-blackboard-compose" onSubmit={submitPost}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Post to blackboard..."
            rows={2}
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
                    <div className="pinned-blackboard-entry-actions">
                      <span>{entry.scope}</span>
                      {canPost && (
                        <button
                          type="button"
                          className="pinned-blackboard-entry-delete"
                          onClick={() => deleteEntry(entry)}
                          disabled={deletingEntryId !== null}
                          title={
                            deletingEntryId === entry.id
                              ? 'Deleting...'
                              : 'Delete blackboard entry'
                          }
                          aria-label={`Delete blackboard entry ${entry.key}`}
                        >
                          <TrashMiniIcon />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="pinned-blackboard-entry-body">
                    <MarkdownMessage content={entry.value} chat={chat || undefined} />
                  </div>
                  <SeenByRail chat={chat} entry={entry} />
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
