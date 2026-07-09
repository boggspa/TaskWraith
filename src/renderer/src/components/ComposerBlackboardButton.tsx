import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
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
  sortBlackboardEntries
} from './PinnedMessagesPanel'
import { MarkdownMessage } from './MarkdownMessage'

/**
 * Quick-access Blackboard popover — a satellite icon button in the composer's
 * telemetry icon row. Clicking it opens a small frosted popover (the same
 * `.composer-combined-picker-popover` chrome the Multiview / model / context
 * pickers in this row use) that lets you scroll the ensemble Blackboard
 * READ-ONLY, without opening the right-dock "Notes" pane. Posting, deleting,
 * and the "seen by" rail stay in the full panel — this is a glance surface.
 */

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

export interface ComposerBlackboardButtonProps {
  chat: ChatRecord | null
  provider: ProviderId
  composerStyle: ComposerStyle
  disabled?: boolean
}

/** Read-only, category-grouped view of the chat's Blackboard entries. Mirrors
 * the panel's ordering/labelling (shared helpers) but drops the author/seen-by
 * chrome to stay a quick glance. */
export function buildBlackboardGroups(
  entries: BlackboardEntry[]
): Array<{ category: BlackboardEntry['category']; entries: BlackboardEntry[] }> {
  const visible = entries
    .filter((entry) => entry.key.trim() && entry.value.trim())
    .sort(sortBlackboardEntries)
  return BLACKBOARD_CATEGORY_ORDER.map((category) => ({
    category,
    entries: visible.filter((entry) => entry.category === category)
  })).filter((group) => group.entries.length > 0)
}

export function ComposerBlackboardButton(props: ComposerBlackboardButtonProps): ReactElement {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
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
            </div>
            {entryCount === 0 ? (
              <div className="composer-blackboard-popover-empty">No blackboard entries yet.</div>
            ) : (
              <div className="composer-blackboard-list" role="list">
                {groups.map((group) => (
                  <div key={group.category} className="composer-blackboard-group">
                    <div className="composer-blackboard-category">
                      {BLACKBOARD_CATEGORY_LABELS[group.category]}
                    </div>
                    {group.entries.map((entry) => (
                      <article
                        key={entry.id}
                        role="listitem"
                        className={`composer-blackboard-entry category-${entry.category}`}
                      >
                        <div className="composer-blackboard-entry-meta">
                          <strong>{entry.key}</strong>
                          <span className="composer-blackboard-entry-scope">{entry.scope}</span>
                        </div>
                        <div className="composer-blackboard-entry-body">
                          <MarkdownMessage content={entry.value} chat={props.chat || undefined} />
                        </div>
                        {entry.participantId && (
                          <div className="composer-blackboard-entry-author">
                            {entry.participantId}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                ))}
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
