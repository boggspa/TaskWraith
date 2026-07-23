import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement
} from 'react'
import { createPortal } from 'react-dom'
import type {
  BlackboardEntry,
  ChatRecord,
  ComposerStyle,
  ProviderId
} from '../../../main/store/types'
import { resolveComposerSurfacePopoverPosition } from '../lib/composerSurfacePopover'
import {
  BLACKBOARD_CATEGORY_LABELS,
  BLACKBOARD_CATEGORY_ORDER,
  BlackboardGroupedList,
  buildBlackboardGroups
} from './BlackboardEntryCard'

/**
 * Quick-access Blackboard popover — a satellite icon button in the composer's
 * telemetry icon row. Clicking it opens a small frosted popover (the same
 * `.composer-combined-picker-popover` chrome the Multiview / model / context
 * pickers in this row use) that lets you post to and scroll the ensemble
 * Blackboard without opening the right-dock "Notes" pane. The "seen by" rail
 * stays in the full panel; entry deletion is available in both surfaces.
 * Entries render through the shared BlackboardEntryCard so the popover and
 * panel stay visually in lockstep (provider-hued author chips included).
 */

export { buildBlackboardGroups }

export const BLACKBOARD_POST_SECTION_OPTIONS = BLACKBOARD_CATEGORY_ORDER.map((category) => ({
  category,
  label: BLACKBOARD_CATEGORY_LABELS[category]
}))

/** Standing chalkboard glyph (easel legs + two chalk lines) — matches the
 * 16×16 / stroke-1.3 family used by the sibling composer-control icons. */
function BlackboardSymbolIcon(): ReactElement {
  return (
    <span className="composer-control-icon">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2.3" y="2.5" width="11.4" height="8" rx="1.4" />
        <path d="M4.9 5.4h6.2" />
        <path d="M4.9 7.7h4.1" />
        <path d="M4.2 10.5 3.3 13.3" />
        <path d="m11.8 10.5.9 2.8" />
      </svg>
    </span>
  )
}

function TrashMiniIcon(): ReactElement {
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

export interface ComposerBlackboardButtonProps {
  chat: ChatRecord | null
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
}

interface ComposerBlackboardPostFormProps {
  chat: ChatRecord | null
  disabled?: boolean
}

interface ComposerBlackboardDeleteButtonProps {
  entry: BlackboardEntry
  deletingEntryId: string | null
  clearingAll?: boolean
  onDelete: (entry: BlackboardEntry) => void
}

export function ComposerBlackboardDeleteButton(
  props: ComposerBlackboardDeleteButtonProps
): ReactElement {
  const deleting = props.deletingEntryId === props.entry.id
  return (
    <button
      type="button"
      className="pinned-blackboard-entry-delete"
      onClick={() => props.onDelete(props.entry)}
      disabled={props.deletingEntryId !== null || props.clearingAll}
      title={deleting ? 'Deleting...' : 'Delete blackboard entry'}
      aria-label={`Delete blackboard entry ${props.entry.key}`}
    >
      <TrashMiniIcon />
    </button>
  )
}

export function ComposerBlackboardPostForm(
  props: ComposerBlackboardPostFormProps
): ReactElement | null {
  const [draft, setDraft] = useState('')
  const [category, setCategory] = useState<BlackboardEntry['category']>('note')
  const [posting, setPosting] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)
  const chatId = props.chat?.appChatId
  const canPost = Boolean(chatId && props.chat?.ensemble && !props.disabled)
  const draftValue = draft.trim()

  const submitPost = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!chatId || !canPost || !draftValue || posting) return
    setPosting(true)
    setPostError(null)
    try {
      await window.api.postBlackboardEntry({
        chatId,
        value: draftValue,
        category,
        scope: 'session'
      })
      setDraft('')
    } catch (error) {
      setPostError(error instanceof Error ? error.message : String(error))
    } finally {
      setPosting(false)
    }
  }

  if (!canPost) return null

  return (
    <form
      className="composer-blackboard-compose"
      aria-label="Post to Blackboard"
      onSubmit={submitPost}
    >
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          if (postError) setPostError(null)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
          event.preventDefault()
          event.currentTarget.form?.requestSubmit()
        }}
        aria-label="Blackboard entry"
        placeholder="Post a note to the Blackboard..."
        rows={4}
      />
      <label className="composer-blackboard-post-section">
        <span>Post to</span>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as BlackboardEntry['category'])}
          aria-label="Blackboard section"
        >
          {BLACKBOARD_POST_SECTION_OPTIONS.map((option) => (
            <option key={option.category} value={option.category}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={!draftValue || posting}>
        {posting ? 'Posting' : 'Post'}
      </button>
      {postError && (
        <small className="composer-blackboard-post-error" role="alert">
          {postError}
        </small>
      )}
    </form>
  )
}

export function ComposerBlackboardButton(props: ComposerBlackboardButtonProps): ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null)
  const [clearingAll, setClearingAll] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number; width: number } | null>(
    null
  )

  const entries = useMemo(
    () => props.chat?.ensemble?.blackboard ?? [],
    [props.chat?.ensemble?.blackboard]
  )
  const groups = useMemo(() => buildBlackboardGroups(entries), [entries])
  const entryCount = useMemo(
    () => groups.reduce((total, group) => total + group.entries.length, 0),
    [groups]
  )
  const canDelete = Boolean(props.chat?.appChatId && props.chat?.ensemble && !props.disabled)

  const deleteEntry = async (entry: BlackboardEntry): Promise<void> => {
    const chatId = props.chat?.appChatId
    if (!chatId || !canDelete || deletingEntryId || clearingAll) return
    const confirmed = window.confirm(`Delete "${entry.key}" from the Blackboard?`)
    if (!confirmed) return
    setDeletingEntryId(entry.id)
    setDeleteError(null)
    try {
      await window.api.deleteBlackboardEntry({ chatId, entryId: entry.id })
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error))
    } finally {
      setDeletingEntryId(null)
    }
  }

  const clearAllEntries = async (): Promise<void> => {
    const chatId = props.chat?.appChatId
    if (!chatId || !canDelete || entryCount === 0 || deletingEntryId || clearingAll) return
    const confirmed = window.confirm(
      `Delete all ${entryCount} Blackboard ${entryCount === 1 ? 'entry' : 'entries'}? This cannot be undone.`
    )
    if (!confirmed) return
    setClearingAll(true)
    setDeleteError(null)
    try {
      await window.api.clearBlackboardEntries({ chatId })
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error))
    } finally {
      setClearingAll(false)
    }
  }

  const updatePosition = useCallback((): void => {
    if (typeof window === 'undefined') return
    const trigger = triggerRef.current
    if (!trigger) {
      setPosition(null)
      return
    }
    const triggerRect = trigger.getBoundingClientRect()
    const surface = trigger.closest('.composer-surface') as HTMLElement | null
    const surfaceRect = surface?.getBoundingClientRect() ?? triggerRect
    setPosition(
      resolveComposerSurfacePopoverPosition({
        triggerRect,
        surfaceRect,
        viewportWidth: window.innerWidth
      })
    )
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) updatePosition()
    })
    const handleReposition = (): void => updatePosition()
    window.addEventListener('scroll', handleReposition, true)
    window.addEventListener('resize', handleReposition)
    return () => {
      cancelled = true
      window.removeEventListener('scroll', handleReposition, true)
      window.removeEventListener('resize', handleReposition)
    }
  }, [open, updatePosition])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [open])

  const popover =
    open && position && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className={`composer-combined-picker-popover composer-blackboard-popover provider-${props.provider} shell-${props.composerStyle}`}
            style={{
              position: 'fixed',
              left: `${position.left}px`,
              top: `${position.top}px`,
              width: `${position.width}px`,
              maxWidth: 'calc(100vw - 16px)',
              transform: 'translateY(-100%)'
            }}
            role="dialog"
            aria-label="Blackboard"
          >
            <div className="composer-blackboard-popover-header">
              <span>Blackboard</span>
              {entryCount > 0 && (
                <span className="composer-blackboard-popover-count">{entryCount}</span>
              )}
              {canDelete && entryCount > 0 && (
                <button
                  type="button"
                  className="composer-blackboard-clear-all"
                  onClick={clearAllEntries}
                  disabled={deletingEntryId !== null || clearingAll}
                  title={clearingAll ? 'Deleting all entries...' : 'Delete all Blackboard entries'}
                >
                  {clearingAll ? 'Deleting...' : 'Delete all'}
                </button>
              )}
            </div>
            <ComposerBlackboardPostForm chat={props.chat} disabled={props.disabled} />
            {deleteError && (
              <small className="composer-blackboard-post-error" role="alert">
                {deleteError}
              </small>
            )}
            {entryCount === 0 ? (
              <div className="composer-blackboard-popover-empty">No blackboard entries yet.</div>
            ) : (
              <div className="composer-blackboard-list" role="list">
                <BlackboardGroupedList
                  chat={props.chat}
                  groups={groups}
                  variant="popover"
                  renderEntryActions={(entry) =>
                    canDelete ? (
                      <ComposerBlackboardDeleteButton
                        entry={entry}
                        deletingEntryId={deletingEntryId}
                        clearingAll={clearingAll}
                        onDelete={deleteEntry}
                      />
                    ) : null
                  }
                />
              </div>
            )}
          </div>,
          document.body
        )
      : null

  return (
    <>
      <button
        ref={triggerRef}
        className="composer-blackboard-trigger composer-hint-pill"
        type="button"
        aria-label="Blackboard"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        disabled={props.disabled}
        data-composer-control="blackboard"
        data-hint-label="Blackboard"
        title={entryCount > 0 ? `Blackboard — ${entryCount} entries` : 'Blackboard'}
      >
        <BlackboardSymbolIcon />
        {entryCount > 0 && <span className="composer-blackboard-trigger-dot" aria-hidden="true" />}
      </button>
      {popover}
    </>
  )
}
