import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatListItem, ChatRecord } from '../../../main/store/types'
import { HighlightMatch } from './HighlightMatch'

/**
 * `SidebarChatTitleEditable` — renders a chat's title with two modes:
 *
 *   - Display: `<HighlightMatch>` for search-term highlighting. Double-
 *     clicking the title enters edit mode. Plain row clicks still navigate,
 *     so rename stays deliberate without requiring a prior selection click.
 *   - Edit: an `<input>` with the current title pre-filled. Enter
 *     submits, Escape cancels, blur submits (matches Finder rename UX).
 *     We stopPropagation on click/mousedown so clicks inside the input
 *     don't re-fire the parent row's onClick handler.
 *
 * Used at all 6 chat-tile render sites (pinned, recents, ensembles
 * section, workspace-expanded parents, workspace-expanded sub-threads,
 * global chats). Each site passes its own outer span className so the
 * existing per-section styling rules (`.sidebar-pinned-label` /
 * `.sidebar-recents-label` / `.sidebar-chat-title`) keep working.
 */
export function SidebarChatTitleEditable({
  chat,
  className,
  query,
  isEditing,
  onStartEdit,
  onSubmit,
  onCancel
}: {
  chat: ChatRecord
  className: string
  query: string
  isSelected?: boolean
  isEditing: boolean
  onStartEdit: () => void
  onSubmit: (nextValue: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(chat.title)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const draftRef = useRef(chat.title)
  const editClosedRef = useRef(true)
  const wasEditingRef = useRef(false)
  const closeWithSubmit = useCallback(
    (nextValue?: string): void => {
      if (editClosedRef.current) return
      editClosedRef.current = true
      onSubmit(nextValue ?? draftRef.current)
    },
    [onSubmit]
  )
  const closeWithCancel = useCallback((): void => {
    if (editClosedRef.current) return
    editClosedRef.current = true
    onCancel()
  }, [onCancel])

  // Seed the draft when edit mode opens. Once the user is typing, keep
  // incoming chat updates from clobbering the in-progress rename.
  useEffect(() => {
    if (!isEditing) {
      wasEditingRef.current = false
      editClosedRef.current = true
      return
    }
    if (wasEditingRef.current) return
    wasEditingRef.current = true
    editClosedRef.current = false
    draftRef.current = chat.title
    setDraft(chat.title)
  }, [isEditing, chat.appChatId, chat.title])

  useEffect(() => {
    if (!isEditing) return
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isEditing, chat.appChatId])

  if (isEditing) {
    return (
      <span className={className}>
        <input
          ref={inputRef}
          autoFocus
          className="sidebar-chat-title-input"
          value={draft}
          onChange={(event) => {
            draftRef.current = event.target.value
            setDraft(event.target.value)
          }}
          onBlur={(event) => closeWithSubmit(event.currentTarget.value)}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              event.stopPropagation()
              closeWithSubmit(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeWithCancel()
            }
          }}
          aria-label="Rename chat"
        />
      </span>
    )
  }

  // Content-only search hint: when the query matched a message body but
  // not the title, the title highlight is empty and the user can't tell
  // why the row surfaced. Show a small "in conversation" snippet so the
  // match is honest. Skipped entirely when the title already matches.
  const contentSnippet = getChatContentMatchSnippet(chat, query)

  return (
    <span
      className={className}
      onDoubleClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onStartEdit()
      }}
    >
      <HighlightMatch text={chat.title} query={query} />
      {contentSnippet && (
        <span className="sidebar-chat-subline sidebar-search-content-match">
          <span
            className="sidebar-run-status tone-muted"
            title={`Match in conversation: ${contentSnippet}`}
          >
            <HighlightMatch text={contentSnippet} query={query} />
          </span>
        </span>
      )}
    </span>
  )
}

/**
 * When a search hits a chat's message body but NOT its title, the title
 * highlight stays empty and the row gives no clue why it matched. This
 * returns a short snippet of the first matching message (centered on the
 * match) so the tile can surface a "found in conversation" hint. Returns
 * null when there's no query, the title already covers the match, or no
 * message body contains the term — in those cases the existing title
 * highlight is enough.
 */
export function getChatContentMatchSnippet(chat: ChatRecord, query: string): string | null {
  if (!query) return null
  if (chat.title.toLowerCase().includes(query)) return null
  const summaryPreview = (chat as Partial<ChatListItem>).searchPreview
  if (summaryPreview && summaryPreview.toLowerCase().includes(query)) {
    return summaryPreview
  }
  for (const message of chat.messages || []) {
    if (message.metadata?.kind === 'channelInbound') continue
    const content = message.content || ''
    const matchIndex = content.toLowerCase().indexOf(query)
    if (matchIndex < 0) continue
    const radius = 24
    const start = Math.max(0, matchIndex - radius)
    const end = Math.min(content.length, matchIndex + query.length + radius)
    const snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`
  }
  return null
}
